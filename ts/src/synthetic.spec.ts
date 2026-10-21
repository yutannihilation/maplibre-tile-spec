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
import { UNIMPLEMENTED_SYNTHETICS_02 } from "./decoding/v2/unimplementedSynthetics02";

/**
 * Synthetics the decoder cannot handle yet. These still run: `expectUnsupported` asserts they fail,
 * so an entry that starts decoding correctly fails the test until it is removed from the list.
 * Prefer fixing the decoder over adding to it.
 */
const UNIMPLEMENTED_SYNTHETICS: string[] = [...UNIMPLEMENTED_SYNTHETICS_02];

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
