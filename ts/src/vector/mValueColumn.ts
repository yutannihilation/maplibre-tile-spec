import type BitVector from "./flat/bitVector";
import type Vector from "./vector";

/**
 * An m-value column of a v2 layer: values measured at vertices rather than at features
 * (`docs/specification/v2.md#m-values`).
 *
 * `vector` holds one value per vertex, flat across the features that carry values, in the order of
 * the layer's vertex sequence. A feature carries values for all of its vertices or for none.
 */
export class MValueColumn {
    /**
     * @param _vector one value per vertex of the features that carry values
     * @param _starts where each feature's run begins in `_vector`, with one more entry than there
     *   are features; a feature without values has an empty run
     * @param _presence which features carry values, or undefined when every feature does
     */
    constructor(
        private readonly _vector: Vector,
        private readonly _starts: Uint32Array,
        private readonly _presence: BitVector | undefined,
    ) {}

    get name(): string {
        return this._vector.name;
    }

    get vector(): Vector {
        return this._vector;
    }

    /** Whether feature `index` carries values. */
    isPresent(index: number): boolean {
        return this._presence === undefined || this._presence.get(index);
    }

    /** The values feature `index` carries, one per vertex in vertex order, or null when it has none. */
    getValues(index: number): unknown[] | null {
        if (!this.isPresent(index)) {
            return null;
        }
        const start = this._starts[index];
        const values: unknown[] = new Array(this._starts[index + 1] - start);
        for (let k = 0; k < values.length; k++) {
            values[k] = this._vector.getValue(start + k);
        }
        return values;
    }
}
