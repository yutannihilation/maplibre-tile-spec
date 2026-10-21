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
