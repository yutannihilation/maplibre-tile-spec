import { describe, expect, it } from "vitest";
import IntWrapper from "../intWrapper";
import { type Family02, readStreamHeader02, type StreamHeader02 } from "./streamHeader02";

function read(bytes: number[], family: Family02, impliedCount?: number): { header: StreamHeader02; end: number } {
    const offset = new IntWrapper(0);
    const header = readStreamHeader02(new Uint8Array(bytes), offset, family, impliedCount);
    return { header, end: offset.get() };
}

function expectReject(bytes: number[], family: Family02, impliedCount?: number): void {
    expect(() => read(bytes, family, impliedCount)).toThrow();
}

describe("readStreamHeader02 - integer family", () => {
    it("reads raw words without a byte length when the physical field is 00", () => {
        const { header, end } = read([0x00], "int32", 3);
        expect(header).toMatchObject({
            family: "int32",
            logical: "none",
            physical: "none",
            explicitCount: false,
            numValues: 3,
            byteLength: 12,
            wordsPerValue: 1,
        });
        expect(end).toBe(1);
    });

    it("sizes 64-bit raw words by their width", () => {
        expect(read([0x00], "int64", 2).header.byteLength).toBe(16);
    });

    it("reads a byte length when the physical field is 01", () => {
        const { header, end } = read([0x04, 0x07], "int32", 5);
        expect(header).toMatchObject({ logical: "none", physical: "none", numValues: 5, byteLength: 7 });
        expect(end).toBe(2);
    });

    it("reads an explicit count before the byte length", () => {
        // 0x88: count bit, logical None, physical VarInt; count 300 = AC 02; byte length 5
        const { header, end } = read([0x88, 0xac, 0x02, 0x05], "int32", 1);
        expect(header).toMatchObject({ explicitCount: true, numValues: 300, byteLength: 5, physical: "varint" });
        expect(end).toBe(4);
    });

    it("maps the logical codes of the family", () => {
        expect(read([0x1c, 0x01], "int32", 1).header).toMatchObject({ logical: "delta", physical: "fastPfor" });
        expect(read([0x20, 0x02], "int32", 1).header).toMatchObject({ logical: "rle", physical: "implied" });
        expect(read([0x30, 0x02], "int32", 1).header).toMatchObject({ logical: "deltaRle", physical: "implied" });
        expect(read([0x40, 0x02], "int32", 1).header).toMatchObject({ logical: "bitPacked", physical: "implied" });
        expect(read([0x58, 0x02], "int32", 1).header).toMatchObject({ logical: "delta2", physical: "varint" });
    });

    it("rejects a logical code the family does not have", () => {
        expectReject([0x60, 0x00], "int32", 1);
        expectReject([0x70, 0x00], "int32", 1);
    });

    it("rejects extension bits, which only string and vertex streams assign", () => {
        expectReject([0x01], "int32", 1);
        expectReject([0x06, 0x00], "int32", 1);
    });

    it("rejects physical 00 on a transformed stream, which needs its byte length", () => {
        expectReject([0x10], "int32", 1);
        expectReject([0x50], "int32", 1);
    });

    it("rejects a physical field on encodings that define their own layout", () => {
        expectReject([0x24, 0x00], "int32", 1);
        expectReject([0x38, 0x00], "int32", 1);
        expectReject([0x44, 0x00], "int32", 1);
    });

    it("rejects a stream without a count when the context implies none", () => {
        expectReject([0x00], "int32");
        expect(read([0x80, 0x02], "int32").header.numValues).toBe(2);
    });
});

describe("readStreamHeader02 - bool family", () => {
    it("names the three presence codings and never reads a byte length", () => {
        expect(read([0x00], "bool", 9).header).toMatchObject({
            logical: "bitmap",
            physical: "implied",
            numValues: 9,
            byteLength: undefined,
        });
        expect(read([0x10], "bool", 9).header.logical).toBe("runs");
        expect(read([0x20], "bool", 9).header.logical).toBe("sparse");
        expect(read([0x20], "bool", 9).end).toBe(1);
    });

    it("takes an explicit count", () => {
        const { header, end } = read([0x90, 0x40], "bool", 9);
        expect(header).toMatchObject({ logical: "runs", explicitCount: true, numValues: 64 });
        expect(end).toBe(2);
    });

    it("rejects physical or extension bits and unknown codes", () => {
        expectReject([0x04], "bool", 1);
        expectReject([0x01], "bool", 1);
        expectReject([0x30], "bool", 1);
    });
});

describe("readStreamHeader02 - float family", () => {
    it("sizes raw values by the column width when the byte length is omitted", () => {
        expect(read([0x00], "float32", 3).header).toMatchObject({ logical: "none", byteLength: 12 });
        expect(read([0x00], "float64", 3).header).toMatchObject({ logical: "none", byteLength: 24 });
        expect(read([0x04, 0x09], "float32", 3).header.byteLength).toBe(9);
    });

    it("rejects the unassigned physical patterns and the unused code 1", () => {
        expectReject([0x08, 0x00], "float32", 1);
        expectReject([0x0c, 0x00], "float32", 1);
        expectReject([0x10, 0x00], "float32", 1);
    });

    it("reads ALP's scale byte and zigzag base after the byte length", () => {
        // 0x28: ALP (code 2) over VarInt; byte length 4; scale 3 = (e 2, f 0); base -225 = zigzag 449 = C1 03
        const { header, end } = read([0x28, 0x04, 0x03, 0xc1, 0x03], "float64", 4);
        expect(header).toMatchObject({ logical: "alp", physical: "varint", byteLength: 4 });
        expect(header.alp).toEqual({ e: 2, f: 0, base: -225n });
        expect(end).toBe(5);
    });

    it("decodes every valid ALP scale byte and rejects the rest", () => {
        expect(read([0x28, 0x00, 0x00, 0x00], "float32", 1).header.alp).toMatchObject({ e: 0, f: 0 });
        expect(read([0x28, 0x00, 0x01, 0x00], "float32", 1).header.alp).toMatchObject({ e: 1, f: 0 });
        expect(read([0x28, 0x00, 0x02, 0x00], "float32", 1).header.alp).toMatchObject({ e: 1, f: 1 });
        expect(read([0x28, 0x00, 189, 0x00], "float32", 1).header.alp).toMatchObject({ e: 18, f: 18 });
        expectReject([0x28, 0x00, 190, 0x00], "float32", 1);
    });

    it("reads a float dictionary's codes stream with its own physical encoding", () => {
        expect(read([0x3c, 0x02], "float32", 1).header).toMatchObject({ logical: "dict", physical: "fastPfor" });
        expectReject([0x30], "float32", 1);
    });
});

describe("readStreamHeader02 - vertex family", () => {
    it("counts pairs and sizes raw pairs by two words", () => {
        expect(read([0x00], "vertex", 3).header).toMatchObject({
            logical: "none",
            numValues: 3,
            byteLength: 24,
            wordsPerValue: 2,
        });
        expect(read([0x00], "vertex", 3).header.zStep).toBeUndefined();
    });

    it("maps the vertex codes", () => {
        expect(read([0x18, 0x01], "vertex", 1).header).toMatchObject({ logical: "delta", physical: "varint" });
        expect(read([0x28, 0x01], "vertex", 1).header).toMatchObject({ logical: "cwDelta", physical: "varint" });
        expect(read([0x48, 0x01], "vertex", 1).header).toMatchObject({ logical: "cwDelta2", physical: "varint" });
        expect(read([0x50, 0x01], "vertex", 1).header).toMatchObject({ logical: "rans", physical: "implied" });
        expectReject([0x54, 0x01], "vertex", 1);
        expectReject([0x60, 0x01], "vertex", 1);
    });

    it("reads Morton's grid after the byte length and counts one word per code", () => {
        const { header, end } = read([0x38, 0x05, 0x0e, 0x01], "vertex", 2);
        expect(header).toMatchObject({ logical: "morton", physical: "varint", byteLength: 5, wordsPerValue: 1 });
        expect(header.morton).toEqual({ bits: 14, shift: 1 });
        expect(end).toBe(4);
        expectReject([0x38, 0x05, 17, 0x01], "vertex", 2);
    });

    it("reads triples when extension bit 0 is set, with the z step after the byte length", () => {
        // raw triples, byte length omitted, z step code 2 = -1 (decimetres)
        const { header, end } = read([0x01, 0x02], "vertex", 2);
        expect(header).toMatchObject({ logical: "none", numValues: 2, byteLength: 24, wordsPerValue: 3, zStep: -1 });
        expect(end).toBe(2);
        expect(read([0x29, 0x06, 0x00], "vertex", 1).header).toMatchObject({ logical: "cwDelta", zStep: -3 });
        expect(read([0x19, 0x06, 0x07], "vertex", 1).header).toMatchObject({ logical: "delta", zStep: 4 });
    });

    it("rejects z step codes past 7, and Morton, Delta2 and rANS over triples", () => {
        expectReject([0x01, 0x08], "vertex", 1);
        expectReject([0x39, 0x01, 0x00, 0x00, 0x00], "vertex", 1);
        expectReject([0x49, 0x01, 0x00], "vertex", 1);
        expectReject([0x51, 0x01, 0x00], "vertex", 1);
    });

    it("rejects extension bit 1", () => {
        expectReject([0x02], "vertex", 1);
        expectReject([0x03, 0x00], "vertex", 1);
    });
});

describe("readStreamHeader02 - string family", () => {
    it("takes the column layout from the extension bits", () => {
        expect(read([0x00], "str", 2).header).toMatchObject({ strLayout: "plain", logical: "none", byteLength: 8 });
        expect(read([0x09, 0x02], "str", 2).header).toMatchObject({ strLayout: "dict", physical: "varint" });
        expect(read([0x42, 0x02], "str", 2).header).toMatchObject({ strLayout: "fsst", logical: "bitPacked" });
        expect(read([0x1f, 0x02], "str", 2).header).toMatchObject({ strLayout: "fsstDict", physical: "fastPfor" });
    });

    it("applies the integer rules otherwise", () => {
        expectReject([0x61, 0x00], "str", 1);
        expectReject([0x11], "str", 1);
    });
});

describe("readStreamHeader02 - byte blobs", () => {
    it("takes its count from the byte length it always writes", () => {
        const { header, end } = read([0x04, 0x80, 0x01], "bytes");
        expect(header).toMatchObject({ logical: "none", physical: "implied", numValues: 128, byteLength: 128 });
        expect(end).toBe(3);
        expect(read([0x14, 0x03], "bytes").header.logical).toBe("frontCoded");
    });

    it("rejects a count bit, an omitted length and unknown codes", () => {
        expectReject([0x84, 0x01, 0x01], "bytes");
        expectReject([0x00, 0x01], "bytes");
        expectReject([0x08, 0x01], "bytes");
        expectReject([0x24, 0x01], "bytes");
        expectReject([0x05, 0x01], "bytes");
    });
});

describe("readStreamHeader02 - truncated input", () => {
    it("rejects a header cut short", () => {
        expectReject([], "int32", 1);
        expectReject([0x04], "int32", 1);
        expectReject([0x80], "int32", 1);
        expectReject([0x28, 0x04, 0x03], "float32", 1);
    });
});
