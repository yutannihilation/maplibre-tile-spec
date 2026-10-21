import BitVector from "../../vector/flat/bitVector";
import type IntWrapper from "../intWrapper";
import type { StreamHeader02 } from "./streamHeader02";

/**
 * The three ways a v2 layer stores one bit per value (`docs/specification/v2.md#presence-encodings`):
 * a column's presence field, a boolean column's data stream and a nested node's presence stream.
 * `Runs` and `Sparse` delimit themselves, so no length is ever stored for a bitfield.
 *
 * The reference is `codecs/presence_coding.rs` in mlt-core.
 */

export type PresenceCoding02 = "bitmap" | "runs" | "sparse";

/** What a column's presence nibble names. */
export type Presence02 =
    | { kind: "all" }
    | { kind: "inline"; coding: PresenceCoding02 }
    | { kind: "shared"; index: number };

const CODINGS: readonly PresenceCoding02[] = ["bitmap", "runs", "sparse"];
const SHARED_BASE = 4;
const SHARED_MAX = 10;

/**
 * Reads `count` bits in `coding`, leaving `offset` after the payload.
 *
 * A bitmap is a view of the tile bytes; the other codings build their bits.
 */
export function readPresence02(
    tile: Uint8Array,
    offset: IntWrapper,
    count: number,
    coding: PresenceCoding02,
): BitVector {
    const byteCount = Math.ceil(count / 8);
    switch (coding) {
        case "bitmap": {
            const start = offset.get();
            const end = start + byteCount;
            if (end > tile.length) {
                throw new Error(`Presence bitmap of ${byteCount} bytes overruns the tile at byte ${start}`);
            }
            offset.set(end);
            return new BitVector(tile.subarray(start, end), count);
        }
        case "sparse": {
            const summaryCount = Math.ceil(byteCount / 8);
            const start = offset.get();
            if (start + summaryCount > tile.length) {
                throw new Error(`Sparse presence summary of ${summaryCount} bytes overruns the tile at byte ${start}`);
            }
            const summary = tile.subarray(start, start + summaryCount);
            let pos = start + summaryCount;
            const bytes = new Uint8Array(byteCount);
            for (let i = 0; i < summaryCount * 8; i++) {
                if (((summary[i >> 3] >> (i & 7)) & 1) === 0) {
                    continue;
                }
                if (i >= byteCount) {
                    throw new Error(`Sparse presence summary names byte ${i}, past the bitmap's ${byteCount} bytes`);
                }
                if (pos >= tile.length) {
                    throw new Error(`Sparse presence bytes overrun the tile at byte ${pos}`);
                }
                const byte = tile[pos++];
                if (byte === 0) {
                    throw new Error(`Sparse presence stores a zero byte at bitmap byte ${i}`);
                }
                bytes[i] = byte;
            }
            offset.set(pos);
            return new BitVector(bytes, count);
        }
        case "runs": {
            const bytes = new Uint8Array(byteCount);
            let at = 0;
            let present = false;
            while (at < count) {
                const run = readVarint(tile, offset);
                const end = at + run;
                if (end > count) {
                    throw new Error(`Presence run of ${run} values overruns the field's ${count}`);
                }
                if (present) {
                    for (let i = at; i < end; i++) {
                        bytes[i >> 3] |= 1 << (i & 7);
                    }
                }
                at = end;
                present = !present;
            }
            return new BitVector(bytes, count);
        }
    }
}

/** How many of the bits within the vector's size are set; padding bits past it do not count. */
export function presentCount(bits: BitVector): number {
    const size = bits.size();
    const bytes = bits.getBuffer();
    let total = 0;
    const whole = size >> 3;
    for (let i = 0; i < whole; i++) {
        total += POPCOUNT[bytes[i]];
    }
    const rest = size & 7;
    if (rest !== 0) {
        total += POPCOUNT[bytes[whole] & ((1 << rest) - 1)];
    }
    return total;
}

const POPCOUNT = new Uint8Array(256);
for (let i = 0; i < 256; i++) {
    POPCOUNT[i] = (i & 1) + POPCOUNT[i >> 1];
}

/**
 * Resolves a column type byte's presence nibble (`docs/specification/v2.md#presence-nibble`)
 * against the number of shared fields the layer declared.
 */
export function parsePresenceNibble02(nibble: number, sharedCount: number): Presence02 {
    if (nibble === 0) {
        return { kind: "all" };
    }
    if (nibble < SHARED_BASE) {
        return { kind: "inline", coding: CODINGS[nibble - 1] };
    }
    if (nibble > SHARED_MAX) {
        throw new Error(`Presence nibble ${nibble} is reserved`);
    }
    const index = nibble - SHARED_BASE;
    if (index >= sharedCount) {
        throw new Error(`Presence nibble names shared field ${index}, but the layer declares ${sharedCount}`);
    }
    return { kind: "shared", index };
}

/**
 * Reads the layer's shared presence fields (`docs/specification/v2.md#shared-presence-fields`):
 * `count` fields of `featureCount` bits back to back, each led by a `Bool` encoding byte naming
 * its coding when `coded` is set, otherwise all bitmaps.
 */
export function readSharedPresence02(
    tile: Uint8Array,
    offset: IntWrapper,
    count: number,
    coded: boolean,
    featureCount: number,
): BitVector[] {
    const fields: BitVector[] = [];
    for (let i = 0; i < count; i++) {
        let coding: PresenceCoding02 = "bitmap";
        if (coded) {
            const pos = offset.get();
            if (pos >= tile.length) {
                throw new Error(`Shared presence field ${i} overruns the tile at byte ${pos}`);
            }
            const byte = tile[pos];
            offset.set(pos + 1);
            // The logical field of a Bool encoding byte, with every other bit clear.
            const named = (byte & 0x8f) === 0 ? CODINGS[byte >> 4] : undefined;
            if (named === undefined) {
                throw new Error(`Shared presence field ${i} has an invalid coding byte 0x${byte.toString(16)}`);
            }
            coding = named;
        }
        fields.push(readPresence02(tile, offset, featureCount, coding));
    }
    return fields;
}

/** Reads the payload of a `Bool` stream whose header was just read. */
export function readBoolStream02(tile: Uint8Array, offset: IntWrapper, header: StreamHeader02): BitVector {
    if (header.family !== "bool") {
        throw new Error(`A ${header.family} stream is not a bool stream`);
    }
    return readPresence02(tile, offset, header.numValues, header.logical as PresenceCoding02);
}

function readVarint(tile: Uint8Array, offset: IntWrapper): number {
    let value = 0;
    let pos = offset.get();
    for (let shift = 0; shift < 35; shift += 7) {
        if (pos >= tile.length) {
            throw new Error(`Presence run length overruns the tile at byte ${pos}`);
        }
        const b = tile[pos++];
        value += (b & 0x7f) * 2 ** shift;
        if (b < 0x80) {
            offset.set(pos);
            return value;
        }
    }
    throw new Error(`Presence run length is longer than 32 bits at byte ${offset.get()}`);
}
