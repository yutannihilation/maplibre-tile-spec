import type IntWrapper from "../intWrapper";
import { decodeUint32sLE, decodeUint64sLE } from "../decodingUtils";
import { decodeZigZagInt32Value, decodeZigZagInt64Value } from "../integerDecodingUtils";
import { decodeZigZagDelta2Int32, decodeZigZagDelta2Int64 } from "../delta2";
import type { StreamHeader02 } from "./streamHeader02";

/**
 * Decodes the payload of a v2 integer stream: the physical words, then the logical transform.
 *
 * The reference is `decoder/stream/{decode,logical}.rs` in mlt-core. A signed stream zigzag-decodes
 * its words; an unsigned one takes them as they are. Delta and Delta2 words are zigzag deltas on
 * either, with running sums that wrap at the word width. RLE words are `(run, value)` pairs, read
 * until the payload ends, and expand before the zigzag or delta step.
 */

export type IntValues02 = Int32Array | Uint32Array | BigInt64Array | BigUint64Array;

/** Reads `numWords` 32-bit words of the stream's physical encoding, leaving `offset` after the payload. */
export function readWords32(
    tile: Uint8Array,
    offset: IntWrapper,
    header: StreamHeader02,
    numWords: number,
): Uint32Array {
    const end = payloadEnd(tile, offset, header);
    let words: Uint32Array;
    switch (header.physical) {
        case "none":
            expectByteLength(header, numWords * 4);
            words = decodeUint32sLE(tile, offset, numWords);
            break;
        case "varint":
            words = readVarints32(tile, offset, numWords, end);
            break;
        default:
            throw notSupported(header);
    }
    expectConsumed(offset, end, header);
    return words;
}

/** Reads `numWords` 64-bit words of the stream's physical encoding, leaving `offset` after the payload. */
export function readWords64(
    tile: Uint8Array,
    offset: IntWrapper,
    header: StreamHeader02,
    numWords: number,
): BigUint64Array {
    const end = payloadEnd(tile, offset, header);
    let words: BigUint64Array;
    switch (header.physical) {
        case "none":
            expectByteLength(header, numWords * 8);
            words = decodeUint64sLE(tile, offset, numWords);
            break;
        case "varint":
            words = readVarints64(tile, offset, numWords, end);
            break;
        default:
            throw notSupported(header);
    }
    expectConsumed(offset, end, header);
    return words;
}

/**
 * Decodes a single-word-per-value integer stream to its values.
 *
 * `header.family` picks the word width (`int64` is 64-bit, `int32` and `str` are 32-bit), and
 * `signed` whether the values zigzag-decode. The result is a typed array of that width and sign.
 */
export function decodeIntStream02(
    tile: Uint8Array,
    offset: IntWrapper,
    header: StreamHeader02,
    signed: boolean,
): IntValues02 {
    const wide = header.family === "int64";
    const numValues = header.numValues;
    switch (header.logical) {
        case "none": {
            if (wide) {
                const words = readWords64(tile, offset, header, numValues);
                return signed ? zigZag64(words) : words;
            }
            const words = readWords32(tile, offset, header, numValues);
            return signed ? zigZag32(words) : words;
        }
        case "delta": {
            if (wide) {
                const deltas = zigZagDelta64(readWords64(tile, offset, header, numValues));
                return signed ? deltas : new BigUint64Array(deltas.buffer);
            }
            const deltas = zigZagDelta32(readWords32(tile, offset, header, numValues));
            return signed ? deltas : new Uint32Array(deltas.buffer);
        }
        case "delta2": {
            if (wide) {
                const values = decodeZigZagDelta2Int64(readWords64(tile, offset, header, numValues));
                return signed ? values : new BigUint64Array(values.buffer);
            }
            const values = decodeZigZagDelta2Int32(readWords32(tile, offset, header, numValues));
            return signed ? values : new Uint32Array(values.buffer);
        }
        case "rle": {
            if (wide) {
                const words = expandRle64(readRlePairs64(tile, offset, header), numValues);
                return signed ? zigZag64(words) : words;
            }
            const words = expandRle32(readRlePairs32(tile, offset, header), numValues);
            return signed ? zigZag32(words) : words;
        }
        case "deltaRle": {
            if (wide) {
                const deltas = zigZagDelta64(expandRle64(readRlePairs64(tile, offset, header), numValues));
                return signed ? deltas : new BigUint64Array(deltas.buffer);
            }
            const deltas = zigZagDelta32(expandRle32(readRlePairs32(tile, offset, header), numValues));
            return signed ? deltas : new Uint32Array(deltas.buffer);
        }
        default:
            throw notSupported(header);
    }
}

function notSupported(header: StreamHeader02): Error {
    return new Error(`v2 ${header.logical} over ${header.physical} is not supported by this decoder yet`);
}

/** Where the payload ends, which the header always fixes for an integer stream. */
function payloadEnd(tile: Uint8Array, offset: IntWrapper, header: StreamHeader02): number {
    if (header.byteLength === undefined) {
        throw new Error(`A ${header.family} stream has no byte length to read integer words from`);
    }
    const end = offset.get() + header.byteLength;
    if (end > tile.length) {
        throw new Error(`Stream payload overruns the tile: ${end} > ${tile.length}`);
    }
    return end;
}

function expectByteLength(header: StreamHeader02, expected: number): void {
    if (header.byteLength !== expected) {
        throw new Error(`Stream byte length ${header.byteLength} does not match its ${expected} bytes of raw words`);
    }
}

function expectConsumed(offset: IntWrapper, end: number, header: StreamHeader02): void {
    if (offset.get() !== end) {
        throw new Error(`${end - offset.get()} bytes left over after the ${header.logical} stream's words`);
    }
}

/** Zigzag varints, canonical: a multi-byte varint must not end in a zero byte. */
function readVarints32(tile: Uint8Array, offset: IntWrapper, numWords: number, end: number): Uint32Array {
    const words = new Uint32Array(numWords);
    let pos = offset.get();
    for (let i = 0; i < numWords; i++) {
        let value = 0;
        let shift = 0;
        const start = pos;
        for (;;) {
            if (pos >= end) {
                throw new Error(`Varint overruns the stream payload at byte ${pos}`);
            }
            const b = tile[pos++];
            if (shift === 28 && b > 0x0f) {
                throw new Error(`Varint longer than 32 bits at byte ${start}`);
            }
            value |= (b & 0x7f) << shift;
            if (b < 0x80) {
                if (b === 0 && pos - start > 1) {
                    throw new Error(`Non-canonical varint at byte ${start}`);
                }
                break;
            }
            shift += 7;
        }
        words[i] = value >>> 0;
    }
    offset.set(pos);
    return words;
}

function readVarints64(tile: Uint8Array, offset: IntWrapper, numWords: number, end: number): BigUint64Array {
    const words = new BigUint64Array(numWords);
    let pos = offset.get();
    for (let i = 0; i < numWords; i++) {
        let value = 0n;
        let shift = 0n;
        const start = pos;
        for (;;) {
            if (pos >= end) {
                throw new Error(`Varint overruns the stream payload at byte ${pos}`);
            }
            const b = tile[pos++];
            if (shift === 63n && b > 0x01) {
                throw new Error(`Varint longer than 64 bits at byte ${start}`);
            }
            value |= BigInt(b & 0x7f) << shift;
            if (b < 0x80) {
                if (b === 0 && pos - start > 1) {
                    throw new Error(`Non-canonical varint at byte ${start}`);
                }
                break;
            }
            shift += 7n;
        }
        words[i] = value;
    }
    offset.set(pos);
    return words;
}

/** The `(run, value)` pairs of an RLE payload, whose count only the byte length gives. */
function readRlePairs32(tile: Uint8Array, offset: IntWrapper, header: StreamHeader02): Uint32Array {
    const end = payloadEnd(tile, offset, header);
    if (header.physical !== "implied") {
        throw notSupported(header);
    }
    const pairs = scanVarints32(tile, offset, end);
    if (pairs.length % 2 !== 0) {
        throw new Error(`RLE stream holds ${pairs.length} words, which is not whole (run, value) pairs`);
    }
    return Uint32Array.from(pairs);
}

function readRlePairs64(tile: Uint8Array, offset: IntWrapper, header: StreamHeader02): BigUint64Array {
    const end = payloadEnd(tile, offset, header);
    if (header.physical !== "implied") {
        throw notSupported(header);
    }
    const pairs: bigint[] = [];
    while (offset.get() < end) {
        pairs.push(readVarints64(tile, offset, 1, end)[0]);
    }
    if (pairs.length % 2 !== 0) {
        throw new Error(`RLE stream holds ${pairs.length} words, which is not whole (run, value) pairs`);
    }
    return BigUint64Array.from(pairs);
}

/** Every varint up to `end`, for a payload whose word count only its byte length gives. */
function scanVarints32(tile: Uint8Array, offset: IntWrapper, end: number): number[] {
    const words: number[] = [];
    let pos = offset.get();
    while (pos < end) {
        let value = 0;
        let shift = 0;
        const start = pos;
        for (;;) {
            if (pos >= end) {
                throw new Error(`Varint overruns the stream payload at byte ${pos}`);
            }
            const b = tile[pos++];
            if (shift === 28 && b > 0x0f) {
                throw new Error(`Varint longer than 32 bits at byte ${start}`);
            }
            value |= (b & 0x7f) << shift;
            if (b < 0x80) {
                if (b === 0 && pos - start > 1) {
                    throw new Error(`Non-canonical varint at byte ${start}`);
                }
                break;
            }
            shift += 7;
        }
        words.push(value >>> 0);
    }
    offset.set(pos);
    return words;
}

function expandRle32(pairs: Uint32Array, numValues: number): Uint32Array {
    const values = new Uint32Array(numValues);
    let pos = 0;
    for (let i = 0; i < pairs.length; i += 2) {
        const run = pairs[i];
        if (run > numValues - pos) {
            throw new Error(`RLE run of ${run} values overruns the stream's ${numValues}`);
        }
        values.fill(pairs[i + 1], pos, pos + run);
        pos += run;
    }
    if (pos !== numValues) {
        throw new Error(`RLE runs sum to ${pos} values, not the stream's ${numValues}`);
    }
    return values;
}

function expandRle64(pairs: BigUint64Array, numValues: number): BigUint64Array {
    const values = new BigUint64Array(numValues);
    let pos = 0;
    for (let i = 0; i < pairs.length; i += 2) {
        const run = pairs[i];
        if (run > BigInt(numValues - pos)) {
            throw new Error(`RLE run of ${run} values overruns the stream's ${numValues}`);
        }
        const count = Number(run);
        values.fill(pairs[i + 1], pos, pos + count);
        pos += count;
    }
    if (pos !== numValues) {
        throw new Error(`RLE runs sum to ${pos} values, not the stream's ${numValues}`);
    }
    return values;
}

/** Prefix sum of zigzag deltas from zero, wrapping at 32 bits. */
function zigZagDelta32(words: Uint32Array): Int32Array {
    const values = new Int32Array(words.length);
    let value = 0;
    for (let i = 0; i < words.length; i++) {
        value = (value + decodeZigZagInt32Value(words[i])) | 0;
        values[i] = value;
    }
    return values;
}

function zigZagDelta64(words: BigUint64Array): BigInt64Array {
    const values = new BigInt64Array(words.length);
    let value = 0n;
    for (let i = 0; i < words.length; i++) {
        value = BigInt.asIntN(64, value + decodeZigZagInt64Value(words[i]));
        values[i] = value;
    }
    return values;
}

function zigZag32(words: Uint32Array): Int32Array {
    const values = new Int32Array(words.length);
    for (let i = 0; i < words.length; i++) {
        values[i] = decodeZigZagInt32Value(words[i]);
    }
    return values;
}

function zigZag64(words: BigUint64Array): BigInt64Array {
    const values = new BigInt64Array(words.length);
    for (let i = 0; i < words.length; i++) {
        values[i] = decodeZigZagInt64Value(words[i]);
    }
    return values;
}
