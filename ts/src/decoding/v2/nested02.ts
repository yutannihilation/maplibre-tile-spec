import IntWrapper from "../intWrapper";
import BitVector from "../../vector/flat/bitVector";
import { ObjectFlatVector } from "../../vector/flat/objectFlatVector";
import type Vector from "../../vector/vector";
import { readString02, readU8, readVarint32 } from "./bytes02";
import { DataType02, decodeLeafValues02 } from "./columns02";
import { decodeIntStream02 } from "./intStream02";
import type { DecodeOptions02 } from "./layerDecoder02";
import { presentCount, readBoolStream02 } from "./presence02";
import { type Family02, readStreamHeader02, type StreamHeader02 } from "./streamHeader02";
import { decodeStringColumn02 } from "./stringStream02";

/**
 * Nested columns (`docs/specification/v2.md#nested-properties`): a tree of struct, list and map
 * nodes whose leaves are ordinary column stream sets. The tree is decoded depth first and
 * assembled into one plain value per feature: a struct or map becomes an object, a list an array.
 *
 * The reference encoder can also shape-code a struct's fields or a map's keys: a table of key-set
 * bitmaps and one id per row stand in for each field's presence stream, or for a map's lengths and
 * per-entry keys. The spec text does not describe it yet; this follows `rust/mlt-core`.
 */

/** A nested column nests at most this many levels, the root counting as the first. */
const MAX_DEPTH = 8;
const HAS_EXPLICIT_COUNT = 0x80;
/** The node presence nibble value that says a presence stream follows. */
const NODE_PRESENCE_STREAM = 0x10;
/** The bit above the node presence nibble's assigned values that says the children are shape-coded. */
const NODE_SHAPES = 0x40;

/** A value its node marks absent: a struct drops the field, a map the entry, a list holds null. */
const ABSENT = Symbol("absent");
type Slot = unknown;

interface NodeContext {
    /** Where the node sits, for error messages: the column name and the field names below it. */
    path: string;
    /** How many values the parent hands the node. */
    parentCount: number;
    /** Whether the node's streams must write their counts: true at and below the first list or map. */
    explicit: boolean;
    depth: number;
    options: DecodeOptions02;
}

/**
 * A nested column after its type byte, name and presence field: the root node's body, decoded to
 * one value per feature. `dataCount` is the column's present features, which the root is handed.
 */
export function decodeNestedColumn02(
    tile: Uint8Array,
    offset: IntWrapper,
    dataType: DataType02,
    name: string,
    presence: BitVector | undefined,
    dataCount: number,
    featureCount: number,
    options: DecodeOptions02,
): Vector {
    // A root has no node type byte to carry the shapes bit, so a prefix byte does. It collides
    // with a struct root of exactly 0x40 fields, which the reference reads as shape-coded too.
    let shapes = false;
    if (offset.get() < tile.length && tile[offset.get()] === NODE_SHAPES) {
        offset.increment();
        shapes = true;
    }
    const ctx: NodeContext = {
        path: name,
        parentCount: dataCount,
        explicit: dataType !== DataType02.Struct,
        depth: 1,
        options,
    };
    const rows = decodeInterior(tile, offset, dataType, ctx, dataCount, shapes);
    const values: unknown[] = new Array(featureCount);
    let row = 0;
    for (let i = 0; i < featureCount; i++) {
        values[i] = presence === undefined || presence.get(i) ? rows[row++] : null;
    }
    return new ObjectFlatVector(name, values, presence);
}

/** One node below the root: its type byte, its name when it is a struct field, its presence, its body. */
function decodeNode(
    tile: Uint8Array,
    offset: IntWrapper,
    ctx: NodeContext,
    named: boolean,
): { name: string; slots: Slot[] } {
    if (ctx.depth > MAX_DEPTH) {
        throw new Error(`Nested column "${ctx.path}" nests deeper than ${MAX_DEPTH} levels`);
    }
    const typeByte = readU8(tile, offset, "Nested node type byte");
    const nibble = typeByte & 0xf0;
    const dataType: DataType02 = typeByte & 0x0f;
    const shapes = (nibble & NODE_SHAPES) !== 0;
    const presenceNibble = nibble & ~NODE_SHAPES;
    if (presenceNibble !== 0 && presenceNibble !== NODE_PRESENCE_STREAM) {
        throw new Error(`Nested node presence nibble ${presenceNibble >> 4} under "${ctx.path}" is reserved`);
    }
    if (dataType <= DataType02.LongId || dataType === DataType02.SharedDict) {
        throw new Error(`A nested node under "${ctx.path}" cannot be ${DataType02[dataType]}`);
    }
    const name = named ? readString02(tile, offset, "Nested field name") : "";
    const path = name === "" ? ctx.path : `${ctx.path}.${name}`;
    // A list or a map ends the implied counts, its own streams included.
    const explicit = ctx.explicit || dataType === DataType02.List || dataType === DataType02.Map;

    let presence: BitVector | undefined;
    if (presenceNibble === NODE_PRESENCE_STREAM) {
        presence = readCounted(tile, offset, "bool", ctx.parentCount, explicit, path, "presence", (header) =>
            readBoolStream02(tile, offset, header),
        );
        if (presence.size() !== ctx.parentCount) {
            throw new Error(`"${path}" has ${presence.size()} presence bits for ${ctx.parentCount} values`);
        }
    }
    const count = presence === undefined ? ctx.parentCount : presentCount(presence);
    const nodeCtx: NodeContext = { ...ctx, path, parentCount: ctx.parentCount, explicit };

    let own: unknown[];
    if (dataType <= DataType02.String) {
        if (shapes) {
            throw new Error(`Leaf "${path}" cannot be shape-coded`);
        }
        requireExplicit(tile, offset, explicit, path, "leading data");
        const vector = decodeLeafValues02(tile, offset, dataType, path, count, ctx.options);
        own = new Array(count);
        for (let i = 0; i < count; i++) {
            own[i] = vector.getValue(i);
        }
    } else {
        own = decodeInterior(tile, offset, dataType, nodeCtx, count, shapes);
    }
    return { name, slots: expand(own, presence) };
}

/** Spreads a node's present values over every value its parent handed it. */
function expand(own: unknown[], presence: BitVector | undefined): Slot[] {
    if (presence === undefined) {
        return own;
    }
    const slots: Slot[] = new Array(presence.size());
    let next = 0;
    for (let i = 0; i < slots.length; i++) {
        slots[i] = presence.get(i) ? own[next++] : ABSENT;
    }
    return slots;
}

/** The body of a struct, list or map node: one assembled value per value the node marks present. */
function decodeInterior(
    tile: Uint8Array,
    offset: IntWrapper,
    dataType: DataType02,
    ctx: NodeContext,
    count: number,
    shapes: boolean,
): unknown[] {
    const childCtx = (parentCount: number, explicit: boolean): NodeContext => ({
        ...ctx,
        parentCount,
        explicit,
        depth: ctx.depth + 1,
    });
    switch (dataType) {
        case DataType02.Struct: {
            const fieldCount = readVarint32(tile, offset, "Struct field count");
            if (fieldCount === 0) {
                throw new Error(`Struct "${ctx.path}" has no fields`);
            }
            const shape = shapes ? readShapes(tile, offset, fieldCount, count, ctx.path) : undefined;
            const fields: { name: string; slots: Slot[] }[] = [];
            for (let key = 0; key < fieldCount; key++) {
                let field: { name: string; slots: Slot[] };
                if (shape === undefined) {
                    field = decodeNode(tile, offset, childCtx(count, ctx.explicit), true);
                } else {
                    // The shapes hold each field's presence, so no field stores one of its own.
                    if (offset.get() < tile.length && (tile[offset.get()] & NODE_PRESENCE_STREAM) !== 0) {
                        throw new Error(`A field of shape-coded struct "${ctx.path}" stores its own presence`);
                    }
                    const held = shape.held(key);
                    const child = decodeNode(tile, offset, childCtx(presentCount(held), ctx.explicit), true);
                    field = { name: child.name, slots: expand(child.slots, held) };
                }
                if (fields.some((f) => f.name === field.name)) {
                    throw new Error(`Struct "${ctx.path}" repeats field "${field.name}"`);
                }
                fields.push(field);
            }
            const values: unknown[] = new Array(count);
            for (let row = 0; row < count; row++) {
                const entries: [string, unknown][] = [];
                for (const { name, slots } of fields) {
                    if (slots[row] !== ABSENT) {
                        entries.push([name, slots[row]]);
                    }
                }
                values[row] = Object.fromEntries(entries);
            }
            return values;
        }
        case DataType02.List: {
            if (shapes) {
                throw new Error(`List "${ctx.path}" cannot be shape-coded`);
            }
            const lengths = readLengths(tile, offset, count, ctx.path);
            const element = decodeNode(tile, offset, childCtx(sum(lengths), true), false).slots;
            const values: unknown[] = new Array(count);
            let start = 0;
            for (let row = 0; row < count; row++) {
                const items = element.slice(start, start + lengths[row]);
                values[row] = items.map((item) => (item === ABSENT ? null : item));
                start += lengths[row];
            }
            return values;
        }
        case DataType02.Map: {
            let lengths: Uint32Array;
            let keys: Vector;
            let codes: Uint32Array | undefined;
            if (shapes) {
                // The key streams hold the distinct keys; each row's shape says which it has.
                const keyCount = peekCount(tile, offset, "str", ctx.path);
                keys = decodeStringColumn02(tile, offset, `${ctx.path} keys`, keyCount, undefined, keyCount);
                const shape = readShapes(tile, offset, keyCount, count, ctx.path);
                ({ lengths, codes } = shape.entries());
            } else {
                lengths = readLengths(tile, offset, count, ctx.path);
                const entries = sum(lengths);
                requireExplicit(tile, offset, true, ctx.path, "leading key");
                keys = decodeStringColumn02(tile, offset, `${ctx.path} keys`, entries, undefined, entries);
            }
            const value = decodeNode(tile, offset, childCtx(sum(lengths), true), false).slots;
            const values: unknown[] = new Array(count);
            let entry = 0;
            for (let row = 0; row < count; row++) {
                const entries: [string, unknown][] = [];
                for (let k = 0; k < lengths[row]; k++, entry++) {
                    if (value[entry] !== ABSENT) {
                        const key = keys.getValue(codes === undefined ? entry : codes[entry]) as string;
                        entries.push([key, value[entry]]);
                    }
                }
                values[row] = Object.fromEntries(entries);
            }
            return values;
        }
        default:
            throw new Error(`"${ctx.path}" is not a struct, list or map`);
    }
}

/** The key sets a shape-coded node's rows hold: a table of `width`-bit bitmaps and one id per row. */
interface Shapes {
    /** Which rows hold key `key`, the presence stream that key's child would have stored. */
    held(key: number): BitVector;
    /** One entry count per row and one key index per entry, as a map's lengths and keys would say. */
    entries(): { lengths: Uint32Array; codes: Uint32Array };
}

function readShapes(tile: Uint8Array, offset: IntWrapper, width: number, rows: number, path: string): Shapes {
    requireExplicit(tile, offset, true, path, "shape table");
    const table = readBoolStream02(tile, offset, readStreamHeader02(tile, offset, "bool"));
    requireExplicit(tile, offset, true, path, "shape id");
    const ids = decodeIntStream02(tile, offset, readStreamHeader02(tile, offset, "int32"), false) as Uint32Array;
    if (width === 0 || table.size() % width !== 0) {
        throw new Error(`"${path}" has a shape table of ${table.size()} bits over ${width} keys`);
    }
    const shapeCount = table.size() / width;
    for (const id of ids) {
        if (id >= shapeCount) {
            throw new Error(`"${path}" names shape ${id} of ${shapeCount}`);
        }
    }
    if (ids.length !== rows) {
        throw new Error(`"${path}" has ${ids.length} shape ids for ${rows} values`);
    }
    const holds = (row: number, key: number) => table.get(ids[row] * width + key);
    return {
        held(key) {
            const bits = new Uint8Array(Math.ceil(rows / 8));
            for (let row = 0; row < rows; row++) {
                if (holds(row, key)) {
                    bits[row >> 3] |= 1 << (row & 7);
                }
            }
            return new BitVector(bits, rows);
        },
        entries() {
            const lengths = new Uint32Array(rows);
            const codes: number[] = [];
            for (let row = 0; row < rows; row++) {
                for (let key = 0; key < width; key++) {
                    if (holds(row, key)) {
                        codes.push(key);
                        lengths[row]++;
                    }
                }
            }
            return { lengths, codes: Uint32Array.from(codes) };
        },
    };
}

/** A list's or map's lengths stream: one length per present value, its count always written. */
function readLengths(tile: Uint8Array, offset: IntWrapper, count: number, path: string): Uint32Array {
    const lengths = readCounted(tile, offset, "int32", count, true, path, "lengths", (header) =>
        decodeIntStream02(tile, offset, header, false),
    ) as Uint32Array;
    if (lengths.length !== count) {
        throw new Error(`"${path}" has ${lengths.length} lengths for ${count} values`);
    }
    return lengths;
}

/** Reads a stream whose count `count` is known, which must be written when `explicit` is set. */
function readCounted<T>(
    tile: Uint8Array,
    offset: IntWrapper,
    family: Family02,
    count: number,
    explicit: boolean,
    path: string,
    what: string,
    read: (header: StreamHeader02) => T,
): T {
    requireExplicit(tile, offset, explicit, path, what);
    return read(readStreamHeader02(tile, offset, family, count));
}

/** Rejects a stream without a written count where nothing implies one. */
function requireExplicit(tile: Uint8Array, offset: IntWrapper, explicit: boolean, path: string, what: string): void {
    if (!explicit) {
        return;
    }
    if (offset.get() >= tile.length) {
        throw new Error(`"${path}" ends before its ${what} stream`);
    }
    if ((tile[offset.get()] & HAS_EXPLICIT_COUNT) === 0) {
        throw new Error(`The ${what} stream of "${path}" must write its count`);
    }
}

/** The count a stream writes, read without consuming it. */
function peekCount(tile: Uint8Array, offset: IntWrapper, family: Family02, path: string): number {
    requireExplicit(tile, offset, true, path, "leading key");
    return readStreamHeader02(tile, new IntWrapper(offset.get()), family).numValues;
}

function sum(lengths: Uint32Array): number {
    let total = 0;
    for (let i = 0; i < lengths.length; i++) {
        total += lengths[i];
    }
    return total;
}
