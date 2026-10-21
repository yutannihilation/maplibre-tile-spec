import { describe, expect, it } from "vitest";
import { unpackBits32, unpackBits64 } from "./bitPacking";
import IntWrapper from "./intWrapper";
import { decodeIntStream02 } from "./v2/intStream02";
import { readStreamHeader02 } from "./v2/streamHeader02";

describe("unpackBits32", () => {
    it("reads the encodings doc example: [5, 1, 7, 0] at three bits", () => {
        expect(Array.from(unpackBits32(new Uint8Array([0x03, 0xcd, 0x01]), 4))).toEqual([5, 1, 7, 0]);
    });

    it("reads an empty stream and a stream of zeros at width 1", () => {
        expect(Array.from(unpackBits32(new Uint8Array([0x01]), 0))).toEqual([]);
        expect(Array.from(unpackBits32(new Uint8Array([0x01, 0x00]), 3))).toEqual([0, 0, 0]);
    });

    it("reads one-bit, byte-aligned, 17-bit and full-width values", () => {
        // 1,0,1,1,0,0,1,0,1 LSB-first: bits 101101001 -> 0x4D, 0x01
        expect(Array.from(unpackBits32(new Uint8Array([0x01, 0x4d, 0x01]), 9))).toEqual([1, 0, 1, 1, 0, 0, 1, 0, 1]);
        expect(Array.from(unpackBits32(new Uint8Array([0x08, 255, 0, 128, 7]), 4))).toEqual([255, 0, 128, 7]);
        // 17 bits: 0, 131071, 65536, 1
        const seventeen = [0x11, 0x00, 0x00, 0xfe, 0xff, 0x03, 0x00, 0x0c, 0x00, 0x00];
        expect(Array.from(unpackBits32(new Uint8Array(seventeen), 4))).toEqual([0, 131071, 65536, 1]);
        const full = [0x20, 0xff, 0xff, 0xff, 0xff, 0, 0, 0, 0, 1, 0, 0, 0];
        expect(Array.from(unpackBits32(new Uint8Array(full), 3))).toEqual([0xffffffff, 0, 1]);
    });

    it("ignores padding bits past the last value", () => {
        // the last value ends at bit 11, so bits 12-15 of the second byte are padding
        expect(Array.from(unpackBits32(new Uint8Array([0x03, 0xcd, 0xf1]), 4))).toEqual([5, 1, 7, 0]);
    });

    it("rejects a width of 0 or past 32, a missing width byte, and a payload of the wrong length", () => {
        expect(() => unpackBits32(new Uint8Array([0x00, 0x00]), 1)).toThrow(/width/);
        expect(() => unpackBits32(new Uint8Array([33, 0x00]), 1)).toThrow(/width/);
        expect(() => unpackBits32(new Uint8Array([]), 0)).toThrow();
        expect(() => unpackBits32(new Uint8Array([0x04, 0x21]), 4)).toThrow(/length/);
        expect(() => unpackBits32(new Uint8Array([0x04, 0x21, 0x43, 0x00]), 4)).toThrow(/length/);
    });
});

describe("unpackBits64", () => {
    it("reads the same layout into 64-bit words", () => {
        expect(Array.from(unpackBits64(new Uint8Array([0x03, 0xcd, 0x01]), 4))).toEqual([5n, 1n, 7n, 0n]);
        const full = [0x20, 0xff, 0xff, 0xff, 0xff, 0, 0, 0, 0, 1, 0, 0, 0];
        expect(Array.from(unpackBits64(new Uint8Array(full), 3))).toEqual([0xffffffffn, 0n, 1n]);
    });
});

describe("decodeIntStream02 - bit packed", () => {
    function decode(bytes: number[], family: "int32" | "int64", count: number, signed: boolean) {
        const tile = new Uint8Array(bytes);
        const offset = new IntWrapper(0);
        const header = readStreamHeader02(tile, offset, family, count);
        const values = Array.from(decodeIntStream02(tile, offset, header, signed) as ArrayLike<number | bigint>);
        return { values, end: offset.get() };
    }

    it("unpacks the words and zigzag-decodes them when signed", () => {
        expect(decode([0x40, 0x03, 0x03, 0xcd, 0x01], "int32", 4, false)).toEqual({ values: [5, 1, 7, 0], end: 5 });
        expect(decode([0x40, 0x03, 0x03, 0xcd, 0x01], "int32", 4, true).values).toEqual([-3, -1, -4, 0]);
        expect(decode([0x40, 0x03, 0x03, 0xcd, 0x01], "int64", 4, true).values).toEqual([-3n, -1n, -4n, 0n]);
    });

    it("rejects a byte length that does not fit the width", () => {
        expect(() => decode([0x40, 0x02, 0x03, 0xcd], "int32", 4, false)).toThrow(/length/);
    });
});
