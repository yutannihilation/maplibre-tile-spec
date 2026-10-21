import type IntWrapper from "../intWrapper";
import type GeometryScaling from "../geometryScaling";
import { decodeComponentwiseDeltaVec2, decodeZigZagInt32Value } from "../integerDecodingUtils";
import { decodeComponentwiseDelta2Vec2 } from "../delta2";
import {
    decodeLevel1LengthStream,
    decodeLevel1WithoutRingBufferLengthStream,
    decodeLevel2LengthStream,
    decodeRootLengthStream,
} from "../geometryDecoder";
import { GEOMETRY_TYPE } from "../../vector/geometry/geometryType";
import type { GeometryVector } from "../../vector/geometry/geometryVector";
import type { TopologyVector } from "../../vector/geometry/topologyVector";
import { createConstGeometryVector } from "../../vector/geometry/constGeometryVector";
import { createFlatGeometryVector } from "../../vector/geometry/flatGeometryVector";
import { decodeIntStream02, readWords32 } from "./intStream02";
import { readStreamHeader02, type StreamHeader02 } from "./streamHeader02";
import type { LayerHeader02 } from "./layerDecoder02";

/**
 * The v2 geometry section (`docs/specification/v2.md#geometry-section`): the streams the layout
 * nibble declares, in a fixed order, each read against the feature count.
 */

/** The low nibble of the layer layout byte. */
export enum GeoLayout02 {
    Points = 0x0,
    PointsDict = 0x1,
    MultiPoints = 0x2,
    MultiPointsDict = 0x3,
    Lines = 0x4,
    LinesDict = 0x5,
    MultiLines = 0x6,
    MultiLinesDict = 0x7,
    Polygons = 0x8,
    PolygonsDict = 0x9,
    MultiPolygons = 0xa,
    MultiPolygonsDict = 0xb,
    TessPolygons = 0xc,
    TessPolygonsWithOutlines = 0xd,
}

export function parseGeoLayout02(nibble: number): GeoLayout02 {
    if (nibble > GeoLayout02.TessPolygonsWithOutlines) {
        throw new Error(`Geometry layout ${nibble} is unassigned`);
    }
    return nibble;
}

/** Whether the topology gives every feature's vertex count, which an m-value section needs. */
export function allowsMValues(layout: GeoLayout02): boolean {
    return layout !== GeoLayout02.Points && layout !== GeoLayout02.PointsDict && layout !== GeoLayout02.TessPolygons;
}

function hasGeoLengths(layout: GeoLayout02): boolean {
    return (
        (layout >= GeoLayout02.MultiPoints && layout <= GeoLayout02.MultiPointsDict) ||
        (layout >= GeoLayout02.MultiLines && layout <= GeoLayout02.MultiLinesDict) ||
        (layout >= GeoLayout02.MultiPolygons && layout <= GeoLayout02.MultiPolygonsDict) ||
        layout === GeoLayout02.TessPolygonsWithOutlines
    );
}

function hasPartLengths(layout: GeoLayout02): boolean {
    return (
        (layout >= GeoLayout02.Lines && layout <= GeoLayout02.MultiPolygonsDict) ||
        layout === GeoLayout02.TessPolygonsWithOutlines
    );
}

function hasRingLengths(layout: GeoLayout02): boolean {
    return (
        (layout >= GeoLayout02.Polygons && layout <= GeoLayout02.MultiPolygonsDict) ||
        layout === GeoLayout02.TessPolygonsWithOutlines
    );
}

function isDict(layout: GeoLayout02): boolean {
    return layout <= GeoLayout02.MultiPolygonsDict && layout % 2 === 1;
}

function isTess(layout: GeoLayout02): boolean {
    return layout >= GeoLayout02.TessPolygons;
}

const MAX_GEOMETRY_TYPE = GEOMETRY_TYPE.MULTIPOLYGON;

export function decodeGeometry02(
    tile: Uint8Array,
    offset: IntWrapper,
    header: LayerHeader02,
    layout: GeoLayout02,
    featureCount: number,
    scaling: GeometryScaling | undefined,
): GeometryVector {
    if (isDict(layout) || isTess(layout)) {
        throw new Error(`v2 geometry layout ${GeoLayout02[layout]} is not supported by this decoder yet`);
    }
    const uniform = header.uniformType;
    const types = uniform === undefined ? readTypes(tile, offset, featureCount) : undefined;
    checkTypesFitLayout(types ?? new Uint32Array(featureCount).fill(uniform), layout);

    const geoLengths = hasGeoLengths(layout) ? readLengths(tile, offset, featureCount) : undefined;
    const partLengths = hasPartLengths(layout) ? readLengths(tile, offset, featureCount) : undefined;
    const ringLengths = hasRingLengths(layout) ? readLengths(tile, offset, featureCount) : undefined;
    // The offset conversions branch on each feature's type, so a uniform layer spells its type out.
    const typeOfEach = types ?? new Uint32Array(featureCount).fill(uniform);
    const topology = decodeTopology(typeOfEach, geoLengths, partLengths, ringLengths);

    const vertexHeader = readStreamHeader02(tile, offset, "vertex", featureCount);
    const vertices = decodeVertices02(tile, offset, vertexHeader, scaling);
    const vertexCount = countVertices(topology, featureCount);
    if (vertexHeader.numValues !== vertexCount) {
        throw new Error(
            `The topology spans ${vertexCount} vertices but the vertex stream holds ${vertexHeader.numValues}`,
        );
    }

    return types === undefined
        ? createConstGeometryVector(featureCount, uniform, topology, undefined, vertices)
        : createFlatGeometryVector(types, topology, undefined, vertices);
}

/** The types stream: one geometry type code per feature. */
function readTypes(tile: Uint8Array, offset: IntWrapper, featureCount: number): Uint32Array {
    const types = readLengths(tile, offset, featureCount);
    if (types.length !== featureCount) {
        throw new Error(`Types stream holds ${types.length} values for ${featureCount} features`);
    }
    for (let i = 0; i < types.length; i++) {
        if (types[i] > MAX_GEOMETRY_TYPE) {
            throw new Error(`Geometry type ${types[i]} of feature ${i} is unassigned`);
        }
    }
    return types;
}

/** A geometry-section integer stream: unsigned 32-bit words, read against the feature count. */
function readLengths(tile: Uint8Array, offset: IntWrapper, featureCount: number): Uint32Array {
    const header = readStreamHeader02(tile, offset, "int32", featureCount);
    return decodeIntStream02(tile, offset, header, false) as Uint32Array;
}

/** Every type needs the length streams its nesting takes, which the layout has to declare. */
function checkTypesFitLayout(types: Uint32Array, layout: GeoLayout02): void {
    const geo = hasGeoLengths(layout);
    const parts = hasPartLengths(layout);
    const rings = hasRingLengths(layout);
    for (let i = 0; i < types.length; i++) {
        const type = types[i];
        const fits =
            (geo || type < GEOMETRY_TYPE.MULTIPOINT) &&
            (parts || type === GEOMETRY_TYPE.POINT || type === GEOMETRY_TYPE.MULTIPOINT) &&
            (rings || (type !== GEOMETRY_TYPE.POLYGON && type !== GEOMETRY_TYPE.MULTIPOLYGON));
        if (!fits) {
            throw new Error(
                `Geometry type ${GEOMETRY_TYPE[type]} of feature ${i} does not fit the ${GeoLayout02[layout]} layout`,
            );
        }
    }
}

/**
 * Turns the length streams into the dense offset levels the geometry vectors index, exactly as
 * the v1 decoder and `decode_topology` in mlt-core do.
 */
function decodeTopology(
    types: Uint32Array,
    geoLengths: Uint32Array | undefined,
    partLengths: Uint32Array | undefined,
    ringLengths: Uint32Array | undefined,
): TopologyVector {
    if (geoLengths) {
        const geometryOffsets = decodeRootLengthStream(types, geoLengths, GEOMETRY_TYPE.POLYGON);
        if (partLengths && ringLengths) {
            const partOffsets = decodeLevel1LengthStream(types, geometryOffsets, partLengths, false);
            const ringOffsets = decodeLevel2LengthStream(types, geometryOffsets, partOffsets, ringLengths);
            return { geometryOffsets, partOffsets, ringOffsets };
        }
        if (partLengths) {
            const partOffsets = decodeLevel1WithoutRingBufferLengthStream(types, geometryOffsets, partLengths);
            return { geometryOffsets, partOffsets };
        }
        return { geometryOffsets };
    }
    if (partLengths && ringLengths) {
        const lineStringPresent = types.some(
            (t) => t === GEOMETRY_TYPE.LINESTRING || t === GEOMETRY_TYPE.MULTILINESTRING,
        );
        const partOffsets = decodeRootLengthStream(types, partLengths, GEOMETRY_TYPE.LINESTRING);
        const ringOffsets = decodeLevel1LengthStream(types, partOffsets, ringLengths, lineStringPresent);
        return { partOffsets, ringOffsets };
    }
    if (partLengths) {
        return { partOffsets: decodeRootLengthStream(types, partLengths, GEOMETRY_TYPE.POINT) };
    }
    return {};
}

/** The vertices the deepest offset level spans, or one per feature without any level. */
function countVertices(topology: TopologyVector, featureCount: number): number {
    const deepest = topology.ringOffsets ?? topology.partOffsets ?? topology.geometryOffsets;
    return deepest === undefined ? featureCount : deepest[deepest.length - 1];
}

/**
 * The vertex stream as `(x, y)` pairs. Delta runs one sum over every word, the componentwise
 * encodings keep a predecessor per component; all zigzag-decode and wrap at 32 bits.
 */
function decodeVertices02(
    tile: Uint8Array,
    offset: IntWrapper,
    header: StreamHeader02,
    scaling: GeometryScaling | undefined,
): Int32Array {
    if (header.zStep !== undefined) {
        throw new Error("v2 (x, y, z) vertices are not supported by this decoder yet");
    }
    const numWords = header.numValues * 2;
    let vertices: Int32Array;
    switch (header.logical) {
        case "none": {
            const words = readWords32(tile, offset, header, numWords);
            vertices = new Int32Array(words.length);
            for (let i = 0; i < words.length; i++) {
                vertices[i] = decodeZigZagInt32Value(words[i]);
            }
            break;
        }
        case "delta": {
            const words = readWords32(tile, offset, header, numWords);
            vertices = new Int32Array(words.length);
            let value = 0;
            for (let i = 0; i < words.length; i++) {
                value = (value + decodeZigZagInt32Value(words[i])) | 0;
                vertices[i] = value;
            }
            break;
        }
        case "cwDelta":
            vertices = decodeComponentwiseDeltaVec2(readWords32(tile, offset, header, numWords));
            break;
        case "cwDelta2":
            vertices = decodeComponentwiseDelta2Vec2(readWords32(tile, offset, header, numWords));
            break;
        default:
            throw new Error(`v2 ${header.logical} vertices are not supported by this decoder yet`);
    }
    if (scaling?.scale !== undefined) {
        const { scale, min, max } = scaling;
        for (let i = 0; i < vertices.length; i++) {
            vertices[i] = Math.min(max, Math.max(min, Math.round(vertices[i] * scale)));
        }
    }
    return vertices;
}
