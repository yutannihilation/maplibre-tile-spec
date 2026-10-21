import { describe, expect, it } from "vitest";
import IntWrapper from "../intWrapper";
import { decodeIntStream02, readWords32, readWords64 } from "./intStream02";
import { type Family02, readStreamHeader02 } from "./streamHeader02";

/** Parses a header from `bytes`, then decodes the payload that follows it. */
function decode(bytes: number[], family: Family02, impliedCount: number | undefined, signed: boolean) {
    const tile = new Uint8Array(bytes);
    const offset = new IntWrapper(0);
    const header = readStreamHeader02(tile, offset, family, impliedCount);
    const values = decodeIntStream02(tile, offset, header, signed);
    return { values: Array.from(values as ArrayLike<number | bigint>), end: offset.get() };
}

const le32 = (...words: number[]) => words.flatMap((w) => [w & 0xff, (w >>> 8) & 0xff, (w >>> 16) & 0xff, w >>> 24]);

describe("decodeIntStream02 - raw words", () => {
    it("reads 32-bit little-endian words, zigzag-decoding them when signed", () => {
        const bytes = [0x00, ...le32(1, 0xffffffff)];
        expect(decode(bytes, "int32", 2, false)).toEqual({ values: [1, 0xffffffff], end: 9 });
        expect(decode(bytes, "int32", 2, true)).toEqual({ values: [-1, -2147483648], end: 9 });
    });

    it("reads 64-bit words as bigint", () => {
        const bytes = [0x00, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 2, 0, 0, 0, 0, 0, 0, 0];
        expect(decode(bytes, "int64", 2, false).values).toEqual([0xffffffffffffffffn, 2n]);
        expect(decode(bytes, "int64", 2, true).values).toEqual([-9223372036854775808n, 1n]);
    });

    it("reads a string column's leading stream as 32-bit words", () => {
        expect(decode([0x01, ...le32(5, 6)], "str", 2, false).values).toEqual([5, 6]);
    });

    it("rejects a byte length that does not match the word count", () => {
        expect(() => decode([0x04, 0x07, ...le32(1, 2)], "int32", 2, false)).toThrow();
        expect(() => decode([0x00, 1, 0, 0], "int32", 1, false)).toThrow();
    });
});

describe("decodeIntStream02 - varint words", () => {
    it("reads one varint per value", () => {
        const { values, end } = decode([0x08, 0x03, 0xac, 0x02, 0x01], "int32", 2, false);
        expect(values).toEqual([300, 1]);
        expect(end).toBe(5);
        expect(decode([0x08, 0x02, 0x01, 0x02], "int32", 2, true).values).toEqual([-1, 1]);
    });

    it("reads 64-bit varints", () => {
        const bytes = [0x08, 0x0a, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x01];
        expect(decode(bytes, "int64", 1, false).values).toEqual([0xffffffffffffffffn]);
        expect(decode(bytes, "int64", 1, true).values).toEqual([-9223372036854775808n]);
    });

    it("rejects a non-canonical varint, one longer than its width, and bytes left over", () => {
        expect(() => decode([0x08, 0x02, 0x80, 0x00], "int32", 1, false)).toThrow(/canonical/);
        expect(() => decode([0x08, 0x06, 0xff, 0xff, 0xff, 0xff, 0xff, 0x01], "int32", 1, false)).toThrow();
        expect(() => decode([0x08, 0x02, 0x01, 0x01], "int32", 1, false)).toThrow(/left over/);
        expect(() => decode([0x08, 0x01, 0x80], "int32", 1, false)).toThrow();
    });
});

describe("decodeIntStream02 - delta", () => {
    it("prefix-sums zigzag deltas from zero", () => {
        // values [10, 13, 16, 20] -> deltas [10, 3, 3, 4] -> zigzag [20, 6, 6, 8]
        expect(decode([0x18, 0x04, 20, 6, 6, 8], "int32", 4, true).values).toEqual([10, 13, 16, 20]);
        expect(decode([0x18, 0x04, 20, 6, 6, 8], "int32", 4, false).values).toEqual([10, 13, 16, 20]);
    });

    it("wraps at the word width, so an unsigned stream can step down", () => {
        // deltas [-1, 2] -> zigzag [1, 4]
        expect(decode([0x18, 0x02, 1, 4], "int32", 2, false).values).toEqual([0xffffffff, 1]);
        expect(decode([0x18, 0x02, 1, 4], "int32", 2, true).values).toEqual([-1, 1]);
        expect(decode([0x18, 0x02, 1, 4], "int64", 2, false).values).toEqual([0xffffffffffffffffn, 1n]);
        expect(decode([0x18, 0x02, 1, 4], "int64", 2, true).values).toEqual([-1n, 1n]);
    });

    it("decodes an empty stream", () => {
        expect(decode([0x18, 0x00], "int32", 0, true).values).toEqual([]);
    });
});

describe("decodeIntStream02 - delta2", () => {
    it("sums the deltas of the deltas, as the encodings doc shows", () => {
        // values [10, 13, 16, 20] -> delta2 [10, -7, 0, 1] -> zigzag [20, 13, 0, 2]
        expect(decode([0x58, 0x04, 20, 13, 0, 2], "int32", 4, true).values).toEqual([10, 13, 16, 20]);
        expect(decode([0x58, 0x04, 20, 13, 0, 2], "int64", 4, false).values).toEqual([10n, 13n, 16n, 20n]);
    });

    it("wraps both running sums", () => {
        // delta2 [-1] -> delta -1 -> value -1
        expect(decode([0x58, 0x01, 1], "int32", 1, false).values).toEqual([0xffffffff]);
    });
});

describe("decodeIntStream02 - RLE", () => {
    it("expands (run, value) pairs read to the end of the payload", () => {
        const pairs = [3, 7, 1, 9, 2, 5];
        expect(decode([0x20, 0x06, ...pairs], "int32", 6, false).values).toEqual([7, 7, 7, 9, 5, 5]);
        // values zigzag-decode after expansion: 7 -> -4, 9 -> -5, 5 -> -3
        expect(decode([0x20, 0x06, ...pairs], "int32", 6, true).values).toEqual([-4, -4, -4, -5, -3, -3]);
        expect(decode([0x20, 0x06, ...pairs], "int64", 6, false).values).toEqual([7n, 7n, 7n, 9n, 5n, 5n]);
    });

    it("decodes an empty stream", () => {
        expect(decode([0x20, 0x00], "int32", 0, false).values).toEqual([]);
    });

    it("rejects an odd number of words, runs that do not sum to the count, and a run past it", () => {
        expect(() => decode([0x20, 0x03, 3, 7, 1], "int32", 4, false)).toThrow();
        expect(() => decode([0x20, 0x02, 3, 7], "int32", 4, false)).toThrow();
        expect(() => decode([0x20, 0x02, 5, 7], "int32", 4, false)).toThrow();
    });
});

describe("decodeIntStream02 - delta RLE", () => {
    it("expands the pairs, then prefix-sums the zigzag deltas", () => {
        // pairs (2, 2) (1, 1) -> [2, 2, 1] -> deltas [1, 1, -1] -> [1, 2, 1]
        expect(decode([0x30, 0x04, 2, 2, 1, 1], "int32", 3, true).values).toEqual([1, 2, 1]);
        expect(decode([0x30, 0x04, 2, 2, 1, 1], "int64", 3, true).values).toEqual([1n, 2n, 1n]);
    });
});

describe("decodeIntStream02 - FastPFOR", () => {
    it("decodes 32-bit words through the 128-value variant", () => {
        const tail = [0, 0, 0, 0, 129, 44, 130, 112, 34, 132, 127, 127, 127, 127, 143, 135];
        expect(decode([0x0c, 0x10, ...tail], "int32", 5, false).values).toEqual([1, 300, 70000, 0xffffffff, 7]);
        expect(decode([0x1c, 0x10, ...tail], "int32", 5, true).values).toEqual([
            -1, 149, 35149, -2147448499, -2147448503,
        ]);
    });

    it("rejects FastPFOR on 64-bit words, which the reference has no form for", () => {
        expect(() => decode([0x0c, 0x04, 0, 0, 0, 0], "int64", 1, false)).toThrow(/64-bit/);
    });
});

describe("readWords32 / readWords64", () => {
    it("reads a given number of words for a multi-word stream", () => {
        const tile = new Uint8Array([0x00, ...le32(1, 2, 3, 4)]);
        const offset = new IntWrapper(0);
        const header = readStreamHeader02(tile, offset, "vertex", 2);
        expect(Array.from(readWords32(tile, offset, header, 4))).toEqual([1, 2, 3, 4]);
        expect(offset.get()).toBe(17);
    });

    it("reads 64-bit varint words", () => {
        const tile = new Uint8Array([0x08, 0x02, 0x01, 0x02]);
        const offset = new IntWrapper(0);
        const header = readStreamHeader02(tile, offset, "int64", 2);
        expect(Array.from(readWords64(tile, offset, header, 2))).toEqual([1n, 2n]);
    });
});
