/**
 * The v2 synthetic fixtures (`test/synthetic/0x02`) the decoder cannot handle yet, grouped by the
 * feature they need. A trailing `*` matches every fixture with that prefix.
 *
 * The decoder's synthetic suite asserts that each of these still fails to decode, and the
 * encoder's round-trip suite that each still fails to round-trip, so an entry that starts
 * working fails both until it is removed. Remove entries as v2 support lands; add none.
 */
export const UNIMPLEMENTED_SYNTHETICS_02: readonly string[] = [
    // geometry: layouts, vertex dictionary, Morton, tessellation, rANS
    "0x02/point_morton_dictionary",
    "0x02/point_rans",
    "0x02/extent_*",
    "0x02/line*",
    "0x02/multiline*",
    "0x02/multipoint*",
    "0x02/poly*",
    "0x02/mix_2_l*",
    "0x02/mix_2_m*",
    "0x02/mix_2_po*",
    "0x02/mix_2_pt_l*",
    "0x02/mix_2_pt_m*",
    "0x02/mix_2_pt_po*",
    "0x02/mix_3*",
    "0x02/mix_4*",
    "0x02/mix_5*",
    "0x02/mix_6*",
    "0x02/mix_7*",
    "0x02/mix_pt*",
    // id columns
    "0x02/id*",
    // property columns and presence
    "0x02/prop_*",
    "0x02/props_*",
    "0x02/presence_*",
    "0x02/bool_*",
    // v2-only data: m-values, nested properties, z coordinates
    "0x02/mvalues*",
    "0x02/nested_*",
    "0x02/z_*",
];
