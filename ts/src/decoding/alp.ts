/**
 * Framed, Exception-Free ALP (`docs/encodings.md#alp`): a float column stored as the integers
 * `i = round(v * 10^e / 10^f)`, each as an unsigned offset from the column's smallest.
 *
 * Decoding is `i = base + offset` in 64-bit integer arithmetic, then `v = i * 10^f * 10^-e`, with
 * `10^-e` the nearest double rather than an exact division, in exactly that order, so that every
 * value the encoder verified comes back bit for bit. The reference is `codecs/alp.rs` in mlt-core.
 */

export interface AlpParams {
    /** Decimal exponent the values were scaled by, 0-18. */
    e: number;
    /** Factor dividing out the trailing zeros `e` introduced, 0-`e`. */
    f: number;
    /** Frame of reference: the smallest scaled integer in the column. */
    base: bigint;
}

const POW10 = [1, 1e1, 1e2, 1e3, 1e4, 1e5, 1e6, 1e7, 1e8, 1e9, 1e10, 1e11, 1e12, 1e13, 1e14, 1e15, 1e16, 1e17, 1e18];
const FRAC10 = [
    1, 1e-1, 1e-2, 1e-3, 1e-4, 1e-5, 1e-6, 1e-7, 1e-8, 1e-9, 1e-10, 1e-11, 1e-12, 1e-13, 1e-14, 1e-15, 1e-16, 1e-17,
    1e-18,
];

/** Lifts the stored offsets onto their values, as doubles. */
export function decodeAlpDoubles(offsets: BigUint64Array, params: AlpParams): Float64Array {
    const values = new Float64Array(offsets.length);
    const down = POW10[params.f];
    const upRecip = FRAC10[params.e];
    for (let i = 0; i < offsets.length; i++) {
        // The sum has to form as an integer: an offset can exceed 2^53 where the code does not.
        const code = BigInt.asIntN(64, params.base + offsets[i]);
        values[i] = Number(code) * down * upRecip;
    }
    return values;
}

/** As {@link decodeAlpDoubles}, narrowed to single precision after the double arithmetic. */
export function decodeAlpFloats(offsets: BigUint64Array, params: AlpParams): Float32Array {
    return Float32Array.from(decodeAlpDoubles(offsets, params));
}
