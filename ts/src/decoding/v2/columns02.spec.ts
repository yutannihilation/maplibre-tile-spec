import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import decodeTile from "../../mltDecoder";
import { featureTablesToFeatureCollection } from "../../vector/featureTablesToGeoJson";
import { DoubleFlatVector } from "../../vector/flat/doubleFlatVector";
import { Int32FlatVector } from "../../vector/flat/int32FlatVector";
import { Int64FlatVector } from "../../vector/flat/int64FlatVector";
import { compareWithTolerance } from "../../../../test/synthetic/synthetic-test-utils";

const SYNTHETIC = resolve(__dirname, "../../../../test/synthetic/0x02");

// The fixtures spell NaN and the infinities as strings, which this tester reads back.
expect.addEqualityTesters([compareWithTolerance]);

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
        "ids_fpf",
        "ids_delta_fpf",
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

describe("decodeColumns02 - integer and boolean fixtures", () => {
    it.each([
        "prop_i8",
        "prop_i8_min_np",
        "prop_i8_null_val",
        "prop_u8_max",
        "prop_u8_delta_rle",
        "prop_i32_neg",
        "prop_i32_rle_np",
        "prop_u32_max",
        "prop_i64_min",
        "prop_u64_max_np",
        "prop_u64_delta",
        "props_i32_delta_rle",
        "props_u64",
        "prop_bool",
        "prop_bool_null_true",
        "prop_bool_false_np",
        "bool_runs",
        "bool_sparse",
        "presence_bitmap",
        "presence_runs",
        "presence_sparse",
        "presence_mixed",
        "presence_shared_bitmap",
        "presence_shared_runs",
        "presence_shared_sparse",
        "props_sp",
        "props_sp_id",
        "props_sp_max",
        "props_sp_mixed",
        "prop_empty_name",
        "prop_special_name_np",
    ])("decodes %s like the reference", (name) => {
        const { tile, expected } = fixture(name);
        expect(featureTablesToFeatureCollection(decodeTile(tile, undefined, false))).toEqual(expected);
    });

    it("keeps 64-bit values as bigint and narrow ones as number", () => {
        const [table] = decodeTile(fixture("prop_i64_min").tile);
        expect(table.getPropertyVector("val").getValue(0)).toBe(-9223372036854775808n);
        const [bytes] = decodeTile(fixture("prop_u8_max").tile);
        expect(bytes.getPropertyVector("val").getValue(0)).toBe(255);
    });

    it("rejects a value outside an 8-bit column's range", () => {
        // Int8 column "v", one raw varint word 200 = zigzag of 100... use 0xc8 0x01 = 200 -> zigzag 100: in range;
        // 0x90 0x03 = 400 -> zigzag 200: out of range
        expect(() => decodeTile(pointLayer(1, 1, [0x03, 0x01, 0x76, 0x08, 0x02, 0x90, 0x03]))).toThrow(/range/);
        expect(() => decodeTile(pointLayer(1, 1, [0x04, 0x01, 0x76, 0x08, 0x02, 0x80, 0x02]))).toThrow(/range/);
    });

    it("rejects a repeated column name", () => {
        const column = [0x05, 0x01, 0x76, 0x08, 0x01, 0x02];
        expect(() => decodeTile(pointLayer(1, 2, [...column, ...column]))).toThrow(/repeated/);
    });

    it("places boolean values at their features around the absent ones", () => {
        const [table] = decodeTile(fixture("prop_bool_null_true").tile);
        const flags = table.getPropertyVector("val");
        expect([0, 1].map((i) => flags.getValue(i))).toEqual([null, true]);
    });
});

describe("decodeColumns02 - float fixtures", () => {
    it.each([
        "prop_f32",
        "prop_f32_np",
        "prop_f32_null_val",
        "prop_f32_alp_np",
        "prop_f32_alp_whole_np",
        "prop_f32_dict_nan_np",
        "prop_f32_dict_distinct_np",
        "prop_f32_neg_zero_np",
        "prop_f32_min_norm",
        "prop_f64",
        "prop_f64_alp_np",
        "prop_f64_alp_whole_np",
        "prop_f64_dict_zeros_np",
        "prop_f64_max",
        "prop_f64_nan",
        "prop_f64_pos_inf_np",
        "prop_f64_val_null",
        "prop_f64_alp_offset_np",
    ])("decodes %s like the reference", (name) => {
        const { tile, expected } = fixture(name);
        expect(featureTablesToFeatureCollection(decodeTile(tile, undefined, false))).toEqual(expected);
    });

    it("keeps singles single and -0.0 signed", () => {
        const [table] = decodeTile(fixture("prop_f32_np").tile);
        expect(table.getPropertyVector("val").getValue(0)).toBe(Math.fround(3.14));
        const [zeros] = decodeTile(fixture("prop_f32_neg_zero_np").tile);
        expect(Object.is(zeros.getPropertyVector("val").getValue(0), -0)).toBe(true);
    });
});

describe("decodeColumns02 - string fixtures", () => {
    it.each([
        "prop_str_ascii",
        "prop_str_empty_val",
        "prop_str_escape_np",
        "prop_str_null_val",
        "prop_str_unicode",
        "prop_str_val_empty",
        "props_str_plain",
        "props_str_plain_nulls",
        "props_str_dict",
        "props_str_dict_bp_np",
        "props_str_dict_nulls",
        "props_str_front_dict",
        "props_str_front_dict_nulls",
        "props_str_fsst",
        "props_str_fsst_nulls",
        "props_str_fsst_dict_np",
        "props_str_fsst_dict_nulls",
        "props_str_fsst_front_dict",
        "props_str_fsst_front_dict_nulls",
        "props_mixed",
        "props_mixed_np",
    ])("decodes %s like the reference", (name) => {
        const { tile, expected } = fixture(name);
        expect(featureTablesToFeatureCollection(decodeTile(tile, undefined, false))).toEqual(expected);
    });
});

describe("decodeColumns02 - shared dictionary fixtures", () => {
    it.each([
        "props_shared_dict_bp",
        "props_shared_dict_sp",
        "props_shared_dict_sp_lonely",
        "props_shared_dict_sp_mixed",
    ])("decodes %s like the reference", (name) => {
        const { tile, expected } = fixture(name);
        expect(featureTablesToFeatureCollection(decodeTile(tile, undefined, false))).toEqual(expected);
    });

    it("names each child by the group's prefix and keeps one dictionary for all of them", () => {
        const [table] = decodeTile(fixture("props_shared_dict_bp").tile);
        expect(table.propertyVectors.map((v) => v.name)).toEqual(["name:de", "name:en"]);
        expect(table.getPropertyVector("name:en").getValue(0)).toBe("AAAAAAAAAAAAAAAAAAAAAAAAAAAA_zone_1");
    });

    it("rejects a reserved kind, a child that is not a string, and codes without the dictionary layout", () => {
        const dict = [0x88, 0x01, 0x01, 0x02, 0x04, 0x02, 0x68, 0x69];
        expect(() => decodeTile(pointLayer(1, 1, [0x2f, 0x02, 0x6e, 0x3a, 0x00, ...dict]))).toThrow(/reserved/);
        const child = [0x05, 0x02, 0x64, 0x65, 0x09, 0x01, 0x00];
        expect(() => decodeTile(pointLayer(1, 1, [0x0f, 0x02, 0x6e, 0x3a, 0x01, ...dict, ...child]))).toThrow(
            /not a string/,
        );
        const plainChild = [0x0b, 0x02, 0x64, 0x65, 0x08, 0x01, 0x00];
        expect(() => decodeTile(pointLayer(1, 1, [0x0f, 0x02, 0x6e, 0x3a, 0x01, ...dict, ...plainChild]))).toThrow(
            /dictionary codes/,
        );
    });

    it("rejects a child name that another column already holds", () => {
        const dict = [0x88, 0x01, 0x01, 0x02, 0x04, 0x02, 0x68, 0x69];
        const child = [0x0b, 0x02, 0x64, 0x65, 0x09, 0x01, 0x00];
        const before = [0x05, 0x04, 0x6e, 0x3a, 0x64, 0x65, 0x08, 0x01, 0x02];
        const columns = [...before, 0x0f, 0x02, 0x6e, 0x3a, 0x01, ...dict, ...child];
        expect(() => decodeTile(pointLayer(1, 2, columns))).toThrow(/repeated/);
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
});
