import { describe, expect, it } from "vitest";
import IntWrapper from "../intWrapper";
import {
    parsePresenceNibble02,
    presentCount,
    readBoolStream02,
    readPresence02,
    readSharedPresence02,
    type PresenceCoding02,
} from "./presence02";
import { readStreamHeader02 } from "./streamHeader02";

function bits(bytes: number[], count: number, coding: PresenceCoding02): { bits: boolean[]; end: number } {
    const offset = new IntWrapper(0);
    const vector = readPresence02(new Uint8Array(bytes), offset, count, coding);
    expect(vector.size()).toBe(count);
    return { bits: Array.from({ length: count }, (_, i) => vector.get(i)), end: offset.get() };
}

const T = true;
const F = false;

describe("readPresence02 - bitmap", () => {
    it("reads one bit per value, LSB-first, over ceil(N / 8) bytes", () => {
        // six present values among N = 32, at 10 to 15
        const { bits: b, end } = bits([0x00, 0xfc, 0x00, 0x00], 32, "bitmap");
        expect(b.slice(8, 16)).toEqual([F, F, T, T, T, T, T, T]);
        expect(b.filter(Boolean).length).toBe(6);
        expect(end).toBe(4);
    });

    it("ignores the padding bits of the last byte", () => {
        const offset = new IntWrapper(0);
        const vector = readPresence02(new Uint8Array([0xff]), offset, 3, "bitmap");
        expect(presentCount(vector)).toBe(3);
        expect(bits([], 0, "bitmap")).toEqual({ bits: [], end: 0 });
    });

    it("rejects a bitmap cut short", () => {
        expect(() => bits([0x00], 9, "bitmap")).toThrow();
    });
});

describe("readPresence02 - runs", () => {
    it("reads alternating absent and present run lengths, the first of which may be zero", () => {
        expect(bits([0x02, 0x03, 0x01], 6, "runs")).toEqual({ bits: [F, F, T, T, T, F], end: 3 });
        expect(bits([0x00, 0x04], 4, "runs")).toEqual({ bits: [T, T, T, T], end: 2 });
        expect(bits([0x04], 4, "runs")).toEqual({ bits: [F, F, F, F], end: 1 });
        expect(bits([], 0, "runs")).toEqual({ bits: [], end: 0 });
    });

    it("reads long runs as varints", () => {
        const { bits: b, end } = bits([0xac, 0x02, 0x01], 301, "runs");
        expect(b.filter(Boolean).length).toBe(1);
        expect(b[300]).toBe(T);
        expect(end).toBe(3);
    });

    it("rejects runs that overrun or fall short of the count", () => {
        expect(() => bits([0x02, 0x05], 6, "runs")).toThrow();
        expect(() => bits([0x02, 0x03], 6, "runs")).toThrow();
    });
});

describe("readPresence02 - sparse", () => {
    it("reads a summary of the non-zero bitmap bytes, then those bytes", () => {
        // bitmap 00 2D 00 over 24 values: only byte 1 is non-zero
        const { bits: b, end } = bits([0x02, 0x2d], 24, "sparse");
        expect(b.slice(8, 16)).toEqual([T, F, T, T, F, T, F, F]);
        expect(b.filter(Boolean).length).toBe(4);
        expect(end).toBe(2);
    });

    it("reads an empty summary for a field with nothing present", () => {
        expect(bits([0x00], 24, "sparse").bits.filter(Boolean).length).toBe(0);
        expect(bits([], 0, "sparse")).toEqual({ bits: [], end: 0 });
    });

    it("spans more than one summary byte", () => {
        // 100 values: 13 bitmap bytes, 2 summary bytes; bytes 0 and 12 are set
        const { bits: b, end } = bits([0x01, 0x10, 0x01, 0x08], 100, "sparse");
        expect(b[0]).toBe(T);
        expect(b[99]).toBe(T);
        expect(b.filter(Boolean).length).toBe(2);
        expect(end).toBe(4);
    });

    it("rejects a summary bit past the bitmap, a stored zero byte, and a payload cut short", () => {
        expect(() => bits([0x08, 0x01], 24, "sparse")).toThrow(/summary/);
        expect(() => bits([0x02, 0x00], 24, "sparse")).toThrow(/zero/);
        expect(() => bits([0x02], 24, "sparse")).toThrow();
        expect(() => bits([], 24, "sparse")).toThrow();
    });
});

describe("presentCount", () => {
    it("counts the set bits within the size", () => {
        const offset = new IntWrapper(0);
        expect(presentCount(readPresence02(new Uint8Array([0xff, 0xff]), offset, 11, "bitmap"))).toBe(11);
    });
});

describe("parsePresenceNibble02", () => {
    it("names all-present, an inline coding, or a shared field", () => {
        expect(parsePresenceNibble02(0, 0)).toEqual({ kind: "all" });
        expect(parsePresenceNibble02(1, 0)).toEqual({ kind: "inline", coding: "bitmap" });
        expect(parsePresenceNibble02(2, 0)).toEqual({ kind: "inline", coding: "runs" });
        expect(parsePresenceNibble02(3, 0)).toEqual({ kind: "inline", coding: "sparse" });
        expect(parsePresenceNibble02(4, 1)).toEqual({ kind: "shared", index: 0 });
        expect(parsePresenceNibble02(10, 7)).toEqual({ kind: "shared", index: 6 });
    });

    it("rejects a shared index past the declared count and the reserved nibbles", () => {
        expect(() => parsePresenceNibble02(4, 0)).toThrow();
        expect(() => parsePresenceNibble02(6, 2)).toThrow();
        expect(() => parsePresenceNibble02(11, 7)).toThrow();
        expect(() => parsePresenceNibble02(15, 7)).toThrow();
    });
});

describe("readSharedPresence02", () => {
    it("reads plain bitmaps back to back when the layout byte names no encodings", () => {
        const offset = new IntWrapper(0);
        const fields = readSharedPresence02(new Uint8Array([0x01, 0x02, 0xff]), offset, 2, false, 4);
        expect(fields.map(presentCount)).toEqual([1, 1]);
        expect(offset.get()).toBe(2);
    });

    it("reads a coding byte before each field when the layout byte's flag is set", () => {
        const offset = new IntWrapper(0);
        const tile = new Uint8Array([0x10, 0x01, 0x03, 0x00, 0x05, 0x20, 0x01, 0x01]);
        const fields = readSharedPresence02(tile, offset, 3, true, 4);
        expect(fields.map(presentCount)).toEqual([3, 2, 1]);
        expect(fields[2].get(0)).toBe(true);
        expect(offset.get()).toBe(8);
    });

    it("rejects a coding byte with a count bit, physical or extension bits, or an unknown code", () => {
        for (const byte of [0x80, 0x04, 0x01, 0x30]) {
            const offset = new IntWrapper(0);
            expect(() => readSharedPresence02(new Uint8Array([byte, 0x00]), offset, 1, true, 4)).toThrow();
        }
    });
});

describe("readBoolStream02", () => {
    it("reads a bool stream's payload in the coding its header names", () => {
        const tile = new Uint8Array([0x10, 0x02, 0x03, 0x01]);
        const offset = new IntWrapper(0);
        const header = readStreamHeader02(tile, offset, "bool", 6);
        const vector = readBoolStream02(tile, offset, header);
        expect(Array.from({ length: 6 }, (_, i) => vector.get(i))).toEqual([F, F, T, T, T, F]);
        expect(offset.get()).toBe(4);
    });

    it("takes the explicit count when the header carries one", () => {
        const tile = new Uint8Array([0xa0, 0x18, 0x02, 0x2d]);
        const offset = new IntWrapper(0);
        const header = readStreamHeader02(tile, offset, "bool", 1);
        expect(presentCount(readBoolStream02(tile, offset, header))).toBe(4);
    });

    it("rejects a header of another family", () => {
        const tile = new Uint8Array([0x00, 0x00]);
        const offset = new IntWrapper(0);
        const header = readStreamHeader02(tile, offset, "int32", 0);
        expect(() => readBoolStream02(tile, offset, header)).toThrow();
    });
});
