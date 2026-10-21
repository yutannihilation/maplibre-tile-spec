import type IntWrapper from "../intWrapper";
import { decodeZigZagInt64Value } from "../integerDecodingUtils";

/**
 * The v2 stream header, as `docs/specification/v2.md#streams` lays it out:
 *
 * ```text
 * [u8 encoding_byte]      bit 7 explicit count, bits 6-4 logical, bits 3-2 physical, bits 1-0 extension
 * [varint num_values]     only with bit 7
 * [varint byte_length]    unless a bool stream, or logical None over physical 00
 * [parameters]            ALP scale + base, Morton bits + shift, z step
 * ```
 *
 * What the fields mean depends on the stream's family, which the caller knows from the stream's
 * position. The reference is `rust/mlt-core/src/decoder/stream/header02.rs`.
 */

/** What a stream holds, which fixes how its encoding byte reads and how wide its raw words are. */
export type Family02 = "int32" | "int64" | "bool" | "float32" | "float64" | "vertex" | "str" | "bytes";

/** The canonical names of every logical encoding a v2 stream can name. */
export type Logical02 =
    | "none"
    | "delta"
    | "cwDelta"
    | "rle"
    | "deltaRle"
    | "morton"
    | "alp"
    | "dict"
    | "frontCoded"
    | "bitPacked"
    | "delta2"
    | "cwDelta2"
    | "rans"
    | "bitmap"
    | "runs"
    | "sparse";

/**
 * How the words of the payload are stored. `implied` is for encodings that define their own
 * layout (RLE pairs, bit packing, rANS, the bool codings, byte blobs) and reserve the field as 0.
 */
export type Physical02 = "none" | "varint" | "fastPfor" | "implied";

/** How a string column lays its streams out, named by the extension bits of its leading stream. */
export type StrLayout02 = "plain" | "dict" | "fsst" | "fsstDict";

export interface AlpParams02 {
    /** Decimal exponent the values were scaled by, 0-18. */
    e: number;
    /** Factor dividing out the trailing zeros `e` introduced, 0-`e`. */
    f: number;
    /** Frame of reference: the smallest scaled integer in the column. */
    base: bigint;
}

export interface MortonParams02 {
    bits: number;
    shift: number;
}

export interface StreamHeader02 {
    family: Family02;
    logical: Logical02;
    physical: Physical02;
    explicitCount: boolean;
    /** Elements: vertices for a vertex stream, bytes for a blob, bits for a bool stream. */
    numValues: number;
    /** Payload bytes. Undefined for a bool stream, whose payload delimits itself. */
    byteLength: number | undefined;
    /** 32-bit words per element: 3 for `(x, y, z)`, 2 for `(x, y)`, otherwise 1. */
    wordsPerValue: 1 | 2 | 3;
    /** The layout a string column's leading stream names. */
    strLayout?: StrLayout02;
    /** The z exponent (-3 to 4) of a vertex stream of triples. */
    zStep?: number;
    alp?: AlpParams02;
    morton?: MortonParams02;
}

const HAS_EXPLICIT_COUNT = 0b1000_0000;
const LOGICAL_MASK = 0b0111_0000;
const LOGICAL_SHIFT = 4;
const PHYSICAL_MASK = 0b0000_1100;
const EXTENSION_MASK = 0b0000_0011;
const XYZ = 0b0000_0001;

const PHYSICAL_NO_LEN = 0b00;
const PHYSICAL_NONE = 0b01;
const PHYSICAL_VARINT = 0b10;
const PHYSICAL_FASTPFOR = 0b11;

const Z_STEP_MIN = -3;
const Z_STEP_MAX = 4;
const ALP_MAX_EXPONENT = 18;
const MORTON_MAX_BITS = 16;

const INT_MEMBERS: readonly Logical02[] = ["none", "delta", "rle", "deltaRle", "bitPacked", "delta2"];
const BOOL_MEMBERS: readonly Logical02[] = ["bitmap", "runs", "sparse"];
/** Code 1 is unassigned: the reference encoder never writes RLE over floats. */
const FLOAT_MEMBERS: readonly (Logical02 | undefined)[] = ["none", undefined, "alp", "dict"];
const VERTEX_MEMBERS: readonly Logical02[] = ["none", "delta", "cwDelta", "morton", "cwDelta2", "rans"];
const BYTES_MEMBERS: readonly Logical02[] = ["none", "frontCoded"];

function members(family: Family02): readonly (Logical02 | undefined)[] {
    switch (family) {
        case "int32":
        case "int64":
        case "str":
            return INT_MEMBERS;
        case "bool":
            return BOOL_MEMBERS;
        case "float32":
        case "float64":
            return FLOAT_MEMBERS;
        case "vertex":
            return VERTEX_MEMBERS;
        case "bytes":
            return BYTES_MEMBERS;
    }
}

/** Bytes per raw word, fixed by the family. */
function wordBytes(family: Family02): number {
    return family === "int64" || family === "float64" ? 8 : 4;
}

function reject(encByte: number, family: Family02, why: string): never {
    throw new Error(
        `Invalid v2 encoding byte 0x${encByte.toString(16).padStart(2, "0")} on a ${family} stream: ${why}`,
    );
}

/** The physical field of a transformed integer stream, which always writes its byte length. */
function physicalInt(encByte: number, family: Family02): Physical02 {
    switch ((encByte & PHYSICAL_MASK) >> 2) {
        case PHYSICAL_NONE:
            return "none";
        case PHYSICAL_VARINT:
            return "varint";
        case PHYSICAL_FASTPFOR:
            return "fastPfor";
        default:
            return reject(encByte, family, "physical 00 is only valid on logical None");
    }
}

function requirePhysical(encByte: number, family: Family02, bits: number, why: string): void {
    if ((encByte & PHYSICAL_MASK) >> 2 !== bits) {
        reject(encByte, family, why);
    }
}

function readByte(tile: Uint8Array, offset: IntWrapper): number {
    const pos = offset.get();
    if (pos >= tile.length) {
        throw new Error(`Stream header overruns the tile at byte ${pos}`);
    }
    offset.set(pos + 1);
    return tile[pos];
}

function readVarint32(tile: Uint8Array, offset: IntWrapper): number {
    let value = 0;
    for (let shift = 0; shift < 35; shift += 7) {
        const b = readByte(tile, offset);
        value |= (b & 0x7f) << shift;
        if (b < 0x80) {
            return value >>> 0;
        }
    }
    throw new Error(`Varint longer than 32 bits at byte ${offset.get()}`);
}

function readVarint64(tile: Uint8Array, offset: IntWrapper): bigint {
    let value = 0n;
    for (let shift = 0n; shift < 70n; shift += 7n) {
        const b = readByte(tile, offset);
        value |= BigInt(b & 0x7f) << shift;
        if (b < 0x80) {
            return value;
        }
    }
    throw new Error(`Varint longer than 64 bits at byte ${offset.get()}`);
}

/** `scale` numbers the valid `(e, f)` pairs with `f <= e` row by row, so `e` is the row the byte falls in. */
function alpScale(encByte: number, family: Family02, byte: number): { e: number; f: number } {
    for (let e = 0; e <= ALP_MAX_EXPONENT; e++) {
        const f = byte - (e * (e + 1)) / 2;
        if (f >= 0 && f <= e) {
            return { e, f };
        }
    }
    return reject(encByte, family, `ALP scale byte ${byte} is past the last (e, f) pair`);
}

/**
 * Reads one stream header, leaving `offset` at the first payload byte.
 *
 * `impliedCount` is what the stream holds when its header carries no count: the layer's feature
 * count, a presence field's population count, or the leading stream's count. Pass `undefined`
 * where the context implies none, so that a stream without an explicit count is rejected.
 */
export function readStreamHeader02(
    tile: Uint8Array,
    offset: IntWrapper,
    family: Family02,
    impliedCount?: number,
): StreamHeader02 {
    const encByte = readByte(tile, offset);
    const code = (encByte & LOGICAL_MASK) >> LOGICAL_SHIFT;
    const logical = members(family)[code];
    if (logical === undefined) {
        reject(encByte, family, `logical code ${code} is not assigned`);
    }
    const extension = encByte & EXTENSION_MASK;
    const explicitCount = (encByte & HAS_EXPLICIT_COUNT) !== 0;

    const header: StreamHeader02 = {
        family,
        logical,
        physical: "implied",
        explicitCount,
        numValues: 0,
        byteLength: undefined,
        wordsPerValue: 1,
    };
    // Set when the byte length follows from the count and the family's word width.
    let omitsByteLength = false;

    switch (family) {
        case "int32":
        case "int64":
        case "str": {
            if (family === "str") {
                header.strLayout = (["plain", "dict", "fsst", "fsstDict"] as const)[extension];
            } else if (extension !== 0) {
                reject(encByte, family, "extension bits are reserved");
            }
            switch (logical) {
                case "none":
                    if ((encByte & PHYSICAL_MASK) === 0) {
                        header.physical = "none";
                        omitsByteLength = true;
                    } else {
                        header.physical = physicalInt(encByte, family);
                    }
                    break;
                case "delta":
                case "delta2":
                    header.physical = physicalInt(encByte, family);
                    break;
                default:
                    // RLE, DeltaRLE and bit packing define their own layout.
                    requirePhysical(encByte, family, 0, `${logical} reserves the physical field`);
            }
            break;
        }
        case "bool":
            if (extension !== 0) {
                reject(encByte, family, "extension bits are reserved");
            }
            requirePhysical(encByte, family, 0, "a bool stream reserves the physical field");
            break;
        case "float32":
        case "float64":
            if (extension !== 0) {
                reject(encByte, family, "extension bits are reserved");
            }
            if (logical === "none") {
                const physical = (encByte & PHYSICAL_MASK) >> 2;
                if (physical === PHYSICAL_NO_LEN) {
                    omitsByteLength = true;
                } else if (physical !== PHYSICAL_NONE) {
                    reject(encByte, family, "raw floats admit only physical 00 or 01");
                }
                header.physical = "none";
            } else {
                // ALP's scaled integers and a dictionary's codes are integer streams.
                header.physical = physicalInt(encByte, family);
            }
            break;
        case "vertex": {
            if ((extension & ~XYZ) !== 0) {
                reject(encByte, family, "extension bit 1 is reserved");
            }
            const xyz = extension === XYZ;
            if (xyz && (logical === "morton" || logical === "cwDelta2" || logical === "rans")) {
                reject(encByte, family, `${logical} is defined over (x, y) pairs only`);
            }
            header.wordsPerValue = xyz ? 3 : logical === "morton" ? 1 : 2;
            if (logical === "none") {
                if ((encByte & PHYSICAL_MASK) === 0) {
                    header.physical = "none";
                    omitsByteLength = true;
                } else {
                    header.physical = physicalInt(encByte, family);
                }
            } else if (logical === "rans") {
                requirePhysical(encByte, family, 0, "rANS reserves the physical field");
            } else {
                header.physical = physicalInt(encByte, family);
            }
            break;
        }
        case "bytes":
            if (extension !== 0) {
                reject(encByte, family, "extension bits are reserved");
            }
            if (explicitCount) {
                reject(encByte, family, "a byte blob's count is its byte length");
            }
            requirePhysical(encByte, family, PHYSICAL_NONE, "a byte blob stores its bytes as they are");
            break;
    }

    if (family === "bytes") {
        header.byteLength = readVarint32(tile, offset);
        header.numValues = header.byteLength;
        return header;
    }

    if (explicitCount) {
        header.numValues = readVarint32(tile, offset);
    } else if (impliedCount === undefined) {
        reject(encByte, family, "the context implies no count and the header carries none");
    } else {
        header.numValues = impliedCount;
    }

    if (family === "bool") {
        // The payload delimits itself; the presence decoder finds its end.
    } else if (omitsByteLength) {
        header.byteLength = header.numValues * header.wordsPerValue * wordBytes(family);
    } else {
        header.byteLength = readVarint32(tile, offset);
    }

    if (logical === "alp") {
        const scale = alpScale(encByte, family, readByte(tile, offset));
        const base = decodeZigZagInt64Value(readVarint64(tile, offset));
        header.alp = { ...scale, base };
    }
    if (family === "vertex" && extension === XYZ) {
        const zCode = readByte(tile, offset);
        const zStep = zCode + Z_STEP_MIN;
        if (zStep > Z_STEP_MAX) {
            reject(encByte, family, `z step code ${zCode} is reserved`);
        }
        header.zStep = zStep;
    }
    if (logical === "morton") {
        const bits = readVarint32(tile, offset);
        const shift = readVarint32(tile, offset);
        if (bits > MORTON_MAX_BITS) {
            reject(encByte, family, `Morton grid of ${bits} bits exceeds ${MORTON_MAX_BITS}`);
        }
        header.morton = { bits, shift };
    }
    return header;
}
