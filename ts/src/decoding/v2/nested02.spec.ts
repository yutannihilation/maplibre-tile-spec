import { describe, expect, it } from "vitest";
import decodeTile from "../../mltDecoder";

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

/** A uniform-Point layer of two features at (0, 0) with one counted column, `column`. */
function layer(column: number[]): Uint8Array {
    const name = [0x06, ...Buffer.from("layer1")];
    const body = [...name, 0x10, 0x02, 0x00, 0x28, 0x04, 0, 0, 0, 0, 0x01, ...column];
    return new Uint8Array([...varint(body.length + 1), 0x02, ...body]);
}

/** The values a column named `a` decodes to, one per feature. */
function values(column: number[]): unknown[] {
    return decodeTile(layer(column))[0]
        .getFeatures()
        .map((f) => f.properties.a);
}

const A = [0x01, 0x61];
/** A struct root `a` of `fields` fields. */
const struct = (fields: number, ...body: number[]) => [0x0c, ...A, fields, ...body];
/** A u32 node named `name`, its values raw with the count written when `explicit`. */
const u32 = (name: number[], explicit: boolean, ...words: number[]) => [
    0x06,
    ...name,
    ...(explicit ? [0x80, words.length] : [0x00]),
    ...le32(...words),
];

describe("decodeNestedColumn02", () => {
    it("decodes a struct whose leaf counts are implied", () => {
        expect(values(struct(1, ...u32(A, false, 1, 2)))).toEqual([{ a: 1 }, { a: 2 }]);
    });

    it("decodes a list, its element count the sum of its lengths", () => {
        // lengths 2 and 0, then the element leaf with its count written
        const list = [0x0d, ...A, 0x80, 0x02, ...le32(2, 0), 0x06, 0x80, 0x02, ...le32(5, 6)];
        expect(values(list)).toEqual([[5, 6], []]);
    });

    it("requires written counts at and below a list, and lengths that agree with the element", () => {
        expect(() => values([0x0d, ...A, 0x00, ...le32(2, 0), 0x06, 0x80, 0x02, ...le32(5, 6)])).toThrow(
            /must write its count/,
        );
        expect(() => values([0x0d, ...A, 0x80, 0x02, ...le32(2, 0), 0x06, 0x00, ...le32(5, 6)])).toThrow(
            /must write its count/,
        );
        expect(() => values([0x0d, ...A, 0x80, 0x02, ...le32(2, 0), 0x06, 0x80, 0x01, ...le32(5)])).toThrow(
            /1 values for 2/,
        );
    });

    it("rejects an empty struct, repeated fields, reserved node types and nibbles", () => {
        expect(() => values(struct(0))).toThrow(/no fields/);
        expect(() => values(struct(2, ...u32(A, false, 1, 2), ...u32(A, false, 3, 4)))).toThrow(/repeats field/);
        expect(() => values(struct(1, 0x00, ...A))).toThrow(/cannot be Id/);
        expect(() => values(struct(1, 0x0f, ...A))).toThrow(/cannot be SharedDict/);
        expect(() => values(struct(1, 0x26, ...A))).toThrow(/reserved/);
    });

    it("allows eight levels and rejects a ninth", () => {
        const nest = (levels: number) => [...new Array<number[]>(levels).fill([0x0c, ...A, 0x01]).flat()];
        // the root and six structs below it put the leaf at depth 8
        expect(values(struct(1, ...nest(6), ...u32(A, false, 1, 2)))[0]).toEqual({
            a: { a: { a: { a: { a: { a: { a: 1 } } } } } },
        });
        expect(() => values(struct(1, ...nest(7), ...u32(A, false, 1, 2)))).toThrow(/deeper than 8/);
    });

    it("rejects shape coding on a list and on a leaf", () => {
        expect(() => values([0x0d, ...A, 0x40, 0x80, 0x02, ...le32(2, 0)])).toThrow(/cannot be shape-coded/);
        expect(() => values(struct(1, 0x46, ...A, 0x00, ...le32(1, 2)))).toThrow(/cannot be shape-coded/);
    });
});
