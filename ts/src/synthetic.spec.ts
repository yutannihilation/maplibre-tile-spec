import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { featureTablesToFeatureCollection } from "./vector/featureTablesToGeoJson";
import {
    compareWithTolerance,
    expectUnsupported,
    getTestCases,
    writeActualOutput,
} from "../../test/synthetic/synthetic-test-utils";
import decodeTile from "./mltDecoder";

/**
 * Synthetics the decoder cannot handle yet. These still run: `expectUnsupported` asserts they fail,
 * so an entry that starts decoding correctly fails the test until it is removed from this list.
 * Prefer fixing the decoder over adding to it.
 *
 * The v2 (`0x02`) fixtures are grouped by the decoder feature they need, so each feature can be
 * unlisted on its own as v2 support lands. A trailing `*` matches every fixture with that prefix.
 */
const UNIMPLEMENTED_SYNTHETICS: string[] = [
    // geometry: layouts, vertex dictionary, Morton, tessellation, rANS
    "0x02/point*",
    "0x02/extent_*",
    "0x02/line*",
    "0x02/multiline*",
    "0x02/multipoint*",
    "0x02/poly*",
    "0x02/mix_*",
    // id columns
    "0x02/id*",
    // property columns and presence
    "0x02/prop_*",
    "0x02/props_*",
    "0x02/presence_*",
    "0x02/bool_*",
    // v2-only data: m-values, nested properties, z coordinates
    "0x02/mvalues*",
    "0x02/nested_*",
    "0x02/z_*",
];

describe("MLT Decoder - Synthetic tests", () => {
    expect.addEqualityTesters([compareWithTolerance]);
    const testCases = getTestCases(UNIMPLEMENTED_SYNTHETICS);
    for (const { name, content, fileName } of testCases.active) {
        it(name, async () => {
            const actual = await decodeMLT(fileName);
            writeActualOutput(fileName, actual);
            expect(actual).toEqual(content);
        });
    }

    for (const { name, content, fileName } of testCases.skipped) {
        it(`${name} (unsupported)`, () => expectUnsupported(() => decodeMLT(fileName), content));
    }
});

describe("getTestCases skip list", () => {
    it("matches a trailing-star entry by prefix and keeps the rest active", () => {
        const { active, skipped } = getTestCases(["0x02/prop_f*"]);
        expect(skipped.length).toBeGreaterThan(0);
        expect(skipped.every(({ name }) => name.startsWith("0x02/prop_f"))).toBe(true);
        expect(active.some(({ name }) => name.startsWith("0x02/prop_f"))).toBe(false);
        expect(active.some(({ name }) => name.startsWith("0x02/prop_i"))).toBe(true);
    });

    it("rejects a trailing-star entry that matches nothing", () => {
        expect(() => getTestCases(["0x02/no_such_fixture_*"])).toThrow(/unknown synthetic test/);
    });
});

async function decodeMLT(mltFilePath: string) {
    const mltBuffer = await readFile(mltFilePath);
    const featureTables = decodeTile(mltBuffer, undefined, false);
    return featureTablesToFeatureCollection(featureTables) as unknown as Record<string, unknown>;
}
