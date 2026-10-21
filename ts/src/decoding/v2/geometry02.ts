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
import { createConstGpuVector } from "../../vector/geometry/constGpuVector";
import { createFlatGpuVector } from "../../vector/geometry/flatGpuVector";
import type { GpuVector } from "../../vector/geometry/gpuVector";
import { decodeTriangleTrees } from "../triangleTrees";
import { decodeRansVertices } from "../rans";
import { decodeZOrderCurve } from "../../vector/geometry/zOrderCurve";
import { decodeIntStream02, readWords32 } from "./intStream02";
import { type MortonParams02, readStreamHeader02, type StreamHeader02 } from "./streamHeader02";
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

/** A decoded geometry section. */
export interface Geometry02 {
    vector: GeometryVector | GpuVector;
    /** The z grid's exponent when the vertices are `(x, y, z)` triples. */
    zStep?: number;
}

export function decodeGeometry02(
    tile: Uint8Array,
    offset: IntWrapper,
    header: LayerHeader02,
    layout: GeoLayout02,
    featureCount: number,
    scaling: GeometryScaling | undefined,
): Geometry02 {
    const uniform = header.uniformType;
    const types = uniform === undefined ? readTypes(tile, offset, featureCount) : undefined;
    checkTypesFitLayout(types ?? new Uint32Array(featureCount).fill(uniform), layout);

    const geoLengths = hasGeoLengths(layout) ? readLengths(tile, offset, featureCount) : undefined;
    const partLengths = hasPartLengths(layout) ? readLengths(tile, offset, featureCount) : undefined;
    const ringLengths = hasRingLengths(layout) ? readLengths(tile, offset, featureCount) : undefined;
    // The offset conversions branch on each feature's type, so a uniform layer spells its type out.
    const typeOfEach = types ?? new Uint32Array(featureCount).fill(uniform);
    const topology = decodeTopology(typeOfEach, geoLengths, partLengths, ringLengths);

    let tessellation: Tessellation02 | undefined;
    if (isTess(layout)) {
        tessellation = readTessellation(tile, offset, featureCount);
    }

    const dictionary = isDict(layout);
    const vertexHeader = readStreamHeader02(tile, offset, "vertex", featureCount);
    if (vertexHeader.logical === "morton" && !dictionary) {
        throw new Error("Morton codes are only stored as a vertex dictionary");
    }
    if (vertexHeader.logical === "rans" && dictionary) {
        throw new Error("A vertex dictionary cannot be rANS-coded");
    }
    // rANS codes each run of vertices in a context of its own: a ring, else a part, else a geometry.
    const runOffsets = topology.ringOffsets ?? topology.partOffsets ?? topology.geometryOffsets;
    const { vertices, zBuffer } = decodeVertices02(tile, offset, vertexHeader, scaling, runOffsets);
    const vertexCount = countVertices(topology, featureCount);

    // A dictionary layout stores the distinct vertices, then one index per vertex into them.
    let vertexOffsets: Uint32Array | undefined;
    if (dictionary) {
        vertexOffsets = readLengths(tile, offset, featureCount);
        if (vertexOffsets.length !== vertexCount) {
            throw new Error(
                `The topology spans ${vertexCount} vertices but there are ${vertexOffsets.length} vertex offsets`,
            );
        }
        const distinct = vertexHeader.numValues;
        for (let i = 0; i < vertexOffsets.length; i++) {
            if (vertexOffsets[i] >= distinct) {
                throw new Error(`Vertex offset ${vertexOffsets[i]} is past the ${distinct} dictionary entries`);
            }
        }
    } else if (layout !== GeoLayout02.TessPolygons && vertexHeader.numValues !== vertexCount) {
        // Without outlines no topology spans the vertices; the triangles are their only reader.
        throw new Error(
            `The topology spans ${vertexCount} vertices but the vertex stream holds ${vertexHeader.numValues}`,
        );
    }

    const zStep = vertexHeader.zStep;
    if (tessellation !== undefined) {
        const vector = tessellatedVector(layout, typeOfEach, uniform, tessellation, vertices, zBuffer, topology);
        return { vector, zStep };
    }
    const vector =
        types === undefined
            ? createConstGeometryVector(featureCount, uniform, topology, vertexOffsets, vertices, zBuffer)
            : createFlatGeometryVector(types, topology, vertexOffsets, vertices, zBuffer);
    return { vector, zStep };
}

/** The triangle streams of a tessellated layout, decoded to an index buffer. */
interface Tessellation02 {
    /** Cumulative triangle counts, one more than there are counts. */
    triangleOffsets: Uint32Array;
    /** Three vertex indices per triangle, counted from the layer's first vertex. */
    indexBuffer: Uint32Array;
}

function readTessellation(tile: Uint8Array, offset: IntWrapper, featureCount: number): Tessellation02 {
    const triangleLengths = readLengths(tile, offset, featureCount);
    const symbols = readLengths(tile, offset, featureCount);
    const cycles = readLengths(tile, offset, featureCount);
    const indexBuffer = decodeTriangleTrees(symbols, cycles);
    const triangleOffsets = new Uint32Array(triangleLengths.length + 1);
    let total = 0;
    for (let i = 0; i < triangleLengths.length; i++) {
        total += triangleLengths[i];
        triangleOffsets[i + 1] = total;
    }
    if (total !== symbols.length) {
        throw new Error(`Triangle lengths sum to ${total} but there are ${symbols.length} triangles`);
    }
    return { triangleOffsets, indexBuffer };
}

/**
 * A tessellated layer as a GPU vector. With outlines it keeps its topology and decodes as the
 * geometry it was encoded from; without, every feature is a multi-polygon of its triangles.
 */
function tessellatedVector(
    layout: GeoLayout02,
    types: Uint32Array,
    uniform: GEOMETRY_TYPE | undefined,
    tessellation: Tessellation02,
    vertices: Int32Array,
    zBuffer: Int32Array | undefined,
    topology: TopologyVector,
): GeometryVector | GpuVector {
    const { triangleOffsets, indexBuffer } = tessellation;
    const vertexCount = vertices.length / 2;
    for (let i = 0; i < indexBuffer.length; i++) {
        if (indexBuffer[i] >= vertexCount) {
            throw new Error(`Triangle vertex ${indexBuffer[i]} is past the layer's ${vertexCount} vertices`);
        }
    }
    const polygons = types.filter((t) => t === GEOMETRY_TYPE.POLYGON || t === GEOMETRY_TYPE.MULTIPOLYGON).length;
    if (triangleOffsets.length - 1 !== polygons) {
        throw new Error(`${triangleOffsets.length - 1} triangle counts for ${polygons} polygon features`);
    }
    if (layout === GeoLayout02.TessPolygonsWithOutlines) {
        return uniform === undefined
            ? createFlatGpuVector(types, triangleOffsets, indexBuffer, vertices, topology, zBuffer)
            : createConstGpuVector(types.length, uniform, triangleOffsets, indexBuffer, vertices, topology, zBuffer);
    }
    if (polygons !== types.length) {
        throw new Error("A TessPolygons layer holds only polygons");
    }
    // Shells and holes are not stored, so every feature reads back as a multi-polygon.
    return createConstGpuVector(
        types.length,
        GEOMETRY_TYPE.MULTIPOLYGON,
        triangleOffsets,
        indexBuffer,
        vertices,
        undefined,
        zBuffer,
    );
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
    if (layout === GeoLayout02.TessPolygons) {
        // No topology at all: the triangles alone read the vertices, which only polygons can be.
        return;
    }
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

/**
 * Morton codes of a sorted dictionary, stored as plain deltas (`docs/encodings.md#morton`), decoded
 * to `(x, y)` pairs on the grid the stream's parameters name.
 */
function decodeMortonDeltas(words: Uint32Array, morton: MortonParams02): Int32Array {
    const vertices = new Int32Array(words.length * 2);
    let code = 0;
    for (let i = 0; i < words.length; i++) {
        code = (code + words[i]) >>> 0;
        const { x, y } = decodeZOrderCurve(code, morton.bits, morton.shift);
        vertices[2 * i] = x;
        vertices[2 * i + 1] = y;
    }
    return vertices;
}

/** The vertices the deepest offset level spans, or one per feature without any level. */
function countVertices(topology: TopologyVector, featureCount: number): number {
    const deepest = topology.ringOffsets ?? topology.partOffsets ?? topology.geometryOffsets;
    return deepest === undefined ? featureCount : deepest[deepest.length - 1];
}

/**
 * Componentwise delta over `(x, y, z)` triples: a running sum per component, zigzag-decoded and
 * wrapping at 32 bits.
 */
function decodeComponentwiseDeltaVec3(words: Uint32Array): Int32Array {
    const out = new Int32Array(words.length);
    let x = 0;
    let y = 0;
    let z = 0;
    for (let i = 0; i < words.length; i += 3) {
        x = (x + decodeZigZagInt32Value(words[i])) | 0;
        y = (y + decodeZigZagInt32Value(words[i + 1])) | 0;
        z = (z + decodeZigZagInt32Value(words[i + 2])) | 0;
        out[i] = x;
        out[i + 1] = y;
        out[i + 2] = z;
    }
    return out;
}

/** Splits interleaved `(x, y, z)` triples into `(x, y)` pairs and one z per vertex. */
function splitTriples(triples: Int32Array): { vertices: Int32Array; zBuffer: Int32Array } {
    const count = triples.length / 3;
    const vertices = new Int32Array(count * 2);
    const zBuffer = new Int32Array(count);
    for (let i = 0; i < count; i++) {
        vertices[2 * i] = triples[3 * i];
        vertices[2 * i + 1] = triples[3 * i + 1];
        zBuffer[i] = triples[3 * i + 2];
    }
    return { vertices, zBuffer };
}

/**
 * The vertex stream as `(x, y)` pairs, plus one z per vertex when the stream holds triples. Delta
 * runs one sum over every word, the componentwise encodings keep a predecessor per component; all
 * zigzag-decode and wrap at 32 bits. Morton codes decode to pairs here too, so one vertex buffer
 * shape serves every encoding. Scaling applies to x and y only.
 */
function decodeVertices02(
    tile: Uint8Array,
    offset: IntWrapper,
    header: StreamHeader02,
    scaling: GeometryScaling | undefined,
    runOffsets: Uint32Array | undefined,
): { vertices: Int32Array; zBuffer?: Int32Array } {
    // The header admits only raw, delta and componentwise delta over triples.
    const xyz = header.zStep !== undefined;
    const numWords = header.numValues * (xyz ? 3 : 2);
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
        case "cwDelta": {
            const words = readWords32(tile, offset, header, numWords);
            vertices = xyz ? decodeComponentwiseDeltaVec3(words) : decodeComponentwiseDeltaVec2(words);
            break;
        }
        case "cwDelta2":
            vertices = decodeComponentwiseDelta2Vec2(readWords32(tile, offset, header, numWords));
            break;
        case "morton":
            vertices = decodeMortonDeltas(readWords32(tile, offset, header, header.numValues), header.morton);
            break;
        case "rans": {
            const start = offset.get();
            const end = start + header.byteLength;
            if (end > tile.length) {
                throw new Error(`Stream payload overruns the tile: ${end} > ${tile.length}`);
            }
            vertices = decodeRansVertices(tile.subarray(start, end), runOffsets, header.numValues);
            offset.set(end);
            break;
        }
        default:
            throw new Error(`v2 ${header.logical} vertices are not supported by this decoder yet`);
    }
    let zBuffer: Int32Array | undefined;
    if (xyz) {
        ({ vertices, zBuffer } = splitTriples(vertices));
    }
    if (scaling?.scale !== undefined) {
        const { scale, min, max } = scaling;
        for (let i = 0; i < vertices.length; i++) {
            vertices[i] = Math.min(max, Math.max(min, Math.round(vertices[i] * scale)));
        }
    }
    return { vertices, zBuffer };
}
