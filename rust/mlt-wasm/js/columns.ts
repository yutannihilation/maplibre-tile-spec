import {
  decodeString,
  decodeStrings,
  type MltDeferredStrings,
} from "./strings";
import { wasmDecodeTileColumns } from "./wasm";

/** Mirrors `GeometryType` in mlt-core - preserves the single vs multi distinction that MVT collapses. */
export enum MltGeometryType {
  Point = 0,
  LineString = 1,
  Polygon = 2,
  MultiPoint = 3,
  MultiLineString = 4,
  MultiPolygon = 5,
}

/** What a string column's values come as: decoded, or with `strings: "deferred"`, not yet. */
export type MltStringValues = string[] | MltDeferredStrings;

/**
 * The array each column type comes as, one value per feature.
 *
 * `bool` comes as `0`/`1` in a `Uint8Array`. `i64` and `u64` come as `Float64Array`, so values
 * above `Number.MAX_SAFE_INTEGER` lose precision.
 */
interface MltColumnValuesByType<S extends MltStringValues = string[]> {
  bool: Uint8Array;
  i8: Int8Array;
  u8: Uint8Array;
  i32: Int32Array;
  u32: Uint32Array;
  i64: Float64Array;
  u64: Float64Array;
  f32: Float32Array;
  f64: Float64Array;
  string: S;
}

/** The type a property column was stored as. */
export type MltColumnType = keyof MltColumnValuesByType;

export type MltColumnValues = MltColumnValuesByType[MltColumnType];

/**
 * A slot whose feature has no value holds `0` or `""`; `present` says which slots those are.
 * `present` is one bit per feature, LSB-first, and is left out when every feature has a value.
 */
export interface MltColumn<
  V extends MltColumnValues | MltDeferredStrings = MltColumnValues,
> {
  readonly values: V;
  readonly present?: Uint8Array;
}

/** A property column. Checking `type` narrows `values` to its array. */
export type MltNamedColumn<S extends MltStringValues = string[]> = {
  [T in MltColumnType]: MltColumn<MltColumnValuesByType<S>[T]> & {
    readonly name: string;
    readonly type: T;
  };
}[MltColumnType];

/**
 * A layer's geometry as decoded, 2D or 3D by `dimension`.
 *
 * Offset arrays are cumulative: entry `i` starts item `i` and entry `i + 1` ends it.
 * Each level indexes into the next, and the last one present indexes vertices.
 * An array a layer does not need is left out.
 */
export type MltGeometryColumns = MltGeometryColumns2D | MltGeometryColumns3D;

interface MltGeometryColumnsBase {
  /** The MLT geometry type of each feature, see `MltGeometryType`. */
  readonly types: Uint8Array;
  readonly geometryOffsets?: Uint32Array;
  readonly partOffsets?: Uint32Array;
  readonly ringOffsets?: Uint32Array;
  /**
   * `dimension` words per vertex, in tile coordinates, interleaved as the wire stores them.
   * A polygon ring's closing vertex is not stored.
   */
  readonly vertices: Int32Array;
  /** Cumulative triangle counts per polygon feature, for a tessellated layer. */
  readonly triangleOffsets?: Uint32Array;
  /** Three vertex indices per triangle, counted from the layer's first vertex. */
  readonly indexBuffer?: Uint32Array;
}

/** What a z of `0` stands for: mean sea level, or the terrain under each vertex. */
export type HeightMode = "absolute" | "relativeToGround";

/** `(x, y)` vertices, which sit on the ground. */
export interface MltGeometryColumns2D extends MltGeometryColumnsBase {
  readonly dimension: 2;
  readonly zStep?: undefined;
  readonly heightMode?: undefined;
}

/** `(x, y, z)` vertices. */
export interface MltGeometryColumns3D extends MltGeometryColumnsBase {
  readonly dimension: 3;
  /** The z grid as the power of ten of its step in metres; `toElevation` gives a z in metres. */
  readonly zStep: number;
  readonly heightMode: HeightMode;
}

export interface MltColumnLayer<S extends MltStringValues = string[]> {
  readonly name: string;
  readonly extent: number;
  /** The wire version the layer was stored in. */
  readonly version: 1 | 2;
  readonly featureCount: number;
  readonly geometry: MltGeometryColumns;
  /** Left out when the layer has no id column. */
  readonly ids?: MltColumn<Float64Array>;
  /**
   * In wire order, a shared dictionary's children named by its prefix and their own names.
   * v2 vertex-scoped (m-value) and nested columns are not passed on.
   */
  readonly properties: readonly MltNamedColumn<S>[];
}

export interface MltColumnTile<S extends MltStringValues = string[]> {
  /** In wire order; layer names need not be unique. */
  readonly layers: readonly MltColumnLayer<S>[];
}

export interface DecodeTileColumnsOptions {
  /**
   * Decode only the layers with one of these names, every one that has it. The other
   * layers are skipped without being decoded. Every layer is decoded when left out.
   */
  readonly layers?: readonly string[];
  /**
   * How string columns come: `"decoded"`, the default, as a `string[]`, or `"deferred"` as
   * the bytes and byte ranges of an `MltDeferredStrings`, for a caller that reads few of them.
   */
  readonly strings?: "decoded" | "deferred";
}

/** Decode the layers of a tile into typed arrays. */
export function decodeTileColumns(
  data: Uint8Array,
  options: DecodeTileColumnsOptions & { readonly strings: "deferred" },
): MltColumnTile<MltDeferredStrings>;
export function decodeTileColumns(
  data: Uint8Array,
  options?: DecodeTileColumnsOptions & { readonly strings?: "decoded" },
): MltColumnTile;
export function decodeTileColumns(
  data: Uint8Array,
  options?: DecodeTileColumnsOptions,
): MltColumnTile | MltColumnTile<MltDeferredStrings>;
export function decodeTileColumns(
  data: Uint8Array,
  options: DecodeTileColumnsOptions = {},
): MltColumnTile | MltColumnTile<MltDeferredStrings> {
  const { strings = "decoded" } = options;
  if (strings !== "decoded" && strings !== "deferred") {
    throw new TypeError(
      `the strings option is "decoded" or "deferred", not ${JSON.stringify(strings)}`,
    );
  }
  // wasm-bindgen copies the array into Rust, so it never sees the caller's readonly one.
  const names = options.layers as string[] | undefined;
  // String columns leave WASM undecoded: Rust cannot make a JS string without a call into
  // JS for each one.
  const layers = wasmDecodeTileColumns(
    data,
    names,
  ) as MltColumnLayer<MltDeferredStrings>[];
  if (strings === "deferred") return { layers };
  return { layers: layers.map(decodeLayerStrings) };
}

/** `layer` with each of its string columns decoded. */
function decodeLayerStrings(
  layer: MltColumnLayer<MltDeferredStrings>,
): MltColumnLayer {
  const properties = layer.properties.map((column) =>
    column.type === "string"
      ? { ...column, values: decodeStrings(column.values) }
      : column,
  );
  return { ...layer, properties };
}

/** The value a column holds for one feature. */
type MltColumnValue<V> = V extends MltDeferredStrings
  ? string
  : V extends ArrayLike<infer E>
    ? E
    : never;

/**
 * Feature `index`'s value in `column`, or `undefined` when the feature has none.
 *
 * Throws when `index` is not a feature, so that `undefined` only ever means no value.
 */
export function columnValue<
  C extends MltColumn<MltColumnValues | MltDeferredStrings>,
>(column: C, index: number): MltColumnValue<C["values"]> | undefined {
  const { present } = column;
  const values: MltColumnValues | MltDeferredStrings = column.values;
  const deferred = "ranges" in values;
  const count = deferred ? values.ranges.length >> 1 : values.length;
  if (!Number.isInteger(index) || index < 0 || index >= count) {
    throw new RangeError(`the column has no feature ${index}`);
  }
  const has =
    present === undefined || ((present[index >> 3] >> (index & 7)) & 1) === 1;
  if (!has) return undefined;
  const value = deferred
    ? decodeString(
        values.data,
        values.ranges[2 * index],
        values.ranges[2 * index + 1],
      )
    : values[index];
  return value as MltColumnValue<C["values"]>;
}

/**
 * A z of a 3D layer in metres above the layer's `heightMode` base, `z * 10 ** zStep`, as mlt-core's `ZStep::elevation`:
 * a fine grid divides by an exact integer, so `1234` on the `-2` grid is exactly `12.34`.
 */
export function toElevation(z: number, zStep: number): number {
  const power = 10 ** Math.abs(zStep);
  return zStep < 0 ? z / power : z * power;
}
