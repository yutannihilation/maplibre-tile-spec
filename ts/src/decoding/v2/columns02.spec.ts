import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import decodeTile from "../../mltDecoder";
import { featureTablesToFeatureCollection } from "../../vector/featureTablesToGeoJson";
import { DoubleFlatVector } from "../../vector/flat/doubleFlatVector";
import { Int32FlatVector } from "../../vector/flat/int32FlatVector";
import { Int64FlatVector } from "../../vector/flat/int64FlatVector";

const SYNTHETIC = resolve(__dirname, "../../../../test/synthetic/0x02");

function fixture(name: string): { tile: Uint8Array; expected: GeoJSON.FeatureCollection } {
    return {
        tile: new Uint8Array(readFileSync(resolve(SYNTHETIC, `${name}.mlt`))),
        expected: JSON.parse(readFileSync(resolve(SYNTHETIC, `${name}.json`), "utf-8")),
    };
}

function varint(value: number): number[] {
    const out: number[] = [];
    while (value >= 0x80) {
        out.push((value & 0x7f) | 0x80);
        value >>>= 7;
    }
    out.push(value);
    return out;
}

/** A tile holding one v2 block around `body`. */
function tile(body: number[]): Uint8Array {
    return new Uint8Array([...varint(body.length + 1), 0x02, ...body]);
}

/** A uniform-Point layer of `count` features at (0, 0), followed by `columns`. */
function pointLayer(count: number, columnCount: number, columns: number[]): Uint8Array {
    const name = [0x06, ...Buffer.from("layer1")];
    const vertices = [0x28, count * 2, ...new Array<number>(count * 2).fill(0)];
    return tile([...name, 0x10, count, 0x00, ...vertices, columnCount, ...columns]);
}

describe("decodeColumns02 - id fixtures", () => {
    it.each([
        "id",
        "ids",
        "ids_opt",
        "ids_opt_delta",
        "ids_rle",
        "ids_delta_rle",
        "id_min",
        "id_max",
        "id_max_delta_rle",
        "id64",
        "id64_max",
        "ids64",
        "ids64_minmax_delta",
        "ids64_opt_delta",
        "ids64_rle",
    ])("decodes %s like the reference", (name) => {
        const { tile, expected } = fixture(name);
        expect(featureTablesToFeatureCollection(decodeTile(tile, undefined, false))).toEqual(expected);
    });

    it("keeps 64-bit ids exact as bigint, or narrows them to number on request", () => {
        const { tile } = fixture("id64_max");
        expect(decodeTile(tile, undefined, false)[0].idVector).toBeInstanceOf(Int64FlatVector);
        expect(decodeTile(tile, undefined, false)[0].idVector.getValue(0)).toBe(18446744073709551615n);
        const narrowed = decodeTile(tile, undefined, true)[0].idVector;
        expect(narrowed).toBeInstanceOf(DoubleFlatVector);
        expect(narrowed.getValue(0)).toBe(18446744073709552000);
    });

    it("marks absent ids and keeps the others at their feature", () => {
        const [table] = decodeTile(fixture("ids_opt").tile);
        expect(table.idVector).toBeInstanceOf(Int32FlatVector);
        expect([0, 1, 2, 3, 4].map((i) => table.idVector.getValue(i))).toEqual([100, 101, null, 105, 106]);
        expect(table.getFeatures().map((f) => f.id)).toEqual([100, 101, undefined, 105, 106]);
    });
});

describe("decodeColumns02 - column headers", () => {
    it("rejects a second id column", () => {
        // two Id columns, each one raw word with the byte length omitted
        const columns = [0x00, 0x00, 1, 0, 0, 0, 0x00, 0x00, 2, 0, 0, 0];
        expect(() => decodeTile(pointLayer(1, 2, columns))).toThrow(/at most one id/);
    });

    it("rejects an id stream whose explicit count disagrees with the presence", () => {
        // inline bitmap presence 0b01 over two features, but two ids
        const columns = [0x10, 0x01, 0x88, 0x02, 0x02, 0x01, 0x02];
        expect(() => decodeTile(pointLayer(2, 1, columns))).toThrow(/present features/);
    });

    it("reads a shared presence field through the nibble", () => {
        const name = [0x06, ...Buffer.from("layer1")];
        // one shared bitmap 0b10 over two features; Id column with nibble 4 = shared field 0; one id 7
        const body = [...name, 0x10, 0x02, 0x10, 0x02, 0x28, 0x04, 0, 0, 0, 0, 0x01, 0x40, 0x08, 0x01, 0x07];
        const [table] = decodeTile(tile(body));
        expect([0, 1].map((i) => table.idVector.getValue(i))).toEqual([null, 7]);
    });

    it("rejects what later steps decode, rather than reading past it", () => {
        expect(() => decodeTile(pointLayer(1, 1, [0x05, 0x01, 0x61, 0x00]))).toThrow(/not supported/);
        expect(() => decodeTile(pointLayer(1, 1, [0x0f, 0x01, 0x61, 0x00]))).toThrow(/not supported/);
    });
});
