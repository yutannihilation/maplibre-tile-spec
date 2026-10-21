import { describe, expect, it } from "vitest";
import { decodeTriangleTrees } from "./triangleTrees";

const decode = (symbols: number[], cycles: number[]) =>
    Array.from(decodeTriangleTrees(Uint32Array.from(symbols), Uint32Array.from(cycles)));

describe("decodeTriangleTrees", () => {
    it("rebuilds the spec's example: a triangle, a polygon with a hole, and a second triangle", () => {
        const symbols = [0, 2, 1, 1, 2, 1, 0, 0];
        const cycles = [0, 2, 1, 3, 6, 8, 7, 6, 3, 5, 4, 9, 11, 10];
        expect(decode(symbols, cycles)).toEqual([
            0, 2, 1, 3, 6, 8, 3, 8, 4, 4, 8, 5, 5, 8, 7, 5, 7, 3, 3, 7, 6, 9, 11, 10,
        ]);
    });

    it("decodes no triangles from no symbols and no cycles", () => {
        expect(decode([], [])).toEqual([]);
    });

    it("takes a left-only chain and a right-only chain", () => {
        // root with a left child only: entered across 0 -> 1, apexes [2, 3]: root (0, 1, 3), child entered across 3 -> 1
        expect(decode([1, 0], [0, 1, 2, 3])).toEqual([0, 1, 3, 3, 1, 2]);
        // root with a right child only: apexes [2, 3]: root (0, 1, 2), child entered across 0 -> 2
        expect(decode([2, 0], [0, 1, 2, 3])).toEqual([0, 1, 2, 0, 2, 3]);
    });

    it("rejects a symbol above 3, symbols that end inside a tree, and cycles of the wrong length", () => {
        expect(() => decode([4], [0, 1, 2])).toThrow(/above 3/);
        expect(() => decode([1], [0, 1, 2])).toThrow(/symbols end inside/);
        expect(() => decode([0], [0, 1])).toThrow(/cycles end inside/);
        expect(() => decode([0], [0, 1, 2, 3])).toThrow(/more entries/);
    });
});
