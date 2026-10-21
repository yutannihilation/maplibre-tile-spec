/**
 * The v2 synthetic fixtures (`test/synthetic/0x02`) the decoder cannot handle yet, grouped by the
 * feature they need. A `*` in an entry matches any run of characters.
 *
 * The decoder's synthetic suite asserts that each of these still fails to decode, and the
 * encoder's round-trip suite that each still fails to round-trip, so an entry that starts
 * working fails both until it is removed. Remove entries as v2 support lands; add none.
 */
export const UNIMPLEMENTED_SYNTHETICS_02: readonly string[] = [];
