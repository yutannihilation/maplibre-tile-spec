import type IntWrapper from "../intWrapper";
import { decodeFsst } from "../fsstDecoder";
import { decodeFrontCoded } from "../frontCoding";
import { unpackNullable } from "../unpackNullableUtils";
import { StringDictionaryVector } from "../../vector/dictionary/stringDictionaryVector";
import type BitVector from "../../vector/flat/bitVector";
import { StringFlatVector } from "../../vector/flat/stringFlatVector";
import {
    type FsstDictionaryCache,
    StringFsstDictionaryVector,
} from "../../vector/fsst-dictionary/stringFsstDictionaryVector";
import type Vector from "../../vector/vector";
import { readString02, readU8, readVarint32 } from "./bytes02";
import { decodeIntStream02 } from "./intStream02";
import { parsePresenceNibble02, presentCount, readPresence02 } from "./presence02";
import { readStreamHeader02, type StreamHeader02 } from "./streamHeader02";

/**
 * A v2 string column's stream set (`docs/specification/v2.md#string-columns`): the extension bits
 * of its leading stream name the layout, and every stream after the leading one runs over the
 * values it counted. The reference is `parse_strings` in mlt-core's `root02.rs`.
 */

const MAX_SYMBOLS = 255;

/** A dictionary's entries as the cumulative offsets into its bytes. */
export interface StringDictionary02 {
    offsets: Uint32Array;
    bytes: Uint8Array;
}

/**
 * Decodes a string column's streams, whose leading one holds `dataCount` values, into a vector
 * over the layer's `featureCount` features, absent ones marked by `presence`.
 */
export function decodeStringColumn02(
    tile: Uint8Array,
    offset: IntWrapper,
    name: string,
    dataCount: number,
    presence: BitVector | undefined,
    featureCount: number,
): Vector {
    const leading = readStreamHeader02(tile, offset, "str", dataCount);
    const values = decodeIntStream02(tile, offset, leading, false) as Uint32Array;
    if (values.length !== dataCount) {
        throw new Error(`Column "${name}" holds ${values.length} values for ${dataCount} present features`);
    }
    const size = presence ?? featureCount;
    const perFeature = (stream: Uint32Array) => unpackNullable(stream, presence ?? null, 0);

    switch (leading.strLayout) {
        case "plain": {
            const blob = readBlob(tile, offset, false);
            checkLengths(name, values, blob.length);
            return new StringFlatVector(name, offsetsOf(perFeature(values)), blob, presence);
        }
        case "dict": {
            const lengths = readLengths(tile, offset, leading.numValues);
            const dictionary = readDictionary(tile, offset, lengths);
            checkCodes(name, values, dictionary.offsets.length - 1);
            return new StringDictionaryVector(name, perFeature(values), dictionary.offsets, dictionary.bytes, presence);
        }
        case "fsst": {
            const symbolLengths = readLengths(tile, offset, leading.numValues);
            const symbols = readBlob(tile, offset, false);
            const corpus = readBlob(tile, offset, false);
            const decoded = decodeCorpus(symbolLengths, symbols, corpus);
            checkLengths(name, values, decoded.length);
            return new StringFlatVector(name, offsetsOf(perFeature(values)), decoded, presence);
        }
        case "fsstDict": {
            const lengths = readLengths(tile, offset, leading.numValues);
            const symbolLengths = readLengths(tile, offset, leading.numValues);
            const symbols = readBlob(tile, offset, false);
            const corpusHeader = readStreamHeader02(tile, offset, "bytes");
            const corpus = takeBlob(tile, offset, corpusHeader);
            checkSymbols(symbolLengths, symbols);
            if (corpusHeader.logical === "frontCoded") {
                // Front coding is undone after FSST, so the whole dictionary is built here.
                const dictionary = decodeFrontCoded(lengths, decodeCorpus(symbolLengths, symbols, corpus));
                checkCodes(name, values, dictionary.offsets.length - 1);
                return new StringDictionaryVector(
                    name,
                    perFeature(values),
                    dictionary.offsets,
                    dictionary.bytes,
                    presence,
                );
            }
            checkCodes(name, values, lengths.length);
            // The dictionary stays compressed until a value is read, as v1 does.
            return new StringFsstDictionaryVector(
                name,
                perFeature(values),
                offsetsOf(lengths),
                corpus,
                offsetsOf(symbolLengths),
                symbols,
                presence,
            );
        }
    }
}

/**
 * The dictionary a column or shared-dictionary group stores: its lengths stream was just read,
 * and its blob follows, plain or front-coded.
 */
export function readDictionary(tile: Uint8Array, offset: IntWrapper, lengths: Uint32Array): StringDictionary02 {
    const header = readStreamHeader02(tile, offset, "bytes");
    const blob = takeBlob(tile, offset, header);
    if (header.logical === "frontCoded") {
        return decodeFrontCoded(lengths, blob);
    }
    const offsets = offsetsOf(lengths);
    if (offsets[offsets.length - 1] !== blob.length) {
        throw new Error(
            `Dictionary entries take ${offsets[offsets.length - 1]} bytes but the blob holds ${blob.length}`,
        );
    }
    return { offsets, bytes: blob };
}

/**
 * A shared dictionary column (`docs/specification/v2.md#shared-dictionary-columns`): the type
 * byte's high nibble names the dictionary kind, then come the group's prefix, the child count,
 * the corpus streams with their own counts, and one string child per count that indexes into
 * the dictionary. Returns one vector per child, named by the prefix and the child's name.
 */
export function decodeSharedDict02(
    tile: Uint8Array,
    offset: IntWrapper,
    typeByte: number,
    featureCount: number,
    sharedPresence: BitVector[],
): Vector[] {
    const kind = typeByte >> 4;
    if (kind > 1) {
        throw new Error(`Shared dictionary kind ${kind} is reserved`);
    }
    const prefix = readString02(tile, offset, "Shared dictionary name");
    const childCount = readVarint32(tile, offset, "Shared dictionary child count");

    // Nothing implies the dictionary's entry count, so each corpus stream carries its own.
    const lengths = readLengths(tile, offset, undefined);
    let dictionary: StringDictionary02 | undefined;
    let fsst: { corpus: Uint8Array; symbolOffsets: Uint32Array; symbols: Uint8Array } | undefined;
    if (kind === 0) {
        dictionary = readDictionary(tile, offset, lengths);
    } else {
        const symbolLengths = readLengths(tile, offset, undefined);
        const symbols = readBlob(tile, offset, false);
        const corpusHeader = readStreamHeader02(tile, offset, "bytes");
        const corpus = takeBlob(tile, offset, corpusHeader);
        checkSymbols(symbolLengths, symbols);
        if (corpusHeader.logical === "frontCoded") {
            dictionary = decodeFrontCoded(lengths, decodeCorpus(symbolLengths, symbols, corpus));
        } else {
            fsst = { corpus, symbolOffsets: offsetsOf(symbolLengths), symbols };
        }
    }
    const entries = dictionary === undefined ? lengths.length : dictionary.offsets.length - 1;
    const cache: FsstDictionaryCache = {};

    const children: Vector[] = [];
    for (let i = 0; i < childCount; i++) {
        const childByte = readU8(tile, offset, `Shared dictionary child ${i} type byte`);
        if ((childByte & 0x0f) !== 0xb) {
            throw new Error(`Shared dictionary child ${i} is not a string column`);
        }
        const name = prefix + readString02(tile, offset, `Shared dictionary child ${i} name`);
        const nibble = parsePresenceNibble02(childByte >> 4, sharedPresence.length);
        let presence: BitVector | undefined;
        if (nibble.kind === "inline") {
            presence = readPresence02(tile, offset, featureCount, nibble.coding);
        } else if (nibble.kind === "shared") {
            presence = sharedPresence[nibble.index];
        }
        const dataCount = presence === undefined ? featureCount : presentCount(presence);
        const leading = readStreamHeader02(tile, offset, "str", dataCount);
        if (leading.strLayout !== "dict") {
            throw new Error(`Shared dictionary child "${name}" does not hold dictionary codes`);
        }
        const codes = decodeIntStream02(tile, offset, leading, false) as Uint32Array;
        if (codes.length !== dataCount) {
            throw new Error(`Column "${name}" holds ${codes.length} values for ${dataCount} present features`);
        }
        checkCodes(name, codes, entries);
        const perFeature = unpackNullable(codes, presence ?? null, 0);
        children.push(
            dictionary !== undefined
                ? new StringDictionaryVector(name, perFeature, dictionary.offsets, dictionary.bytes, presence)
                : new StringFsstDictionaryVector(
                      name,
                      perFeature,
                      offsetsOf(lengths),
                      fsst.corpus,
                      fsst.symbolOffsets,
                      fsst.symbols,
                      presence,
                      cache,
                  ),
        );
    }
    return children;
}

/** An integer stream of a string column after the leading one: unsigned, `implied` values unless it says otherwise. */
export function readLengths(tile: Uint8Array, offset: IntWrapper, implied: number | undefined): Uint32Array {
    const header = readStreamHeader02(tile, offset, "int32", implied);
    return decodeIntStream02(tile, offset, header, false) as Uint32Array;
}

/** A byte blob, which is never front-coded unless the caller allows it. */
function readBlob(tile: Uint8Array, offset: IntWrapper, frontCoded: boolean): Uint8Array {
    const header = readStreamHeader02(tile, offset, "bytes");
    if (header.logical === "frontCoded" && !frontCoded) {
        throw new Error("Only a string dictionary can be front-coded");
    }
    return takeBlob(tile, offset, header);
}

function takeBlob(tile: Uint8Array, offset: IntWrapper, header: StreamHeader02): Uint8Array {
    const start = offset.get();
    const end = start + header.byteLength;
    if (end > tile.length) {
        throw new Error(`Byte blob overruns the tile: ${end} > ${tile.length}`);
    }
    offset.set(end);
    return tile.subarray(start, end);
}

/** Cumulative offsets from lengths, one more than there are lengths. */
export function offsetsOf(lengths: Uint32Array): Uint32Array {
    const offsets = new Uint32Array(lengths.length + 1);
    let total = 0;
    for (let i = 0; i < lengths.length; i++) {
        total += lengths[i];
        offsets[i + 1] = total;
    }
    return offsets;
}

function checkLengths(name: string, lengths: Uint32Array, available: number): void {
    let total = 0;
    for (let i = 0; i < lengths.length; i++) {
        total += lengths[i];
    }
    if (total !== available) {
        throw new Error(`Column "${name}" values take ${total} bytes but ${available} are stored`);
    }
}

export function checkCodes(name: string, codes: Uint32Array, entries: number): void {
    for (let i = 0; i < codes.length; i++) {
        if (codes[i] >= entries) {
            throw new Error(`Column "${name}" code ${codes[i]} is past its ${entries} dictionary entries`);
        }
    }
}

function checkSymbols(symbolLengths: Uint32Array, symbols: Uint8Array): void {
    if (symbolLengths.length > MAX_SYMBOLS) {
        throw new Error(`An FSST symbol table holds at most ${MAX_SYMBOLS} symbols, not ${symbolLengths.length}`);
    }
    let total = 0;
    for (let i = 0; i < symbolLengths.length; i++) {
        total += symbolLengths[i];
    }
    if (total !== symbols.length) {
        throw new Error(`FSST symbols take ${total} bytes but the table holds ${symbols.length}`);
    }
}

/** Expands an FSST corpus, rejecting a code without a symbol and a corpus that ends on an escape. */
export function decodeCorpus(symbolLengths: Uint32Array, symbols: Uint8Array, corpus: Uint8Array): Uint8Array {
    checkSymbols(symbolLengths, symbols);
    for (let i = 0; i < corpus.length; i++) {
        const code = corpus[i];
        if (code === 255) {
            if (i + 1 >= corpus.length) {
                throw new Error("FSST corpus ends on an escape byte");
            }
            i++;
        } else if (code >= symbolLengths.length) {
            throw new Error(`FSST corpus names symbol ${code} of a table of ${symbolLengths.length}`);
        }
    }
    return decodeFsst(symbols, symbolLengths, corpus);
}
