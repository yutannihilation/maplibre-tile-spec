import { decodeZigZagInt32Value, decodeZigZagInt64Value } from "./integerDecodingUtils";

/**
 * Delta2 (`docs/encodings.md#delta2`): each word is the zigzag delta of the deltas, both running
 * sums starting at zero and wrapping at the word width.
 *
 * ```text
 * delta[i]  = delta[i - 1] + zigzag(words[i])
 * values[i] = values[i - 1] + delta[i]
 * ```
 */
export function decodeZigZagDelta2Int32(words: Uint32Array): Int32Array {
    const values = new Int32Array(words.length);
    let delta = 0;
    let value = 0;
    for (let i = 0; i < words.length; i++) {
        delta = (delta + decodeZigZagInt32Value(words[i])) | 0;
        value = (value + delta) | 0;
        values[i] = value;
    }
    return values;
}

export function decodeZigZagDelta2Int64(words: BigUint64Array): BigInt64Array {
    const values = new BigInt64Array(words.length);
    let delta = 0n;
    let value = 0n;
    for (let i = 0; i < words.length; i++) {
        delta = BigInt.asIntN(64, delta + decodeZigZagInt64Value(words[i]));
        value = BigInt.asIntN(64, value + delta);
        values[i] = value;
    }
    return values;
}

/**
 * Componentwise Delta2 (`docs/encodings.md#componentwise-delta2`): Delta2 of each coordinate of an
 * `(x, y)` stream, `x` and `y` keeping separate predecessors.
 */
export function decodeComponentwiseDelta2Vec2(words: Uint32Array): Int32Array {
    if (words.length % 2 !== 0) {
        throw new Error(`A vertex stream of ${words.length} words is not whole (x, y) pairs`);
    }
    const values = new Int32Array(words.length);
    let deltaX = 0;
    let deltaY = 0;
    let x = 0;
    let y = 0;
    for (let i = 0; i < words.length; i += 2) {
        deltaX = (deltaX + decodeZigZagInt32Value(words[i])) | 0;
        deltaY = (deltaY + decodeZigZagInt32Value(words[i + 1])) | 0;
        x = (x + deltaX) | 0;
        y = (y + deltaY) | 0;
        values[i] = x;
        values[i + 1] = y;
    }
    return values;
}
