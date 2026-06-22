/**
 * Coordinate dimensionality of a geometry column: 2 (x, y) or 3 (x, y, z).
 *
 * This is a per-column property — the in-tile `GEOMETRY` vs `GEOMETRY_Z` column type
 * decides it once for the whole layer; it never varies per feature. Mirrors `CoordDim`
 * in mlt-core. The flat vertex buffer is interleaved at this many components per vertex.
 */
export type CoordinateDimension = 2 | 3;
