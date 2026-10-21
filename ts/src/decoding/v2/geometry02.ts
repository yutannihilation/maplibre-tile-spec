import type IntWrapper from "../intWrapper";
import type GeometryScaling from "../geometryScaling";
import { decodeComponentwiseDeltaVec2, decodeZigZagInt32Value } from "../integerDecodingUtils";
import { GEOMETRY_TYPE } from "../../vector/geometry/geometryType";
import type { GeometryVector } from "../../vector/geometry/geometryVector";
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

const MAX_GEOMETRY_TYPE = GEOMETRY_TYPE.MULTIPOLYGON;

export function decodeGeometry02(
    tile: Uint8Array,
    offset: IntWrapper,
    header: LayerHeader02,
    layout: GeoLayout02,
    featureCount: number,
    scaling: GeometryScaling | undefined,
): GeometryVector {
    if (layout !== GeoLayout02.Points) {
        throw new Error(`v2 geometry layout ${GeoLayout02[layout]} is not supported by this decoder yet`);
    }
    const types = header.uniformType === undefined ? readTypes(tile, offset, featureCount) : undefined;
    if (types !== undefined) {
        for (let i = 0; i < types.length; i++) {
            if (types[i] !== GEOMETRY_TYPE.POINT) {
                throw new Error(`Geometry type ${types[i]} of feature ${i} does not fit the Points layout`);
            }
        }
    }
    const vertexHeader = readStreamHeader02(tile, offset, "vertex", featureCount);
    const vertices = decodeVertices02(tile, offset, vertexHeader, scaling);
    return types === undefined
        ? createConstGeometryVector(featureCount, header.uniformType, {}, undefined, vertices)
        : createFlatGeometryVector(types, {}, undefined, vertices);
}

/** The types stream: one geometry type code per feature. */
function readTypes(tile: Uint8Array, offset: IntWrapper, featureCount: number): Uint32Array {
    const header = readStreamHeader02(tile, offset, "int32", featureCount);
    const types = decodeIntStream02(tile, offset, header, false) as Uint32Array;
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

/**
 * The vertex stream as `(x, y)` pairs. Delta runs one sum over every word, componentwise delta
 * keeps a predecessor per component; both zigzag-decode and wrap at 32 bits.
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
    let vertices: Int32Array;
    switch (header.logical) {
        case "none": {
            const words = readWords32(tile, offset, header, header.numValues * 2);
            vertices = new Int32Array(words.length);
            for (let i = 0; i < words.length; i++) {
                vertices[i] = decodeZigZagInt32Value(words[i]);
            }
            break;
        }
        case "delta": {
            const words = readWords32(tile, offset, header, header.numValues * 2);
            vertices = new Int32Array(words.length);
            let value = 0;
            for (let i = 0; i < words.length; i++) {
                value = (value + decodeZigZagInt32Value(words[i])) | 0;
                vertices[i] = value;
            }
            break;
        }
        case "cwDelta":
            vertices = decodeComponentwiseDeltaVec2(readWords32(tile, offset, header, header.numValues * 2));
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
