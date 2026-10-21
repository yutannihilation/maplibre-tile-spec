import { describe, expect, it } from "vitest";
import { decodeRansVertices } from "./rans";

/** The spec's example: (100, 200), (105, 210), (102, 215) as one run, at depth 1. */
const EXAMPLE = [
    0x01, 0x63, 0xc1, 0xff, 0x52, 0xe8, 0x00, 0x61, 0x81, 0xf0, 0x00, 0x42, 0x08, 0x04, 0x04, 0x04, 0x04, 0x00, 0x00,
    0x02, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x02, 0x00, 0x00, 0x00, 0x01, 0x00, 0x04, 0x69,
];

const decode = (bytes: number[], runs: number[] | undefined, vertices: number) =>
    Array.from(
        decodeRansVertices(new Uint8Array(bytes), runs === undefined ? undefined : Uint32Array.from(runs), vertices),
    );

describe("decodeRansVertices", () => {
    it("decodes the spec example", () => {
        expect(decode(EXAMPLE, [0, 3], 3)).toEqual([100, 200, 105, 210, 102, 215]);
    });

    it("rejects runs that miss the vertices", () => {
        expect(() => decode(EXAMPLE, [1, 3], 3)).toThrow(/runs do not cover/);
        expect(() => decode(EXAMPLE, [0, 5, 3], 3)).toThrow(/runs do not cover/);
    });

    it("rejects a state that does not end on the initial state, and an unread refill word", () => {
        const wrongState = [...EXAMPLE];
        wrongState[21] = 0x01;
        expect(() => decode(wrongState, [0, 3], 3)).toThrow(/initial state/);
        const extraWord = [
            ...EXAMPLE.slice(0, 13),
            0x06,
            0x04,
            0x04,
            0x04,
            ...EXAMPLE.slice(17, 21),
            0x00,
            0x00,
            ...EXAMPLE.slice(21),
        ];
        expect(() => decode(extraWord, [0, 3], 3)).toThrow(/initial state/);
    });

    it("rejects raw bits of the wrong length", () => {
        expect(() => decode([...EXAMPLE, 0x00], [0, 3], 3)).toThrow(/raw bits length/);
        expect(() => decode(EXAMPLE.slice(0, -1), [0, 3], 3)).toThrow(/raw bits length/);
    });

    it("rejects a malformed layout", () => {
        expect(() => decode([], [0], 0)).toThrow(/empty/);
        expect(() => decode([3, 0, 0], [0], 0)).toThrow(/depth/);
        expect(() => decode([0], [0], 0)).toThrow(/tables truncated/);
        expect(() => decode([0, 0, 0], [0], 0)).toThrow(/lane lengths truncated/);
        expect(() => decode([0, 0, 0, 4, 4, 4, 4, ...new Array<number>(15).fill(0)], [0], 0)).toThrow(
            /lanes truncated/,
        );
        expect(() => decode([0, 0, 0, 2, 4, 4, 4, ...new Array<number>(14).fill(0)], [0], 0)).toThrow(/lane length/);
        expect(() => decode([0, 0, 0, 5, 4, 4, 4, ...new Array<number>(17).fill(0)], [0], 0)).toThrow(/lane length/);
    });

    it("rejects a symbol from a context without a table", () => {
        // every context absent, four lanes at the initial state, one vertex
        const bytes = [0, 0, 0, 4, 4, 4, 4, ...[0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0]];
        expect(() => decode(bytes, [0, 1], 1)).toThrow(/missing table/);
    });
});
