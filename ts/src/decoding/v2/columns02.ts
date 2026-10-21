import type IntWrapper from "../intWrapper";
import { unpackNullable, unpackNullableBoolean } from "../unpackNullableUtils";
import BitVector from "../../vector/flat/bitVector";
import { BooleanFlatVector } from "../../vector/flat/booleanFlatVector";
import { DoubleFlatVector } from "../../vector/flat/doubleFlatVector";
import { Int32FlatVector } from "../../vector/flat/int32FlatVector";
import { Int64FlatVector } from "../../vector/flat/int64FlatVector";
import type { IdVector } from "../../vector/idVector";
import type Vector from "../../vector/vector";
import { readString02, readU8 } from "./bytes02";
import { decodeIntStream02 } from "./intStream02";
import type { DecodeOptions02 } from "./layerDecoder02";
import { parsePresenceNibble02, presentCount, readBoolStream02, readPresence02 } from "./presence02";
import { readStreamHeader02 } from "./streamHeader02";

/**
 * The counted columns of a v2 layer (`docs/specification/v2.md#columns`): each a type byte, a name
 * unless it is the id, a presence field when its nibble names one, then its data streams.
 */

/** The low nibble of a column type byte. */
export enum DataType02 {
    Id = 0x0,
    LongId = 0x1,
    Bool = 0x2,
    Int8 = 0x3,
    UInt8 = 0x4,
    Int32 = 0x5,
    UInt32 = 0x6,
    Int64 = 0x7,
    UInt64 = 0x8,
    Float = 0x9,
    Double = 0xa,
    String = 0xb,
    Struct = 0xc,
    List = 0xd,
    Map = 0xe,
    SharedDict = 0xf,
}

export interface LayerContext02 {
    featureCount: number;
    /** The layer's shared presence fields, which a column's presence nibble may point into. */
    sharedPresence: BitVector[];
    options: DecodeOptions02;
}

export interface DecodedColumns02 {
    idVector: IdVector | undefined;
    propertyVectors: Vector[];
}

/** A column's presence over the layer's features: undefined when every feature has a value. */
interface ColumnHeader02 {
    dataType: DataType02;
    name: string;
    presence: BitVector | undefined;
    /** How many values the data streams hold: the present features. */
    dataCount: number;
}

export function decodeColumns02(
    tile: Uint8Array,
    offset: IntWrapper,
    columnCount: number,
    ctx: LayerContext02,
): DecodedColumns02 {
    let idVector: IdVector | undefined;
    const propertyVectors: Vector[] = [];
    const names = new Set<string>();
    for (let i = 0; i < columnCount; i++) {
        const typeByte = readU8(tile, offset, `Column ${i} type byte`);
        const dataType = typeByte & 0x0f;
        if (dataType === DataType02.SharedDict) {
            throw new Error("v2 shared dictionary columns are not supported by this decoder yet");
        }
        const header = readColumnHeader(tile, offset, typeByte, dataType, ctx);
        switch (dataType) {
            case DataType02.Id:
            case DataType02.LongId:
                if (idVector !== undefined) {
                    throw new Error("A layer has at most one id column");
                }
                idVector = decodeIdColumn(tile, offset, header, ctx);
                break;
            case DataType02.Bool:
                propertyVectors.push(decodeBoolColumn(tile, offset, header, ctx));
                break;
            case DataType02.Int8:
            case DataType02.UInt8:
            case DataType02.Int32:
            case DataType02.UInt32:
            case DataType02.Int64:
            case DataType02.UInt64:
                propertyVectors.push(decodeIntColumn(tile, offset, header, ctx));
                break;
            default:
                throw new Error(`v2 ${DataType02[dataType]} columns are not supported by this decoder yet`);
        }
        if (header.name !== "" || dataType > DataType02.LongId) {
            if (names.has(header.name)) {
                throw new Error(`Column name "${header.name}" is repeated`);
            }
            names.add(header.name);
        }
    }
    return { idVector, propertyVectors };
}

/** The name, unless the column is the id, and the presence the type byte's high nibble names. */
function readColumnHeader(
    tile: Uint8Array,
    offset: IntWrapper,
    typeByte: number,
    dataType: DataType02,
    ctx: LayerContext02,
): ColumnHeader02 {
    const name = dataType > DataType02.LongId ? readString02(tile, offset, "Column name") : "";
    const nibble = parsePresenceNibble02(typeByte >> 4, ctx.sharedPresence.length);
    let presence: BitVector | undefined;
    switch (nibble.kind) {
        case "all":
            break;
        case "inline":
            presence = readPresence02(tile, offset, ctx.featureCount, nibble.coding);
            break;
        case "shared":
            presence = ctx.sharedPresence[nibble.index];
            break;
    }
    const dataCount = presence === undefined ? ctx.featureCount : presentCount(presence);
    return { dataType, name, presence, dataCount };
}

/** The id column: unsigned 32 or 64-bit ids, one per present feature. */
function decodeIdColumn(tile: Uint8Array, offset: IntWrapper, header: ColumnHeader02, ctx: LayerContext02): IdVector {
    const wide = header.dataType === DataType02.LongId;
    const stream = readStreamHeader02(tile, offset, wide ? "int64" : "int32", header.dataCount);
    const values = decodeIntStream02(tile, offset, stream, false);
    if (values.length !== header.dataCount) {
        throw new Error(`The id column holds ${values.length} ids for ${header.dataCount} present features`);
    }
    const size = header.presence ?? ctx.featureCount;
    if (!wide) {
        return new Int32FlatVector("id", unpackNullable(values as Uint32Array, header.presence ?? null, 0), size);
    }
    const ids = unpackNullable(values as BigUint64Array, header.presence ?? null, 0n);
    if (!ctx.options.idWithinMaxSafeInteger) {
        return new Int64FlatVector("id", ids, size);
    }
    // Ids above 2^53 lose precision here, as the v1 decoder's do under the same option.
    const doubles = new Float64Array(ids.length);
    for (let i = 0; i < ids.length; i++) {
        doubles[i] = Number(ids[i]);
    }
    return new DoubleFlatVector("id", doubles, size);
}

/** A boolean column: one `Bool`-family stream of a bit per present feature. */
function decodeBoolColumn(
    tile: Uint8Array,
    offset: IntWrapper,
    header: ColumnHeader02,
    ctx: LayerContext02,
): BooleanFlatVector {
    const stream = readStreamHeader02(tile, offset, "bool", header.dataCount);
    const bits = readBoolStream02(tile, offset, stream);
    if (bits.size() !== header.dataCount) {
        throw new Error(`Column "${header.name}" holds ${bits.size()} values for ${header.dataCount} present features`);
    }
    const size = header.presence ?? ctx.featureCount;
    const unpacked = unpackNullableBoolean(bits.getBuffer(), bits.size(), header.presence ?? null);
    return new BooleanFlatVector(header.name, new BitVector(unpacked, ctx.featureCount), size);
}

const INT_RANGES: Partial<Record<DataType02, [number, number]>> = {
    [DataType02.Int8]: [-128, 127],
    [DataType02.UInt8]: [0, 255],
};

/** An integer column: one stream of 32 or 64-bit words, signed or not by the data type. */
function decodeIntColumn(tile: Uint8Array, offset: IntWrapper, header: ColumnHeader02, ctx: LayerContext02): Vector {
    const { dataType } = header;
    const wide = dataType === DataType02.Int64 || dataType === DataType02.UInt64;
    const signed = dataType === DataType02.Int8 || dataType === DataType02.Int32 || dataType === DataType02.Int64;
    const stream = readStreamHeader02(tile, offset, wide ? "int64" : "int32", header.dataCount);
    const values = decodeIntStream02(tile, offset, stream, signed);
    if (values.length !== header.dataCount) {
        throw new Error(
            `Column "${header.name}" holds ${values.length} values for ${header.dataCount} present features`,
        );
    }
    const range = INT_RANGES[dataType];
    if (range !== undefined) {
        for (let i = 0; i < values.length; i++) {
            const value = values[i] as number;
            if (value < range[0] || value > range[1]) {
                throw new Error(`Column "${header.name}" holds ${value}, outside its ${DataType02[dataType]} range`);
            }
        }
    }
    const size = header.presence ?? ctx.featureCount;
    if (wide) {
        return new Int64FlatVector(
            header.name,
            unpackNullable(values as BigInt64Array | BigUint64Array, header.presence ?? null, 0n),
            size,
        );
    }
    return new Int32FlatVector(
        header.name,
        unpackNullable(values as Int32Array | Uint32Array, header.presence ?? null, 0),
        size,
    );
}
