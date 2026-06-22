import type { CoordinateDimension } from "./coordinateDimension";

export enum VertexBufferType {
    MORTON = 0,
    VEC_2 = 1,
    VEC_3 = 2,
}

/** Plain (non-Morton) interleaved vertex buffer type for a given coordinate dimensionality. */
export function vertexBufferTypeForDimensions(numDimensions: CoordinateDimension): VertexBufferType {
    return numDimensions === 3 ? VertexBufferType.VEC_3 : VertexBufferType.VEC_2;
}
