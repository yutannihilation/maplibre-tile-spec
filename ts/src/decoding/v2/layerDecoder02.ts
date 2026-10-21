import type IntWrapper from "../intWrapper";
import type GeometryScaling from "../geometryScaling";
import type FeatureTable from "../../vector/featureTable";

export interface DecodeOptions02 {
    geometryScaling?: GeometryScaling;
    /** Returns ids as `number` when they fit in 53 bits, otherwise as `bigint`. */
    idWithinMaxSafeInteger: boolean;
}

/**
 * Decodes one MLT v2 layer body (a block with tag `0x02`) into a `FeatureTable`.
 *
 * `offset` points at the first byte after the tag, and the body ends exactly at `blockEnd`.
 *
 * Not implemented yet: v2 support lands step by step, and until a layer can be decoded in full
 * the tile is rejected rather than partially read.
 */
export function decodeLayer02(
    _tile: Uint8Array,
    offset: IntWrapper,
    blockEnd: number,
    _options: DecodeOptions02,
): FeatureTable {
    throw new Error(`MLT v2 layer at byte ${offset.get()}..${blockEnd} is not supported by this decoder yet`);
}
