import { describe, expect, it } from "vitest";
import IntWrapper from "../intWrapper";
import { decodeFloatStream02 } from "./floatStream02";
import { type Family02, readStreamHeader02 } from "./streamHeader02";

function decode(bytes: number[], family: Family02, impliedCount: number) {
    const tile = new Uint8Array(bytes);
    const offset = new IntWrapper(0);
    const header = readStreamHeader02(tile, offset, family, impliedCount);
    const values = decodeFloatStream02(tile, offset, header);
    return { values: Array.from(values), end: offset.get() };
}

describe("decodeFloatStream02 - raw", () => {
    it("reads little-endian singles and doubles", () => {
        expect(decode([0x00, 0, 0, 192, 63, 0, 0, 16, 192], "float32", 2)).toEqual({ values: [1.5, -2.25], end: 9 });
        expect(decode([0x04, 0x08, 0, 0, 0, 0, 0, 0, 248, 63], "float64", 1)).toEqual({ values: [1.5], end: 10 });
    });

    it("keeps -0.0 and NaN as they are", () => {
        const { values } = decode([0x00, 0, 0, 0, 128, 0, 0, 192, 127], "float32", 2);
        expect(Object.is(values[0], -0)).toBe(true);
        expect(Number.isNaN(values[1])).toBe(true);
    });

    it("rejects a byte length that does not hold the values, and a stream cut short", () => {
        expect(() => decode([0x04, 0x05, 0, 0, 0, 0, 0], "float32", 1)).toThrow(/byte length/);
        expect(() => decode([0x00, 0, 0], "float32", 1)).toThrow();
    });
});

describe("decodeFloatStream02 - ALP", () => {
    // values [-0.75, 0.25, 1.5, -2.25]: e 2, f 0 (scale byte 3), base -225 (zigzag 449 = C1 03),
    // offsets [150, 250, 375, 0] as varints
    const EXAMPLE = [0x28, 0x07, 0x03, 0xc1, 0x03, 0x96, 0x01, 0xfa, 0x01, 0xf7, 0x02, 0x00];

    it("reconstructs the encodings doc example for doubles and singles", () => {
        expect(decode(EXAMPLE, "float64", 4)).toEqual({ values: [-0.75, 0.25, 1.5, -2.25], end: 12 });
        expect(decode(EXAMPLE, "float32", 4).values).toEqual([-0.75, 0.25, 1.5, -2.25]);
    });

    it("divides the trailing zeros out with f", () => {
        // e 2, f 1 (scale byte 4), base 0, offset 15: 15 * 10 * 0.01
        expect(decode([0x28, 0x01, 0x04, 0x00, 0x0f], "float64", 1).values).toEqual([1.5]);
    });

    it("reads raw 64-bit offset words", () => {
        expect(decode([0x24, 0x08, 0x00, 0x00, 7, 0, 0, 0, 0, 0, 0, 0], "float64", 1).values).toEqual([7]);
    });

    it("forms base plus offset as an integer before converting", () => {
        // base -2 (zigzag 3), offset 2^53 + 1: the code 2^53 - 1 is exact, the offset alone is not
        const bytes = [0x28, 0x08, 0x00, 0x03, 0x81, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x10];
        expect(decode(bytes, "float64", 1).values).toEqual([9007199254740991]);
    });

    it("reads offsets over FastPFOR as 32-bit words", () => {
        // ALP over FastPFOR (0x2c), 16 payload bytes: the tail-only words [1, 300, 70000, 0xffffffff, 7] with e 0, base 0
        const tail = [0, 0, 0, 0, 129, 44, 130, 112, 34, 132, 127, 127, 127, 127, 143, 135];
        expect(decode([0x2c, 0x10, 0x00, 0x00, ...tail], "float64", 5).values).toEqual([1, 300, 70000, 4294967295, 7]);
    });
});

describe("decodeFloatStream02 - dictionary", () => {
    // codes [0, 1, 0, 0, 1] as varints, then a raw dictionary of [1.5, 0.25] with an explicit count
    const DICT = [0x38, 0x05, 0, 1, 0, 0, 1, 0x80, 0x02, 0, 0, 192, 63, 0, 0, 128, 62];

    it("looks each code up in the dictionary that follows", () => {
        expect(decode(DICT, "float32", 5)).toEqual({ values: [1.5, 0.25, 1.5, 1.5, 0.25], end: 17 });
    });

    it("rejects a code past the dictionary and a dictionary that is not raw", () => {
        const bad = [...DICT];
        bad[6] = 2;
        expect(() => decode(bad, "float32", 5)).toThrow(/dictionary code/);
        const alpDict = [0x38, 0x01, 0, 0xa8, 0x01, 0x01, 0x00, 0x00, 0x00];
        expect(() => decode(alpDict, "float32", 1)).toThrow(/stored raw/);
    });
});
