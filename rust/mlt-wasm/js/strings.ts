/**
 * A string column's values, not yet decoded. It is plain data, so it survives `postMessage`.
 *
 * `decodeTileColumns` only gives ranges that are whole UTF-8 characters.
 */
export interface MltDeferredStrings {
  /** UTF-8 bytes. The columns of one shared dictionary hold the same array. */
  readonly data: Uint8Array;
  /**
   * Two entries per feature: the start and end byte offset of its value in `data`.
   * A feature without a value has a start equal to its end.
   */
  readonly ranges: Uint32Array;
}

/** `TextDecoder` costs more to call than to run on a string shorter than this. */
const TEXT_DECODER_MIN_LENGTH = 12;

/** Keeps a leading U+FEFF, as the strings Rust holds do. */
const textDecoder = new TextDecoder("utf-8", { ignoreBOM: true });

/** A `Map` key holds a byte range of `data` exactly while `data` is no longer than this. */
const MAX_CACHED_DATA_LENGTH = 2 ** 26;

/** How many values `decodeStrings` looks up before deciding whether its cache pays. */
const CACHE_TRIAL = 64;

/** The string `data` holds from byte `start` up to `end`. */
export function decodeString(
  data: Uint8Array,
  start: number,
  end: number,
): string {
  if (start === end) return "";
  return end - start < TEXT_DECODER_MIN_LENGTH
    ? decodeShortString(data, start, end)
    : textDecoder.decode(data.subarray(start, end));
}

/**
 * Every value of a deferred string column, `""` where a feature has none: what
 * `decodeTileColumns` gives for the column without `strings: "deferred"`.
 */
export function decodeStrings(values: MltDeferredStrings): string[] {
  const { data, ranges } = values;
  const count = ranges.length >> 1;
  const strings = new Array<string>(count);
  // A dictionary column repeats a few ranges over many features, which a cache decodes once
  // each. Where under half of the first lookups hit, the cache costs more than it saves.
  const width = data.length + 1;
  let decoded =
    data.length <= MAX_CACHED_DATA_LENGTH ? new Map<number, string>() : null;
  let lookups = 0;
  let hits = 0;
  for (let i = 0; i < count; i++) {
    const start = ranges[2 * i];
    const end = ranges[2 * i + 1];
    if (start === end) {
      strings[i] = "";
    } else if (decoded === null || end > data.length) {
      // No key is kept for a range the key cannot hold, which only a hand-made one is.
      strings[i] = decodeString(data, start, end);
    } else {
      const key = start * width + end;
      let value = decoded.get(key);
      if (value === undefined) {
        value = decodeString(data, start, end);
        decoded.set(key, value);
      } else {
        hits++;
      }
      strings[i] = value;
      if (++lookups === CACHE_TRIAL && hits * 2 < lookups) decoded = null;
    }
  }
  return strings;
}

/**
 * UTF-8 decoding without `TextDecoder`, after https://github.com/mapbox/pbf/issues/106.
 * It gives what `TextDecoder` gives for UTF-8, and need not for bytes that are not.
 */
function decodeShortString(
  data: Uint8Array,
  start: number,
  end: number,
): string {
  let str = "";
  let i = start;
  while (i < end) {
    const b0 = data[i];
    let codePoint: number | null = null;
    let length = b0 > 0xef ? 4 : b0 > 0xdf ? 3 : b0 > 0xbf ? 2 : 1;
    if (i + length > end) break;

    if (length === 1) {
      if (b0 < 0x80) codePoint = b0;
    } else if (length === 2) {
      const b1 = data[i + 1];
      if ((b1 & 0xc0) === 0x80) {
        codePoint = ((b0 & 0x1f) << 6) | (b1 & 0x3f);
        if (codePoint <= 0x7f) codePoint = null;
      }
    } else if (length === 3) {
      const b1 = data[i + 1];
      const b2 = data[i + 2];
      if ((b1 & 0xc0) === 0x80 && (b2 & 0xc0) === 0x80) {
        codePoint = ((b0 & 0xf) << 12) | ((b1 & 0x3f) << 6) | (b2 & 0x3f);
        if (codePoint <= 0x7ff || (codePoint >= 0xd800 && codePoint <= 0xdfff))
          codePoint = null;
      }
    } else {
      const b1 = data[i + 1];
      const b2 = data[i + 2];
      const b3 = data[i + 3];
      if (
        (b1 & 0xc0) === 0x80 &&
        (b2 & 0xc0) === 0x80 &&
        (b3 & 0xc0) === 0x80
      ) {
        codePoint =
          ((b0 & 0xf) << 18) |
          ((b1 & 0x3f) << 12) |
          ((b2 & 0x3f) << 6) |
          (b3 & 0x3f);
        if (codePoint <= 0xffff || codePoint >= 0x110000) codePoint = null;
      }
    }

    if (codePoint === null) {
      codePoint = 0xfffd;
      length = 1;
    } else if (codePoint > 0xffff) {
      codePoint -= 0x10000;
      str += String.fromCharCode(((codePoint >>> 10) & 0x3ff) | 0xd800);
      codePoint = 0xdc00 | (codePoint & 0x3ff);
    }
    str += String.fromCharCode(codePoint);
    i += length;
  }
  return str;
}
