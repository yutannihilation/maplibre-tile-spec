import type { GeometryVector, MortonSettings, CoordinatesArray, CoordinatesArrayZ, PointZ } from "./geometryVector";
import { decodeZOrderCurve } from "./zOrderCurve";
import { GEOMETRY_TYPE } from "./geometryType";
import { VertexBufferType } from "./vertexBufferType";
import Point from "@mapbox/point-geometry";

/** A vertex is a 2D `Point` for `GEOMETRY` columns or a {@link PointZ} for `GEOMETRY_Z` columns. */
type AnyPoint = Point | PointZ;
/** One geometry's coordinates: rings/parts of `AnyPoint`. Uniform per column (all 2D or all 3D). */
type AnyCoordinatesArray = Array<Array<AnyPoint>>;

/** Build a vertex from the interleaved buffer at `offset`, including Z when `stride` is 3. */
function makePoint(buffer: Int32Array | Uint32Array, offset: number, stride: number): AnyPoint {
    return stride === 3
        ? ({ x: buffer[offset], y: buffer[offset + 1], z: buffer[offset + 2] } satisfies PointZ)
        : new Point(buffer[offset], buffer[offset + 1]);
}

export function convertGeometryVector(geometryVector: GeometryVector): Array<CoordinatesArray | CoordinatesArrayZ> {
    const geometries: AnyCoordinatesArray[] = new Array(geometryVector.numGeometries);
    let partOffsetCounter = 1;
    let ringOffsetsCounter = 1;
    let geometryOffsetsCounter = 1;
    let geometryCounter = 0;
    let vertexBufferOffset = 0;
    let vertexOffsetsOffset = 0;

    const stride = geometryVector.numDimensions;

    const mortonSettings = geometryVector.mortonSettings;
    const topologyVector = geometryVector.topologyVector;
    const geometryOffsets = topologyVector.geometryOffsets;
    const partOffsets = topologyVector.partOffsets;
    const ringOffsets = topologyVector.ringOffsets;
    const vertexOffsets = geometryVector.vertexOffsets;
    const nonOffset = !vertexOffsets || vertexOffsets.length === 0;

    const containsPolygon = geometryVector.containsPolygonGeometry();
    const vertexBuffer = geometryVector.vertexBuffer;

    for (let i = 0; i < geometryVector.numGeometries; i++) {
        const geometryType = geometryVector.geometryType(i);
        switch (geometryType) {
            case GEOMETRY_TYPE.POINT:
                {
                    let point: AnyPoint;
                    if (nonOffset) {
                        point = makePoint(vertexBuffer, vertexBufferOffset, stride);
                        vertexBufferOffset += stride;
                    } else if (geometryVector.vertexBufferType === VertexBufferType.MORTON) {
                        const offset = vertexOffsets[vertexOffsetsOffset++];
                        const mortonCode = vertexBuffer[offset];
                        const vertex = decodeZOrderCurve(
                            mortonCode,
                            mortonSettings.numBits,
                            mortonSettings.coordinateShift,
                        );
                        point = new Point(vertex.x, vertex.y);
                    } else {
                        const offset = vertexOffsets[vertexOffsetsOffset++] * stride;
                        point = makePoint(vertexBuffer, offset, stride);
                    }
                    geometries[geometryCounter++] = [[point]];
                    if (geometryOffsets) geometryOffsetsCounter++;
                    if (partOffsets) partOffsetCounter++;
                    if (ringOffsets) ringOffsetsCounter++;
                }
                break;
            case GEOMETRY_TYPE.MULTIPOINT:
                {
                    const numPoints =
                        geometryOffsets[geometryOffsetsCounter] - geometryOffsets[geometryOffsetsCounter - 1];
                    geometryOffsetsCounter++;
                    const points: AnyPoint[] = new Array(numPoints);
                    if (nonOffset) {
                        for (let j = 0; j < numPoints; j++) {
                            points[j] = makePoint(vertexBuffer, vertexBufferOffset, stride);
                            vertexBufferOffset += stride;
                        }
                    } else {
                        for (let j = 0; j < numPoints; j++) {
                            const offset = vertexOffsets[vertexOffsetsOffset++] * stride;
                            points[j] = makePoint(vertexBuffer, offset, stride);
                        }
                    }
                    geometries[geometryCounter++] = points.map((point) => [point]);
                    // MULTIPOINT must increment offset counters like POINT does
                    partOffsetCounter += numPoints;
                    ringOffsetsCounter += numPoints;
                }
                break;
            case GEOMETRY_TYPE.LINESTRING:
                {
                    let numVertices: number;
                    if (containsPolygon) {
                        numVertices = ringOffsets[ringOffsetsCounter] - ringOffsets[ringOffsetsCounter - 1];
                        ringOffsetsCounter++;
                    } else {
                        numVertices = partOffsets[partOffsetCounter] - partOffsets[partOffsetCounter - 1];
                    }
                    partOffsetCounter++;

                    let vertices: AnyPoint[];
                    if (nonOffset) {
                        vertices = getLineStringOrRing(vertexBuffer, vertexBufferOffset, numVertices, false, stride);
                        vertexBufferOffset += numVertices * stride;
                    } else {
                        vertices = decodeDictionaryEncodedLineStringOrRing(
                            geometryVector.vertexBufferType,
                            vertexBuffer,
                            vertexOffsets,
                            vertexOffsetsOffset,
                            numVertices,
                            false,
                            mortonSettings,
                            stride,
                        );
                        vertexOffsetsOffset += numVertices;
                    }

                    geometries[geometryCounter++] = [vertices];

                    if (geometryOffsets) geometryOffsetsCounter++;
                }
                break;
            case GEOMETRY_TYPE.POLYGON:
                {
                    const numRings = partOffsets[partOffsetCounter] - partOffsets[partOffsetCounter - 1];
                    partOffsetCounter++;
                    const rings: AnyCoordinatesArray = new Array(numRings - 1);
                    let shell: AnyPoint[];
                    let numVertices = ringOffsets[ringOffsetsCounter] - ringOffsets[ringOffsetsCounter - 1];
                    ringOffsetsCounter++;

                    if (nonOffset) {
                        shell = getLineStringOrRing(vertexBuffer, vertexBufferOffset, numVertices, true, stride);
                        vertexBufferOffset += numVertices * stride;
                        for (let j = 0; j < rings.length; j++) {
                            numVertices = ringOffsets[ringOffsetsCounter] - ringOffsets[ringOffsetsCounter - 1];
                            ringOffsetsCounter++;
                            rings[j] = getLineStringOrRing(vertexBuffer, vertexBufferOffset, numVertices, true, stride);
                            vertexBufferOffset += numVertices * stride;
                        }
                    } else {
                        shell = decodeDictionaryEncodedLineStringOrRing(
                            geometryVector.vertexBufferType,
                            vertexBuffer,
                            vertexOffsets,
                            vertexOffsetsOffset,
                            numVertices,
                            true,
                            mortonSettings,
                            stride,
                        );
                        vertexOffsetsOffset += numVertices;
                        for (let j = 0; j < rings.length; j++) {
                            numVertices = ringOffsets[ringOffsetsCounter] - ringOffsets[ringOffsetsCounter - 1];
                            ringOffsetsCounter++;
                            rings[j] = decodeDictionaryEncodedLineStringOrRing(
                                geometryVector.vertexBufferType,
                                vertexBuffer,
                                vertexOffsets,
                                vertexOffsetsOffset,
                                numVertices,
                                true,
                                mortonSettings,
                                stride,
                            );
                            vertexOffsetsOffset += numVertices;
                        }
                    }
                    geometries[geometryCounter++] = [shell].concat(rings);
                    if (geometryOffsets) geometryOffsetsCounter++;
                }
                break;
            case GEOMETRY_TYPE.MULTILINESTRING:
                {
                    const numLineStrings =
                        geometryOffsets[geometryOffsetsCounter] - geometryOffsets[geometryOffsetsCounter - 1];
                    geometryOffsetsCounter++;
                    const lineStrings: AnyCoordinatesArray = new Array(numLineStrings);
                    for (let j = 0; j < numLineStrings; j++) {
                        let numVertices: number;
                        if (containsPolygon) {
                            numVertices = ringOffsets[ringOffsetsCounter] - ringOffsets[ringOffsetsCounter - 1];
                            ringOffsetsCounter++;
                        } else {
                            numVertices = partOffsets[partOffsetCounter] - partOffsets[partOffsetCounter - 1];
                        }
                        partOffsetCounter++;
                        if (nonOffset) {
                            lineStrings[j] = getLineStringOrRing(
                                vertexBuffer,
                                vertexBufferOffset,
                                numVertices,
                                false,
                                stride,
                            );
                            vertexBufferOffset += numVertices * stride;
                        } else {
                            const vertices = decodeDictionaryEncodedLineStringOrRing(
                                geometryVector.vertexBufferType,
                                vertexBuffer,
                                vertexOffsets,
                                vertexOffsetsOffset,
                                numVertices,
                                false,
                                mortonSettings,
                                stride,
                            );
                            lineStrings[j] = vertices;
                            vertexOffsetsOffset += numVertices;
                        }
                    }
                    geometries[geometryCounter++] = lineStrings;
                }
                break;
            case GEOMETRY_TYPE.MULTIPOLYGON:
                {
                    const numPolygons =
                        geometryOffsets[geometryOffsetsCounter] - geometryOffsets[geometryOffsetsCounter - 1];
                    geometryOffsetsCounter++;
                    const polygons: AnyCoordinatesArray[] = new Array(numPolygons);
                    for (let j = 0; j < numPolygons; j++) {
                        const numRings = partOffsets[partOffsetCounter] - partOffsets[partOffsetCounter - 1];
                        partOffsetCounter++;
                        let shell: AnyPoint[];
                        const rings: AnyCoordinatesArray = new Array(numRings - 1);
                        const numVertices = ringOffsets[ringOffsetsCounter] - ringOffsets[ringOffsetsCounter - 1];
                        ringOffsetsCounter++;
                        if (nonOffset) {
                            shell = getLineStringOrRing(vertexBuffer, vertexBufferOffset, numVertices, true, stride);
                            vertexBufferOffset += numVertices * stride;
                        } else {
                            shell = decodeDictionaryEncodedLineStringOrRing(
                                geometryVector.vertexBufferType,
                                vertexBuffer,
                                vertexOffsets,
                                vertexOffsetsOffset,
                                numVertices,
                                true,
                                mortonSettings,
                                stride,
                            );
                            vertexOffsetsOffset += numVertices;
                        }
                        for (let k = 0; k < rings.length; k++) {
                            const numRingVertices =
                                ringOffsets[ringOffsetsCounter] - ringOffsets[ringOffsetsCounter - 1];
                            ringOffsetsCounter++;
                            if (nonOffset) {
                                rings[k] = getLineStringOrRing(
                                    vertexBuffer,
                                    vertexBufferOffset,
                                    numRingVertices,
                                    true,
                                    stride,
                                );
                                vertexBufferOffset += numRingVertices * stride;
                            } else {
                                rings[k] = decodeDictionaryEncodedLineStringOrRing(
                                    geometryVector.vertexBufferType,
                                    vertexBuffer,
                                    vertexOffsets,
                                    vertexOffsetsOffset,
                                    numRingVertices,
                                    true,
                                    mortonSettings,
                                    stride,
                                );
                                vertexOffsetsOffset += numRingVertices;
                            }
                        }
                        polygons[j] = [shell].concat(rings);
                    }
                    geometries[geometryCounter++] = polygons.flat();
                }
                break;
            default:
                throw new Error(`The specified geometry type (${geometryType}) is currently not supported.`);
        }
    }

    return geometries as Array<CoordinatesArray | CoordinatesArrayZ>;
}

function decodeDictionaryEncodedLineStringOrRing(
    vertexBufferType: VertexBufferType,
    vertexBuffer: Int32Array | Uint32Array,
    vertexOffsets: Uint32Array,
    vertexOffset: number,
    numVertices: number,
    closeLineString: boolean,
    mortonSettings: MortonSettings,
    stride: number,
): AnyPoint[] {
    if (vertexBufferType === VertexBufferType.MORTON) {
        return decodeMortonDictionaryEncodedLineString(
            vertexBuffer,
            vertexOffsets,
            vertexOffset,
            numVertices,
            closeLineString,
            mortonSettings,
        );
    } else {
        return decodeDictionaryEncodedLineString(
            vertexBuffer,
            vertexOffsets,
            vertexOffset,
            numVertices,
            closeLineString,
            stride,
        );
    }
}

function getLineStringOrRing(
    vertexBuffer: Int32Array | Uint32Array,
    startIndex: number,
    numVertices: number,
    closeLineString: boolean,
    stride: number,
): AnyPoint[] {
    const vertices: AnyPoint[] = new Array(closeLineString ? numVertices + 1 : numVertices);
    for (let i = 0; i < numVertices; i++) {
        vertices[i] = makePoint(vertexBuffer, startIndex + i * stride, stride);
    }

    if (closeLineString) {
        vertices[vertices.length - 1] = vertices[0];
    }
    return vertices;
}

function decodeDictionaryEncodedLineString(
    vertexBuffer: Int32Array | Uint32Array,
    vertexOffsets: Uint32Array,
    vertexOffset: number,
    numVertices: number,
    closeLineString: boolean,
    stride: number,
): AnyPoint[] {
    const vertices: AnyPoint[] = new Array(closeLineString ? numVertices + 1 : numVertices);
    for (let i = 0; i < numVertices; i++) {
        const offset = vertexOffsets[vertexOffset + i] * stride;
        vertices[i] = makePoint(vertexBuffer, offset, stride);
    }

    if (closeLineString) {
        vertices[vertices.length - 1] = vertices[0];
    }
    return vertices;
}

function decodeMortonDictionaryEncodedLineString(
    vertexBuffer: Int32Array | Uint32Array,
    vertexOffsets: Uint32Array,
    vertexOffset: number,
    numVertices: number,
    closeLineString: boolean,
    mortonSettings: MortonSettings,
): Point[] {
    const vertices: Point[] = new Array(closeLineString ? numVertices + 1 : numVertices);
    for (let i = 0; i < numVertices; i++) {
        const offset = vertexOffsets[vertexOffset + i];
        const mortonEncodedVertex = vertexBuffer[offset];
        const vertex = decodeZOrderCurve(mortonEncodedVertex, mortonSettings.numBits, mortonSettings.coordinateShift);
        vertices[i] = new Point(vertex.x, vertex.y);
    }
    if (closeLineString) {
        vertices[vertices.length - 1] = vertices[0];
    }

    return vertices;
}
