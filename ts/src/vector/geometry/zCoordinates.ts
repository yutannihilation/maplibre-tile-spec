import type Point from "@mapbox/point-geometry";
import type { CoordinatesArray } from "./geometryVector";

/**
 * A decoded vertex. A v2 layer with z coordinates sets `z` on every vertex: an integer on the
 * layer's z grid, `FeatureTable.zStep`, counted from -10000 m (`docs/specification/v2.md`).
 */
export type Vertex = Point & { z?: number };

/**
 * Sets each vertex's z from `zBuffer`, which holds one z per vertex buffer entry. The vertices are
 * visited in the order the vertex sequence stores them; a dictionary layout looks each one up
 * through `vertexOffsets`. A ring's closing vertex is its first vertex again, so it is skipped.
 */
export function attachZ(
    geometries: CoordinatesArray[],
    zBuffer: Int32Array,
    vertexOffsets: Uint32Array | undefined,
): void {
    const lookup = vertexOffsets !== undefined && vertexOffsets.length > 0 ? vertexOffsets : undefined;
    let next = 0;
    for (const rings of geometries) {
        for (const ring of rings) {
            for (let j = 0; j < ring.length; j++) {
                const vertex = ring[j] as Vertex;
                if (j > 0 && j === ring.length - 1 && vertex === ring[0]) {
                    continue;
                }
                const index = next++;
                vertex.z = zBuffer[lookup === undefined ? index : lookup[index]];
            }
        }
    }
}
