import { decodeString } from "../decodingUtils";
import type IntWrapper from "../intWrapper";

/** Bounds-checked readers for the scalar fields of a v2 layer: bytes, varints and length-prefixed strings. */

export function readU8(tile: Uint8Array, offset: IntWrapper, what: string): number {
    const pos = offset.get();
    if (pos >= tile.length) {
        throw new Error(`${what} overruns the tile at byte ${pos}`);
    }
    offset.set(pos + 1);
    return tile[pos];
}

/** An unsigned 32-bit varint. A multi-byte varint must not end in a zero byte, so every value has one spelling. */
export function readVarint32(tile: Uint8Array, offset: IntWrapper, what: string): number {
    let value = 0;
    const start = offset.get();
    let pos = start;
    for (let shift = 0; shift < 35; shift += 7) {
        if (pos >= tile.length) {
            throw new Error(`${what} overruns the tile at byte ${pos}`);
        }
        const b = tile[pos++];
        if (shift === 28 && b > 0x0f) {
            throw new Error(`${what} at byte ${start} is a varint longer than 32 bits`);
        }
        value |= (b & 0x7f) << shift;
        if (b < 0x80) {
            if (b === 0 && pos - start > 1) {
                throw new Error(`${what} at byte ${start} is a non-canonical varint`);
            }
            offset.set(pos);
            return value >>> 0;
        }
    }
    throw new Error(`${what} at byte ${start} is a varint longer than 32 bits`);
}

/** An unsigned 64-bit varint, as a bigint. */
export function readVarint64(tile: Uint8Array, offset: IntWrapper, what: string): bigint {
    let value = 0n;
    const start = offset.get();
    let pos = start;
    for (let shift = 0n; shift < 70n; shift += 7n) {
        if (pos >= tile.length) {
            throw new Error(`${what} overruns the tile at byte ${pos}`);
        }
        const b = tile[pos++];
        if (shift === 63n && b > 0x01) {
            throw new Error(`${what} at byte ${start} is a varint longer than 64 bits`);
        }
        value |= BigInt(b & 0x7f) << shift;
        if (b < 0x80) {
            if (b === 0 && pos - start > 1) {
                throw new Error(`${what} at byte ${start} is a non-canonical varint`);
            }
            offset.set(pos);
            return value;
        }
    }
    throw new Error(`${what} at byte ${start} is a varint longer than 64 bits`);
}

/** A UTF-8 string with a varint byte-length prefix. */
export function readString02(tile: Uint8Array, offset: IntWrapper, what: string): string {
    const length = readVarint32(tile, offset, `${what} length`);
    const start = offset.get();
    const end = start + length;
    if (end > tile.length) {
        throw new Error(`${what} of ${length} bytes overruns the tile at byte ${start}`);
    }
    offset.set(end);
    return decodeString(tile, start, end);
}
