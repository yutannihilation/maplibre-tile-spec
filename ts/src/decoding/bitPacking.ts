/**
 * Fixed-width bit packing (`docs/encodings.md#bit-packing`): `[u8 width][packed bytes]`, every
 * value in `width` bits, laid out LSB-first end to end. Bits past the last value are padding.
 *
 * The accumulator is a plain number: at most 32 value bits plus 7 carried bits, well within the
 * 53 bits a double holds exactly, so the shifts are multiplications rather than 32-bit operators.
 */

const MAX_WIDTH = 32;

function packedWidth(payload: Uint8Array, count: number): number {
    if (payload.length === 0) {
        throw new Error("Bit-packed stream has no width byte");
    }
    const width = payload[0];
    if (width < 1 || width > MAX_WIDTH) {
        throw new Error(`Bit-packed stream has a width of ${width} bits, outside 1-${MAX_WIDTH}`);
    }
    const expected = 1 + Math.ceil((count * width) / 8);
    if (payload.length !== expected) {
        throw new Error(
            `Bit-packed stream has a byte length of ${payload.length}, not the ${expected} its width needs`,
        );
    }
    return width;
}

/** Unpacks `count` values of at most 32 bits each. */
export function unpackBits32(payload: Uint8Array, count: number): Uint32Array {
    const width = packedWidth(payload, count);
    const values = new Uint32Array(count);
    const mask = 2 ** width;
    let acc = 0;
    let bits = 0;
    let pos = 1;
    for (let i = 0; i < count; i++) {
        while (bits < width) {
            acc += payload[pos++] * 2 ** bits;
            bits += 8;
        }
        const value = acc % mask;
        values[i] = value;
        acc = (acc - value) / mask;
        bits -= width;
    }
    return values;
}

/** As {@link unpackBits32}, into 64-bit words for a stream whose column is 64-bit wide. */
export function unpackBits64(payload: Uint8Array, count: number): BigUint64Array {
    const narrow = unpackBits32(payload, count);
    const values = new BigUint64Array(count);
    for (let i = 0; i < count; i++) {
        values[i] = BigInt(narrow[i]);
    }
    return values;
}
