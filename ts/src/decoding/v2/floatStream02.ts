import type IntWrapper from "../intWrapper";
import { decodeAlpDoubles, decodeAlpFloats } from "../alp";
import { readWords32, readWords64 } from "./intStream02";
import { readStreamHeader02, type StreamHeader02 } from "./streamHeader02";

/**
 * The data stream of a v2 float or double column (`docs/specification/v2.md#scalar-columns`):
 * raw little-endian values, ALP offsets, or dictionary codes followed by the dictionary stream.
 */

export type FloatValues02 = Float32Array | Float64Array;

/** Decodes a float column's values from its leading stream, whose header was just read. */
export function decodeFloatStream02(tile: Uint8Array, offset: IntWrapper, header: StreamHeader02): FloatValues02 {
    const wide = header.family === "float64";
    if (!wide && header.family !== "float32") {
        throw new Error(`A ${header.family} stream is not a float stream`);
    }
    switch (header.logical) {
        case "none":
            return readRawFloats(tile, offset, header, wide);
        case "alp": {
            if (header.physical === "fastPfor") {
                throw new Error("v2 ALP over FastPFOR is not supported by this decoder yet");
            }
            // ALP offsets are 64-bit words whatever the column's width.
            const offsets = readWords64(tile, offset, header, header.numValues);
            return wide ? decodeAlpDoubles(offsets, header.alp) : decodeAlpFloats(offsets, header.alp);
        }
        case "dict": {
            const codes = readWords32(tile, offset, header, header.numValues);
            const dictHeader = readStreamHeader02(tile, offset, header.family, header.numValues);
            if (dictHeader.logical !== "none") {
                throw new Error(`A float dictionary is stored raw, not as ${dictHeader.logical}`);
            }
            const dictionary = readRawFloats(tile, offset, dictHeader, wide);
            const values = wide ? new Float64Array(codes.length) : new Float32Array(codes.length);
            for (let i = 0; i < codes.length; i++) {
                if (codes[i] >= dictionary.length) {
                    throw new Error(`Float dictionary code ${codes[i]} is past the ${dictionary.length} entries`);
                }
                values[i] = dictionary[codes[i]];
            }
            return values;
        }
        default:
            throw new Error(`v2 ${header.logical} floats are not supported by this decoder yet`);
    }
}

/** Raw little-endian IEEE 754 values, exactly `byte_length` of them. */
function readRawFloats(tile: Uint8Array, offset: IntWrapper, header: StreamHeader02, wide: boolean): FloatValues02 {
    const width = wide ? 8 : 4;
    const start = offset.get();
    const end = start + header.byteLength;
    if (header.byteLength !== header.numValues * width) {
        throw new Error(`Float stream byte length ${header.byteLength} does not hold ${header.numValues} values`);
    }
    if (end > tile.length) {
        throw new Error(`Float stream overruns the tile: ${end} > ${tile.length}`);
    }
    const view = new DataView(tile.buffer, tile.byteOffset + start, header.byteLength);
    offset.set(end);
    if (wide) {
        const values = new Float64Array(header.numValues);
        for (let i = 0; i < values.length; i++) {
            values[i] = view.getFloat64(i * 8, true);
        }
        return values;
    }
    const values = new Float32Array(header.numValues);
    for (let i = 0; i < values.length; i++) {
        values[i] = view.getFloat32(i * 4, true);
    }
    return values;
}
