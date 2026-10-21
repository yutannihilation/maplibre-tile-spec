import { describe, expect, it } from "vitest";
import IntWrapper from "../intWrapper";
import BitVector from "../../vector/flat/bitVector";
import { decodeStringColumn02 } from "./stringStream02";

function decode(bytes: number[], count: number, presence?: BitVector) {
    const tile = new Uint8Array(bytes);
    const offset = new IntWrapper(0);
    const size = presence?.size() ?? count;
    const vector = decodeStringColumn02(tile, offset, "s", count, presence, size);
    return { values: Array.from({ length: size }, (_, i) => vector.getValue(i)), end: offset.get() };
}

const utf8 = (s: string) => Array.from(Buffer.from(s));

// FSST symbol table ["ab", "cd"] and the corpus "abcdabz" as 00 01 00 FF 7A
const SYMBOL_LENGTHS = [0x88, 0x02, 0x02, 2, 2];
const SYMBOLS = [0x04, 0x04, ...utf8("abcd")];
const CORPUS = [0x04, 0x05, 0x00, 0x01, 0x00, 0xff, 0x7a];

describe("decodeStringColumn02 - plain", () => {
    it("splits the values blob by the lengths", () => {
        const bytes = [0x08, 0x02, 2, 3, 0x04, 0x05, ...utf8("hiyes")];
        expect(decode(bytes, 2)).toEqual({ values: ["hi", "yes"], end: 11 });
    });

    it("keeps absent features empty around the present ones", () => {
        const presence = new BitVector(new Uint8Array([0b0101]), 4);
        const bytes = [0x08, 0x02, 2, 3, 0x04, 0x05, ...utf8("hiyes")];
        expect(decode(bytes, 2, presence).values).toEqual(["hi", null, "yes", null]);
    });

    it("rejects lengths that do not sum to the blob, and a front-coded values blob", () => {
        expect(() => decode([0x08, 0x02, 2, 2, 0x04, 0x05, ...utf8("hiyes")], 2)).toThrow(/bytes/);
        expect(() => decode([0x08, 0x02, 0, 2, 0x14, 0x02, ...utf8("hi")], 2)).toThrow(/front-coded/);
    });
});

describe("decodeStringColumn02 - dictionary", () => {
    it("looks the codes up in the dictionary that follows", () => {
        const bytes = [0x09, 0x03, 1, 0, 1, 0x88, 0x02, 0x02, 2, 3, 0x04, 0x05, ...utf8("hiyes")];
        expect(decode(bytes, 3)).toEqual({ values: ["yes", "hi", "yes"], end: 17 });
    });

    it("rebuilds a front-coded dictionary", () => {
        const bytes = [
            0x09,
            0x03,
            2,
            0,
            1,
            0x88,
            0x06,
            0x06,
            0,
            11,
            2,
            11,
            6,
            10,
            0x14,
            27,
            ...utf8("Main Street Northple Avenue"),
        ];
        expect(decode(bytes, 3).values).toEqual(["Maple Avenue", "Main Street", "Main Street North"]);
    });

    it("rejects a code past the dictionary", () => {
        const bytes = [0x09, 0x01, 2, 0x88, 0x02, 0x02, 2, 3, 0x04, 0x05, ...utf8("hiyes")];
        expect(() => decode(bytes, 1)).toThrow(/past its 2/);
    });
});

describe("decodeStringColumn02 - FSST", () => {
    it("expands the corpus and splits it by the uncompressed lengths", () => {
        const bytes = [0x0a, 0x02, 4, 3, ...SYMBOL_LENGTHS, ...SYMBOLS, ...CORPUS];
        expect(decode(bytes, 2)).toEqual({ values: ["abcd", "abz"], end: 22 });
    });

    it("rejects a corpus naming a missing symbol, one ending on an escape, and too many symbols", () => {
        const missing = [0x0a, 0x01, 2, ...SYMBOL_LENGTHS, ...SYMBOLS, 0x04, 0x01, 0x05];
        expect(() => decode(missing, 1)).toThrow(/symbol 5/);
        const escape = [0x0a, 0x01, 2, ...SYMBOL_LENGTHS, ...SYMBOLS, 0x04, 0x02, 0x00, 0xff];
        expect(() => decode(escape, 1)).toThrow(/escape/);
        const many = [
            0x0a,
            0x01,
            0,
            0x88,
            0x80,
            0x02,
            0x80,
            0x02,
            ...new Array<number>(256).fill(0),
            0x04,
            0x00,
            0x04,
            0x00,
        ];
        expect(() => decode(many, 1)).toThrow(/at most 255/);
    });
});

describe("decodeStringColumn02 - FSST dictionary", () => {
    it("reads codes into an FSST-compressed dictionary, decoded on first access", () => {
        const bytes = [0x0b, 0x02, 1, 0, 0x88, 0x02, 0x02, 4, 3, ...SYMBOL_LENGTHS, ...SYMBOLS, ...CORPUS];
        expect(decode(bytes, 2)).toEqual({ values: ["abz", "abcd"], end: 27 });
    });

    it("undoes front coding after FSST", () => {
        // dictionary ["abc", "abd"] front-coded as prefixes [0, 2], suffixes [3, 1]: corpus "abcd"
        const bytes = [
            0x0b,
            0x02,
            1,
            0,
            0x88,
            0x04,
            0x04,
            0,
            2,
            3,
            1,
            ...SYMBOL_LENGTHS,
            ...SYMBOLS,
            0x14,
            0x02,
            0x00,
            0x01,
        ];
        expect(decode(bytes, 2).values).toEqual(["abd", "abc"]);
    });
});
