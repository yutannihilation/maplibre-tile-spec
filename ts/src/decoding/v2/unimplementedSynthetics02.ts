/**
 * The v2 synthetic fixtures (`test/synthetic/0x02`) the decoder cannot handle yet, grouped by the
 * feature they need. A `*` in an entry matches any run of characters.
 *
 * The decoder's synthetic suite asserts that each of these still fails to decode, and the
 * encoder's round-trip suite that each still fails to round-trip, so an entry that starts
 * working fails both until it is removed. Remove entries as v2 support lands; add none.
 */
export const UNIMPLEMENTED_SYNTHETICS_02: readonly string[] = [
    // geometry: FastPFOR, tessellation, rANS
    "0x02/*_fpf*",
    "0x02/*_tes*",
    "0x02/*_tri",
    "0x02/*_rans",
    // ALP offsets over FastPFOR
    "0x02/prop_f64_alp_offset_np",
    // shared dictionary columns
    "0x02/props_shared_dict*",
    // v2-only data: m-values, nested properties, z coordinates
    "0x02/mvalues*",
    "0x02/nested_*",
    "0x02/z_*",
];
