import type Point from "@mapbox/point-geometry";
import type { CoordinatesArray } from "./geometryVector";

/**
 * A decoded vertex. A v2 layer with z coordinates sets `z` on every vertex: an integer on the
 * layer's z grid, `FeatureTable.zStep`, counted from -10000 m (`docs/specification/v2.md`).
 */
export type Vertex = Point & { z?: number };

/**
 * Whether `ring[j]` is the vertex that closes a ring. The geometry vectors close a ring by repeating
 * its first vertex object, so the closing vertex is not one the vertex sequence stores.
 */
function isClosingVertex(ring: Point[], j: number): boolean {
    return j > 0 && j === ring.length - 1 && ring[j] === ring[0];
}

/**
 * Sets each vertex's z from `zBuffer`, which holds one z per vertex buffer entry. The vertices are
 * visited in the order the vertex sequence stores them; a dictionary layout looks each one up
 * through `vertexOffsets`.
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
                if (isClosingVertex(ring, j)) {
                    continue;
                }
                const index = next++;
                (ring[j] as Vertex).z = zBuffer[lookup === undefined ? index : lookup[index]];
            }
        }
    }
}
