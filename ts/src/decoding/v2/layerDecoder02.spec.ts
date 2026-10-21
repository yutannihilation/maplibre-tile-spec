import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import decodeTile from "../../mltDecoder";
import { featureTablesToFeatureCollection } from "../../vector/featureTablesToGeoJson";
import { GEOMETRY_TYPE } from "../../vector/geometry/geometryType";

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

const le32 = (...words: number[]) => words.flatMap((w) => [w & 0xff, (w >>> 8) & 0xff, (w >>> 16) & 0xff, w >>> 24]);

/** A tile holding one v2 block around `body`. */
function tile(body: number[]): Uint8Array {
    return new Uint8Array([...varint(body.length + 1), 0x02, ...body]);
}

const NAME = [0x06, ...Buffer.from("layer1")];

describe("decodeLayer02 - fixtures", () => {
    it.each(["point", "mix_2_pt_pt"])("decodes %s like the reference", (name) => {
        const { tile, expected } = fixture(name);
        const tables = decodeTile(tile, undefined, false);
        expect(featureTablesToFeatureCollection(tables)).toEqual(expected);
    });

    it("exposes the layer name, extent and feature count", () => {
        const [table] = decodeTile(fixture("mix_2_pt_pt").tile);
        expect(table.name).toBe("layer1");
        expect(table.extent).toBe(64);
        expect(table.numFeatures).toBe(2);
        expect(table.idVector).toBeUndefined();
        expect(table.propertyVectors).toEqual([]);
        expect(table.geometryVector.geometryType(1)).toBe(GEOMETRY_TYPE.POINT);
    });
});

describe("decodeLayer02 - layer header", () => {
    it("decodes the extent nibble as a power of two from 64", () => {
        // uniform Point, extent code 3 = 512; one raw (x, y) pair with its byte length omitted
        // raw vertex words are zigzag-coded: (1, 2) is stored as (2, 4)
        const body = [...NAME, 0x13, 0x01, 0x00, 0x00, ...le32(2, 4), 0x00];
        const [table] = decodeTile(tile(body));
        expect(table.extent).toBe(512);
        expect(table.getFeatures()[0].geometry.coordinates[0][0]).toMatchObject({ x: 1, y: 2 });
        expect(decodeTile(tile([...NAME, 0x1f, 0x00, 0x00, 0x00, 0x00]))[0].extent).toBe(2097152);
    });

    it("reads a types stream when the header names no uniform type", () => {
        // two features, types stream of raw words [0, 0], then two delta-coded vertices
        const body = [...NAME, 0x00, 0x02, 0x00, 0x00, ...le32(0, 0), 0x18, 0x04, 2, 4, 2, 4, 0x00];
        const features = decodeTile(tile(body))[0].getFeatures();
        expect(features.map((f) => f.geometry.type)).toEqual([GEOMETRY_TYPE.POINT, GEOMETRY_TYPE.POINT]);
        // delta on a vertex stream is one running sum over every word
        expect(features[1].geometry.coordinates[0][0]).toMatchObject({ x: 4, y: 6 });
    });

    it("rejects an empty name, the reserved uniform type, and a bad layout byte", () => {
        expect(() => decodeTile(tile([0x00, 0x10, 0x00, 0x00, 0x00, 0x00]))).toThrow(/name/);
        expect(() => decodeTile(tile([...NAME, 0x70, 0x00, 0x00, 0x00, 0x00]))).toThrow(/reserved/);
        expect(() => decodeTile(tile([...NAME, 0x10, 0x00, 0x0e, 0x00, 0x00]))).toThrow(/layout/);
        expect(() => decodeTile(tile([...NAME, 0x10, 0x00, 0x80, 0x00, 0x00]))).toThrow(/shared/);
    });

    it("rejects an m-value section on a point layer", () => {
        expect(() => decodeTile(tile([...NAME, 0x90, 0x00, 0x00, 0x00, 0x01]))).toThrow(/m-value/);
    });

    it("rejects a types stream naming a type the layout cannot hold", () => {
        const body = [...NAME, 0x00, 0x01, 0x00, 0x00, ...le32(1), 0x00, ...le32(1, 2), 0x00];
        expect(() => decodeTile(tile(body))).toThrow(/type/);
    });

    it("rejects bytes left over after the column count", () => {
        expect(() => decodeTile(tile([...NAME, 0x10, 0x00, 0x00, 0x00, 0x00, 0x00]))).toThrow(/trailing/i);
    });

    it("rejects what later steps decode, rather than reading past it", () => {
        // a Lines layout
        expect(() => decodeTile(tile([...NAME, 0x20, 0x00, 0x04, 0x00, 0x00, 0x00]))).toThrow(/not supported/);
        // one counted column
        expect(() => decodeTile(tile([...NAME, 0x10, 0x00, 0x00, 0x00, 0x01, 0x05]))).toThrow(/not supported/);
    });
});

describe("decodeLayer02 - vertex encodings", () => {
    const cases: [string, number[]][] = [
        ["raw", [0x00, ...le32(26, 84, 28, 88)]],
        ["delta", [0x18, 0x04, 26, 58, 55, 60]],
        ["componentwise delta", [0x28, 0x04, 26, 84, 2, 4]],
    ];
    it.each(cases)("decodes %s pairs", (_label, vertices) => {
        const body = [...NAME, 0x10, 0x02, 0x00, ...vertices, 0x00];
        const coords = decodeTile(tile(body))[0]
            .getFeatures()
            .map((f) => f.geometry.coordinates[0][0]);
        expect(coords).toMatchObject([
            { x: 13, y: 42 },
            { x: 14, y: 44 },
        ]);
    });

    it("scales vertices to the requested extent", () => {
        const body = [...NAME, 0x10, 0x01, 0x00, 0x00, ...le32(26, 84), 0x00];
        const [table] = decodeTile(tile(body), { extent: 4096, min: 0, max: 4096 });
        expect(table.getFeatures()[0].geometry.coordinates[0][0]).toMatchObject({ x: 832, y: 2688 });
    });

    it("decodes a layer with no features", () => {
        const [table] = decodeTile(tile([...NAME, 0x10, 0x00, 0x00, 0x00, 0x00]));
        expect(table.numFeatures).toBe(0);
        expect(table.getFeatures()).toEqual([]);
    });
});

describe("decodeTile - mixed versions", () => {
    it("decodes a v2 block beside a skipped block and keeps the order", () => {
        const v2 = fixture("point").tile;
        const unknown = [0x02, 0x07, 0x00];
        const tables = decodeTile(new Uint8Array([...unknown, ...v2]));
        expect(tables.map((t) => t.name)).toEqual(["layer1"]);
    });
});
