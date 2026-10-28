import Point from "@mapbox/point-geometry";
import { createFlatGeometryVector } from "./flatGeometryVector";
import { GEOMETRY_TYPE } from "./geometryType";
import type { CoordinatesArray } from "./geometryVector";
import type { TopologyVector } from "./topologyVector";
import type { Vertex } from "./vertexSequence";

export abstract class GpuVector implements Iterable<CoordinatesArray> {
    protected constructor(
        private readonly _triangleOffsets: Uint32Array,
        private readonly _indexBuffer: Uint32Array,
        private readonly _vertexBuffer: Int32Array | Uint32Array,
        private readonly _topologyVector?: TopologyVector,
        private readonly _zBuffer?: Int32Array,
    ) {}

    abstract geometryType(index: number): number;

    abstract get numGeometries(): number;

    abstract containsSingleGeometryType(): boolean;

    get triangleOffsets(): Uint32Array {
        return this._triangleOffsets;
    }

    get indexBuffer(): Uint32Array {
        return this._indexBuffer;
    }

    get vertexBuffer(): Int32Array | Uint32Array {
        return this._vertexBuffer;
    }

    get topologyVector(): TopologyVector | undefined {
        return this._topologyVector;
    }

    /** One z per vertex buffer entry, when the vertices have z coordinates. */
    get zBuffer(): Int32Array | undefined {
        return this._zBuffer;
    }

    getGeometries(): CoordinatesArray[] {
        if (!this._topologyVector) {
            return this.triangleGeometries();
        }
        const types = new Uint32Array(this.numGeometries);
        for (let i = 0; i < this.numGeometries; i++) {
            types[i] = this.geometryType(i);
        }
        return createFlatGeometryVector(
            types,
            this._topologyVector,
            undefined,
            this._vertexBuffer,
            this._zBuffer,
        ).getGeometries();
    }

    /**
     * Without outlines, each feature is the multi-polygon of its triangles: one closed ring of three
     * vertices per triangle, in decoded order, as the v2 spec reads a `TessPolygons` layer.
     */
    private triangleGeometries(): CoordinatesArray[] {
        const geometries: CoordinatesArray[] = new Array(this.numGeometries);
        const offsets = this._triangleOffsets;
        const indices = this._indexBuffer;
        const vertices = this._vertexBuffer;
        const zBuffer = this._zBuffer;
        for (let i = 0; i < this.numGeometries; i++) {
            // Under any other type a reader would take the triangles for a shell and its holes.
            if (this.geometryType(i) !== GEOMETRY_TYPE.MULTIPOLYGON) {
                throw new Error("A GpuVector without topology holds triangles, so its features must be multi-polygons");
            }
            const rings: CoordinatesArray = [];
            for (let t = offsets[i]; t < offsets[i + 1]; t++) {
                const ring: Point[] = new Array(4);
                for (let k = 0; k < 3; k++) {
                    const index = indices[t * 3 + k];
                    const vertex: Vertex = new Point(vertices[index * 2], vertices[index * 2 + 1]);
                    if (zBuffer !== undefined) {
                        vertex.z = zBuffer[index];
                    }
                    ring[k] = vertex;
                }
                ring[3] = ring[0];
                rings.push(ring);
            }
            geometries[i] = rings;
        }
        return geometries;
    }

    [Symbol.iterator](): Iterator<CoordinatesArray> {
        /*for(let i = 1; i < this.triangleOffsets.length; i++) {
           const numTriangles = this.triangleOffsets[i] - this.triangleOffsets[i-1];
           const startIndex = this.triangleOffsets[i-1] * 3;
           const endIndex = this.triangleOffsets[i] * 3;
       }

        while (index < this.numGeometries) {
            yield geometries[index++];
        }*/

        //throw new Error("Iterator on a GpuVector is not implemented yet.");
        return null;
    }
}
