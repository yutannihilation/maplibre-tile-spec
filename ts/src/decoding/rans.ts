import IntWrapper from "./intWrapper";
import { readVarint32 } from "./v2/bytes02";

/**
 * rANS over componentwise vertex deltas (`docs/encodings.md#rans`): each delta is a symbol coded
 * with a table picked by its context, plus the delta's low raw bits stored as they are. Four
 * lanes decode in parallel; even vertices use lanes 0 and 1, odd vertices lanes 2 and 3.
 *
 * The reference is `codecs/rans.rs` in mlt-core. This is the plain form of it: one lookup table
 * per context, no block staging.
 */

const MAX_PRECISION = 11;
const MAX_DEPTH = 2;
/** Symbol `0` is a zero delta, the rest are two per (bit length, mantissa) code, up to `i32::MIN` at depth 2. */
const SYMBOLS = 257;
const X_CONTEXTS = 2;
const CLASSES = 6;
const CONTEXTS = X_CONTEXTS + 2 * CLASSES;
const LANES = 4;
const STATE_LOW = 1 << 16;
const MAX_GAMMA_ZEROS = MAX_PRECISION + 1;

/** What a symbol decodes to at a depth: its sign, the bits its raw part takes, and the bits above them. */
interface SymbolInfo {
    negative: boolean;
    rawBits: number;
    head: number;
}

/** [`SymbolInfo`] for every symbol at every depth, undefined where no delta maps to it. */
const INFO: (SymbolInfo | undefined)[][] = [];
for (let depth = 0; depth <= MAX_DEPTH; depth++) {
    const atDepth: (SymbolInfo | undefined)[] = new Array(SYMBOLS);
    for (let symbol = 0; symbol < SYMBOLS; symbol++) {
        atDepth[symbol] = symbolInfo(symbol, depth);
    }
    INFO.push(atDepth);
}

function symbolInfo(symbol: number, depth: number): SymbolInfo | undefined {
    if (symbol === 0) {
        return { negative: false, rawBits: 0, head: 0 };
    }
    const code = Math.ceil(symbol / 2);
    const len = code >> depth;
    if (len < 1 || len > 32) {
        return undefined;
    }
    const kept = Math.min(len - 1, depth);
    const mantissa = code & ((1 << depth) - 1);
    if ((mantissa & ((1 << (depth - kept)) - 1)) !== 0) {
        return undefined;
    }
    const negative = symbol % 2 === 0;
    // Only i32::MIN has a 32-bit magnitude, and it is negative with no mantissa bits.
    if (len === 32 && (!negative || mantissa !== 0)) {
        return undefined;
    }
    return { negative, rawBits: len - 1 - kept, head: (1 << kept) | (mantissa >> (depth - kept)) };
}

/** The dy context class of a dx symbol: the bit length of dx's magnitude, capped. */
function dyClass(symbol: number, depth: number): number {
    return Math.min(Math.ceil(symbol / 2) >> depth, CLASSES - 1);
}

/** A context's table as slot lookups: the symbol owning each slot, and where each symbol's slots start. */
interface Table {
    precision: number;
    slotSymbol: Uint16Array;
    freq: Uint32Array;
    cumulative: Uint32Array;
}

class BitReader {
    bit = 0;

    constructor(private readonly bytes: Uint8Array) {}

    /** Up to 25 bits from the current position, zero past the end. */
    private peek(count: number): number {
        const byte = this.bit >> 3;
        const offset = this.bit & 7;
        let acc = 0;
        for (let k = 0; k < 4; k++) {
            if (byte + k < this.bytes.length) {
                acc |= this.bytes[byte + k] << (8 * k);
            }
        }
        return ((acc >>> offset) & ((1 << count) - 1)) >>> 0;
    }

    /** Up to 25 bits. */
    get(count: number): number {
        const value = this.peek(count);
        this.bit += count;
        return value;
    }

    /** Up to 32 bits, as a non-negative number. */
    getWide(count: number): number {
        if (count <= 24) {
            return this.get(count);
        }
        const low = this.get(16);
        return low + this.get(count - 16) * 65536;
    }

    /** Elias gamma, LSB-first: `z` zero bits, a one bit, then the low `z` bits of the value. */
    gamma(): number {
        let zeros = 0;
        while (this.peek(1) === 0) {
            zeros++;
            this.bit++;
            if (zeros > MAX_GAMMA_ZEROS) {
                throw new Error("rANS vertex stream is malformed: frequency out of range");
            }
        }
        this.bit++;
        return (1 << zeros) | this.get(zeros);
    }

    overran(): boolean {
        return this.bit > this.bytes.length * 8;
    }
}

function readTable(r: BitReader, depth: number): Table {
    const precision = r.get(4);
    const max = r.get(9);
    if (precision > MAX_PRECISION || max >= SYMBOLS) {
        throw new Error("rANS vertex stream is malformed: table out of range");
    }
    const freq = new Uint32Array(max + 1);
    if (precision === 0) {
        freq[max] = 1;
    } else {
        for (let s = 0; s <= max; s++) {
            freq[s] = r.gamma() - 1;
        }
    }
    let sum = 0;
    for (let s = 0; s <= max; s++) {
        sum += freq[s];
        if (freq[s] > 0 && INFO[depth][s] === undefined) {
            throw new Error("rANS vertex stream is malformed: table frequencies");
        }
    }
    if (sum !== 1 << precision || freq[max] === 0) {
        throw new Error("rANS vertex stream is malformed: table frequencies");
    }
    const cumulative = new Uint32Array(max + 1);
    const slotSymbol = new Uint16Array(1 << precision);
    let at = 0;
    for (let s = 0; s <= max; s++) {
        cumulative[s] = at;
        slotSymbol.fill(s, at, at + freq[s]);
        at += freq[s];
    }
    return { precision, slotSymbol, freq, cumulative };
}

class Lane {
    state: number;
    pos = 4;

    constructor(private readonly bytes: Uint8Array) {
        this.state = (bytes[0] | (bytes[1] << 8) | (bytes[2] << 16) | (bytes[3] << 24)) >>> 0;
    }

    /** Decodes one symbol from `table`, shifting a refill word in when the state drops below 2^16. */
    step(table: Table): number {
        const slot = this.state & ((1 << table.precision) - 1);
        const symbol = table.slotSymbol[slot];
        this.state =
            (Math.imul(table.freq[symbol], this.state >>> table.precision) + slot - table.cumulative[symbol]) >>> 0;
        if (this.state < STATE_LOW) {
            if (this.pos + 2 > this.bytes.length) {
                throw new Error("rANS vertex stream is malformed: lane refills past its words");
            }
            this.state = ((this.state << 16) | this.bytes[this.pos] | (this.bytes[this.pos + 1] << 8)) >>> 0;
            this.pos += 2;
        }
        return symbol;
    }

    finished(): boolean {
        return this.state === STATE_LOW && this.pos === this.bytes.length;
    }
}

/**
 * Decodes `vertexCount` `(x, y)` pairs from a rANS payload. A run starts at each of `runOffsets`,
 * which start at 0 and end at the vertex count, or at every vertex when there are none.
 */
export function decodeRansVertices(
    payload: Uint8Array,
    runOffsets: Uint32Array | undefined,
    vertexCount: number,
): Int32Array {
    if (payload.length === 0) {
        throw new Error("rANS vertex stream is malformed: empty");
    }
    const depth = payload[0];
    if (depth > MAX_DEPTH) {
        throw new Error("rANS vertex stream is malformed: depth");
    }
    const rest = payload.subarray(1);
    const starts = runStarts(runOffsets, vertexCount);

    const r = new BitReader(rest);
    const tables: (Table | undefined)[] = [];
    for (let c = 0; c < CONTEXTS; c++) {
        tables.push(r.get(1) === 1 ? readTable(r, depth) : undefined);
        if (r.overran()) {
            throw new Error("rANS vertex stream is malformed: tables truncated");
        }
    }

    const pos = new IntWrapper(Math.ceil(r.bit / 8));
    const lengths: number[] = [];
    for (let l = 0; l < LANES; l++) {
        lengths.push(readVarint32(rest, pos, "rANS lane length"));
    }
    const lanes: Lane[] = [];
    for (const length of lengths) {
        if (length < 4 || length % 2 !== 0) {
            throw new Error("rANS vertex stream is malformed: lane length");
        }
        if (pos.get() + length > rest.length) {
            throw new Error("rANS vertex stream is malformed: lanes truncated");
        }
        lanes.push(new Lane(rest.subarray(pos.get(), pos.get() + length)));
        pos.add(length);
    }
    const raw = new BitReader(rest.subarray(pos.get()));
    const rawLength = rest.length - pos.get();

    const out = new Int32Array(vertexCount * 2);
    const info = INFO[depth];
    let x = 0;
    let y = 0;
    for (let i = 0; i < vertexCount; i++) {
        const start = starts[i];
        const laneX = lanes[2 * (i % 2)];
        const laneY = lanes[2 * (i % 2) + 1];
        const tableX = tables[start];
        if (tableX === undefined) {
            throw new Error("rANS vertex stream is malformed: symbol from a missing table");
        }
        const sx = laneX.step(tableX);
        const tableY = tables[X_CONTEXTS + 2 * dyClass(sx, depth) + start];
        if (tableY === undefined) {
            throw new Error("rANS vertex stream is malformed: symbol from a missing table");
        }
        const sy = laneY.step(tableY);
        x = (x + delta(info[sx], raw)) | 0;
        y = (y + delta(info[sy], raw)) | 0;
        out[2 * i] = x;
        out[2 * i + 1] = y;
    }
    if (Math.ceil(raw.bit / 8) !== rawLength) {
        throw new Error("rANS vertex stream is malformed: raw bits length");
    }
    if (!lanes.every((lane) => lane.finished())) {
        throw new Error("rANS vertex stream is malformed: lanes do not end in the initial state");
    }
    return out;
}

/** The delta a symbol names, completed from the raw bits. */
function delta(e: SymbolInfo, raw: BitReader): number {
    const low = e.rawBits === 0 ? 0 : raw.getWide(e.rawBits);
    // The magnitude can be 2^31, which only i32::MIN has; `| 0` wraps it there.
    const magnitude = (e.head * 2 ** e.rawBits + low) | 0;
    return e.negative ? -magnitude | 0 : magnitude;
}

/** One flag per vertex, 1 at each run offset, or at every vertex without offsets. */
function runStarts(offsets: Uint32Array | undefined, vertexCount: number): Uint8Array {
    const starts = new Uint8Array(vertexCount);
    if (offsets === undefined) {
        starts.fill(1);
        return starts;
    }
    if (offsets.length === 0 || offsets[0] !== 0 || offsets[offsets.length - 1] !== vertexCount) {
        throw new Error("rANS vertex stream is malformed: runs do not cover the vertices");
    }
    for (let i = 0; i < offsets.length; i++) {
        const o = offsets[i];
        if (o < vertexCount) {
            starts[o] = 1;
        } else if (o !== vertexCount) {
            throw new Error("rANS vertex stream is malformed: runs do not cover the vertices");
        }
    }
    return starts;
}
