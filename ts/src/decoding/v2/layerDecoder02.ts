import type IntWrapper from "../intWrapper";
import type GeometryScaling from "../geometryScaling";
import FeatureTable from "../../vector/featureTable";
import type { GEOMETRY_TYPE } from "../../vector/geometry/geometryType";
import { readString02, readU8, readVarint32, readVarint64 } from "./bytes02";
import { decodeColumns02, decodeMValueColumns02 } from "./columns02";
import { featureVertexCounts } from "../../vector/geometry/vertexSequence";
import type { MValueColumn } from "../../vector/mValueColumn";
import { allowsMValues, decodeGeometry02, type GeoLayout02, parseGeoLayout02 } from "./geometry02";
import { readSharedPresence02 } from "./presence02";

export interface DecodeOptions02 {
    geometryScaling?: GeometryScaling;
    /** Returns ids as `number` when they fit in 53 bits, otherwise as `bigint`. */
    idWithinMaxSafeInteger: boolean;
}

/** The layer header byte (`docs/specification/v2.md#layer-header-byte`). */
export interface LayerHeader02 {
    /** An m-value section ends the body. */
    mValues: boolean;
    /** The one geometry type every feature has, or undefined when a types stream leads the geometry. */
    uniformType: GEOMETRY_TYPE | undefined;
    extent: number;
}

/** The layer layout byte (`docs/specification/v2.md#layer-layout-byte`). */
export interface LayerLayout02 {
    /** Each shared presence field leads with the byte naming its coding. */
    sharedCoded: boolean;
    sharedPresence: number;
    geometry: GeoLayout02;
}

const MAX_UNIFORM_TYPE_CODE = 6;
const EXTENT_EXPONENT_OFFSET = 6;

export function parseLayerHeader02(byte: number): LayerHeader02 {
    const typeCode = (byte & 0x70) >> 4;
    if (typeCode > MAX_UNIFORM_TYPE_CODE) {
        throw new Error(`Layer header byte 0x${byte.toString(16)} names the reserved uniform geometry type`);
    }
    return {
        mValues: (byte & 0x80) !== 0,
        uniformType: typeCode === 0 ? undefined : typeCode - 1,
        extent: 2 ** ((byte & 0x0f) + EXTENT_EXPONENT_OFFSET),
    };
}

export function parseLayerLayout02(byte: number): LayerLayout02 {
    const sharedCoded = (byte & 0x80) !== 0;
    const sharedPresence = (byte & 0x70) >> 4;
    if (sharedCoded && sharedPresence === 0) {
        throw new Error(
            `Layer layout byte 0x${byte.toString(16)} flags shared presence encodings but declares no shared field`,
        );
    }
    return { sharedCoded, sharedPresence, geometry: parseGeoLayout02(byte & 0x0f) };
}

/**
 * The column counts varint (`docs/specification/v2.md#column-counts`): the counted columns alone,
 * or, with the header's m-value bit, the Morton code of the counted and m-value column counts.
 */
export function readColumnCounts02(
    tile: Uint8Array,
    offset: IntWrapper,
    mValues: boolean,
): { columns: number; mValues: number } {
    if (!mValues) {
        return { columns: readVarint32(tile, offset, "Column count"), mValues: 0 };
    }
    const code = readVarint64(tile, offset, "Column counts");
    let columns = 0;
    let mValueColumns = 0;
    for (let bit = 0; bit < 32; bit++) {
        columns |= Number((code >> BigInt(2 * bit)) & 1n) << bit;
        mValueColumns |= Number((code >> BigInt(2 * bit + 1)) & 1n) << bit;
    }
    if (mValueColumns === 0) {
        throw new Error("The header's m-value bit is set but the column counts name no m-value column");
    }
    return { columns: columns >>> 0, mValues: mValueColumns >>> 0 };
}

/**
 * Decodes one MLT v2 layer body (a block with tag `0x02`) into a `FeatureTable`.
 *
 * `offset` points at the first byte after the tag, and the body must end exactly at `blockEnd`.
 * What a later step decodes is rejected rather than skipped, so a layer is never partially read.
 */
export function decodeLayer02(
    tile: Uint8Array,
    offset: IntWrapper,
    blockEnd: number,
    options: DecodeOptions02,
): FeatureTable {
    const name = readString02(tile, offset, "Layer name");
    if (name.length === 0) {
        throw new Error("Missing layer name");
    }
    const header = parseLayerHeader02(readU8(tile, offset, "Layer header byte"));
    const featureCount = readVarint32(tile, offset, "Feature count");
    const layout = parseLayerLayout02(readU8(tile, offset, "Layer layout byte"));
    if (header.mValues && !allowsMValues(layout.geometry)) {
        throw new Error("An m-value section needs a geometry layout that gives every feature's vertex count");
    }

    const sharedPresence = readSharedPresence02(tile, offset, layout.sharedPresence, layout.sharedCoded, featureCount);

    const scaling = options.geometryScaling;
    if (scaling) {
        scaling.scale = scaling.extent / header.extent;
    }
    const geometry = decodeGeometry02(tile, offset, header, layout.geometry, featureCount, scaling);

    const counts = readColumnCounts02(tile, offset, header.mValues);
    const ctx = { featureCount, sharedPresence, options };
    const { idVector, propertyVectors, names } = decodeColumns02(tile, offset, counts.columns, ctx);
    let mValueColumns: MValueColumn[] = [];
    if (header.mValues) {
        // The geometry is the only place each feature's vertex count can be read from.
        const vertexCounts = featureVertexCounts(geometry.vector.getGeometries());
        mValueColumns = decodeMValueColumns02(tile, offset, counts.mValues, ctx, names, vertexCounts);
    }

    if (offset.get() !== blockEnd) {
        throw new Error(`Trailing bytes in a v2 layer: body ends at ${offset.get()}, block at ${blockEnd}`);
    }
    return new FeatureTable(
        name,
        geometry.vector,
        idVector,
        propertyVectors,
        header.extent,
        geometry.zStep,
        mValueColumns,
    );
}
