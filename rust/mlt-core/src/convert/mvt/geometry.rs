//! MVT geometry commands decoded straight into a [`FeatureGeometry`], following the rules of
//! fast-mvt's own decoder so both read every command stream alike, without building a
//! `geo-types` tree in between.

use fast_mvt::MvtError;
use fast_mvt::proto::GeomType;
use usize_cast::IntoUsize as _;

use crate::decoder::GeometryType;
use crate::feature_geometry::Builder;
use crate::{FeatureGeometry, MltError, MltResult};

/// The geometry of one MVT feature: its declared type and its command words.
///
/// Reads every stream as `fast_mvt::MvtFeatureRef::geometry` followed by
/// [`FeatureGeometry::from_geometry`] would, failing where that fails. A ring is stored as
/// its commands give it, which is what that pair stores too: fast-mvt closes the ring and
/// the conversion drops the closing vertex again.
pub(super) fn decode_geometry(
    geom_type: Option<GeomType>,
    commands: &[u32],
) -> MltResult<FeatureGeometry> {
    if commands.is_empty() {
        let kind = match geom_type {
            Some(GeomType::Point) => GeometryType::MultiPoint,
            Some(GeomType::Linestring) => GeometryType::MultiLineString,
            Some(GeomType::Polygon) => GeometryType::MultiPolygon,
            _ => return Err(invalid()),
        };
        return Ok(Builder::flat(0).finish_as(kind));
    }
    // Every vertex takes two command words, so this bounds the words stored.
    let mut b = Builder::flat(commands.len());
    let kind = match geom_type {
        Some(GeomType::Point) => points(commands, &mut b)?,
        Some(GeomType::Linestring) => lines(commands, &mut b)?,
        Some(GeomType::Polygon) => polygons(commands, &mut b)?,
        _ => return Err(invalid()),
    };
    Ok(b.finish_as(kind))
}

fn invalid() -> MltError {
    MvtError::InvalidGeometry.into()
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Command {
    MoveTo,
    LineTo,
    ClosePath,
}

/// A command word: the command and how many times it repeats.
fn command(word: u32) -> MltResult<(Command, usize)> {
    let command = match word & 0x7 {
        1 => Command::MoveTo,
        2 => Command::LineTo,
        7 => Command::ClosePath,
        _ => return Err(invalid()),
    };
    Ok((command, (word >> 3).into_usize()))
}

/// The pen position, moved by zigzag-encoded deltas that saturate at the `i32` bounds.
#[derive(Default)]
struct Cursor {
    x: i32,
    y: i32,
}

impl Cursor {
    fn advance(&mut self, b: &mut Builder, [dx, dy]: [u32; 2]) {
        let delta = |d: u32| (d >> 1).cast_signed() ^ -(d & 1).cast_signed();
        self.x = self.x.saturating_add(delta(dx));
        self.y = self.y.saturating_add(delta(dy));
        b.push_xy(self.x, self.y);
    }

    fn run(&mut self, b: &mut Builder, params: &[u32]) {
        for &pair in params.as_chunks::<2>().0 {
            self.advance(b, pair);
        }
    }
}

fn points(data: &[u32], b: &mut Builder) -> MltResult<GeometryType> {
    let mut cursor = Cursor::default();
    let mut count = 0_usize;
    let mut offset = 0;
    while offset < data.len() {
        let (command, n) = command(data[offset])?;
        if command != Command::MoveTo {
            return Err(invalid());
        }
        offset += 1;
        let params = data
            .get(offset..offset + n.saturating_mul(2))
            .ok_or_else(invalid)?;
        cursor.run(b, params);
        count += n;
        offset += params.len();
    }
    match count {
        0 => Err(invalid()),
        1 => Ok(GeometryType::Point),
        _ => Ok(GeometryType::MultiPoint),
    }
}

/// One line: a `MoveTo` of at least one vertex, optionally followed by one `LineTo`.
#[derive(Clone, Copy)]
struct Line {
    /// Command words the line takes.
    len: usize,
    moves: usize,
    lines: usize,
}

impl Line {
    fn read(data: &[u32]) -> MltResult<Self> {
        if data.len() < 3 {
            return Err(invalid());
        }
        let (move_to, moves) = command(data[0])?;
        if move_to != Command::MoveTo || moves == 0 {
            return Err(invalid());
        }
        let move_len = 1 + moves.saturating_mul(2);
        if data.len() < move_len {
            return Err(invalid());
        }
        let mut len = move_len;
        let mut lines = 0;
        if data.len() > move_len {
            let (line_to, count) = command(data[move_len])?;
            if line_to == Command::LineTo {
                lines = count;
                len = move_len + 1 + lines.saturating_mul(2);
            }
        }
        if data.len() < len {
            return Err(invalid());
        }
        Ok(Self { len, moves, lines })
    }

    /// Store the line's vertices, read from `data`, which [`Self::read`] checked.
    fn store(self, data: &[u32], cursor: &mut Cursor, b: &mut Builder) {
        let move_end = 1 + self.moves * 2;
        cursor.run(b, &data[1..move_end]);
        if self.lines > 0 {
            cursor.run(b, &data[move_end + 1..move_end + 1 + self.lines * 2]);
        }
    }
}

fn lines(data: &[u32], b: &mut Builder) -> MltResult<GeometryType> {
    let mut cursor = Cursor::default();
    let mut count = 0_usize;
    let mut offset = 0;
    while offset < data.len() {
        let line = Line::read(&data[offset..])?;
        line.store(&data[offset..], &mut cursor, b);
        b.end_part()?;
        count += 1;
        offset += line.len;
    }
    match count {
        0 => Err(invalid()),
        1 => Ok(GeometryType::LineString),
        _ => Ok(GeometryType::MultiLineString),
    }
}

/// Twice the signed area of a ring given as `x y` words; positive for an exterior ring in
/// MVT's y-down coordinates.
fn signed_area(words: &[i32]) -> i64 {
    let (pairs, _) = words.as_chunks::<2>();
    let Some((&first, _)) = pairs.split_first() else {
        return 0;
    };
    let cross = |[ax, ay]: [i32; 2], [bx, by]: [i32; 2]| {
        i64::from(ax) * i64::from(by) - i64::from(ay) * i64::from(bx)
    };
    let mut area = 0_i64;
    for pair in pairs.windows(2) {
        area += cross(pair[0], pair[1]);
    }
    area + cross(pairs[pairs.len() - 1], first)
}

/// Rings group into polygons: a ring with positive area, or the first ring, starts a polygon,
/// and every other ring is a hole of the polygon before it.
fn polygons(data: &[u32], b: &mut Builder) -> MltResult<GeometryType> {
    let mut cursor = Cursor::default();
    let mut count = 0_usize;
    let mut offset = 0;
    while offset < data.len() {
        let ring = Line::read(&data[offset..])?;
        let (close, n) = command(*data.get(offset + ring.len).ok_or_else(invalid)?)?;
        if close != Command::ClosePath || n != 1 {
            return Err(invalid());
        }
        let start = b.words().len();
        ring.store(&data[offset..], &mut cursor, b);
        if signed_area(&b.words()[start..]) > 0 || count == 0 {
            if count > 0 {
                b.end_polygon()?;
            }
            count += 1;
        }
        b.end_part()?;
        offset += ring.len + 1;
    }
    if count > 0 {
        b.end_polygon()?;
    }
    match count {
        0 => Err(invalid()),
        1 => Ok(GeometryType::Polygon),
        _ => Ok(GeometryType::MultiPolygon),
    }
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::Path;

    use fast_mvt::MvtReaderRef;
    use proptest::prelude::*;
    use rstest::rstest;

    use super::*;
    use crate::MltError;

    /// What fast-mvt makes of a feature, converted the way mlt-core did before.
    fn oracle(feature: fast_mvt::MvtFeatureRef<'_>) -> Result<FeatureGeometry, String> {
        feature
            .geometry()
            .map_err(MltError::from)
            .and_then(|g| FeatureGeometry::from_geometry(&g))
            .map_err(|e| e.to_string())
    }

    fn direct(feature: fast_mvt::MvtFeatureRef<'_>) -> Result<FeatureGeometry, String> {
        decode_geometry(feature.geom_type(), feature.geometry_commands()).map_err(|e| e.to_string())
    }

    fn varint(mut value: u64, out: &mut Vec<u8>) {
        loop {
            let byte = u8::try_from(value & 0x7f).expect("masked");
            value >>= 7;
            if value == 0 {
                out.push(byte);
                return;
            }
            out.push(byte | 0x80);
        }
    }

    fn length_delimited(tag: u8, body: &[u8], out: &mut Vec<u8>) {
        out.push(tag);
        varint(u64::try_from(body.len()).expect("small"), out);
        out.extend_from_slice(body);
    }

    /// A tile of one layer `l` holding one feature of `geom_type` (omitted when `None`).
    fn one_feature_tile(geom_type: Option<u64>, commands: &[u32]) -> Vec<u8> {
        let mut feature = Vec::new();
        if let Some(t) = geom_type {
            feature.push(3 << 3); // type, varint
            varint(t, &mut feature);
        }
        let mut packed = Vec::new();
        for &c in commands {
            varint(u64::from(c), &mut packed);
        }
        length_delimited(4 << 3 | 2, &packed, &mut feature); // geometry, packed
        let mut layer = vec![15 << 3, 2]; // version 2
        length_delimited(1 << 3 | 2, b"l", &mut layer);
        length_delimited(2 << 3 | 2, &feature, &mut layer);
        let mut tile = Vec::new();
        length_delimited(3 << 3 | 2, &layer, &mut tile);
        tile
    }

    fn assert_same(geom_type: Option<u64>, commands: &[u32]) {
        let tile = one_feature_tile(geom_type, commands);
        let reader = MvtReaderRef::new(&tile).expect("a well-formed tile");
        let layer = reader.layers().next().expect("one layer");
        let feature = layer.features().next().expect("one feature");
        assert_eq!(
            direct(feature),
            oracle(feature),
            "type {geom_type:?}, commands {commands:?}"
        );
    }

    const POINT: Option<u64> = Some(1);
    const LINE: Option<u64> = Some(2);
    const POLYGON: Option<u64> = Some(3);

    #[rstest]
    #[case::one_point(POINT, &[9, 2, 2])]
    #[case::two_points_in_one_move(POINT, &[17, 2, 2, 4, 4])]
    #[case::points_over_two_moves(POINT, &[9, 2, 2, 9, 3, 3])]
    #[case::a_move_of_no_points_then_one(POINT, &[1, 9, 2, 2])]
    #[case::only_moves_of_no_points(POINT, &[1, 1])]
    #[case::a_line_command_in_points(POINT, &[17, 1, 2])]
    #[case::a_short_point(POINT, &[9, 0])]
    #[case::a_line(LINE, &[9, 0, 0, 18, 20, 0, 0, 20])]
    #[case::a_move_only_line(LINE, &[9, 4, 6])]
    #[case::two_move_only_lines(LINE, &[9, 4, 6, 9, 2, 2])]
    #[case::a_line_of_two_moves(LINE, &[17, 0, 0, 4, 4, 10, 2, 2])]
    #[case::a_line_to_of_none(LINE, &[9, 0, 0, 2])]
    #[case::two_lines(LINE, &[9, 2, 2, 10, 4, 4, 9, 6, 6, 10, 2, 2])]
    #[case::a_truncated_line(LINE, &[9, 0])]
    #[case::a_line_cut_short(LINE, &[9, 0, 0, 18])]
    #[case::a_line_starting_with_line_to(LINE, &[10, 0, 0])]
    #[case::a_close_in_a_line(LINE, &[9, 0, 0, 10, 2, 2, 15])]
    #[case::a_square(POLYGON, &[9, 0, 0, 26, 20, 0, 0, 20, 19, 0, 15])]
    #[case::a_one_vertex_ring(POLYGON, &[9, 0, 0, 15])]
    #[case::a_ring_from_two_moves(POLYGON, &[17, 0, 0, 10, 0, 15])]
    #[case::an_explicitly_closed_ring(POLYGON, &[9, 0, 0, 34, 20, 0, 0, 20, 19, 0, 0, 19, 15])]
    #[case::a_square_with_a_hole(POLYGON, &[
        9, 0, 0, 26, 40, 0, 0, 40, 39, 0, 15,
        9, 10, 9, 26, 0, 20, 20, 0, 0, 19, 15,
    ])]
    #[case::two_squares(POLYGON, &[
        9, 0, 0, 26, 20, 0, 0, 20, 19, 0, 15,
        9, 60, 19, 26, 20, 0, 0, 20, 19, 0, 15,
    ])]
    #[case::a_hole_first(POLYGON, &[9, 10, 10, 26, 0, 20, 20, 0, 0, 19, 15])]
    #[case::a_flat_ring_after_an_exterior(POLYGON, &[
        9, 0, 0, 26, 20, 0, 0, 20, 19, 0, 15,
        9, 2, 2, 18, 2, 0, 2, 0, 15,
    ])]
    #[case::a_ring_without_close(POLYGON, &[9, 0, 0, 8])]
    #[case::a_ring_closed_twice(POLYGON, &[9, 0, 0, 26, 20, 0, 0, 20, 19, 0, 23])]
    #[case::a_bare_ring(POLYGON, &[9, 0, 0])]
    #[case::an_unknown_command(POLYGON, &[11, 0, 0])]
    #[case::a_huge_count(POINT, &[0xffff_fff9, 0, 0])]
    #[case::saturating_coordinates(LINE, &[9, 0xffff_fffe, 0xffff_fffe, 10, 0xffff_fffe, 0xffff_fffe])]
    #[case::no_commands_point(POINT, &[])]
    #[case::no_commands_line(LINE, &[])]
    #[case::no_commands_polygon(POLYGON, &[])]
    #[case::no_commands_unknown(Some(0), &[])]
    #[case::no_commands_no_type(None, &[])]
    #[case::an_unknown_type(Some(0), &[9, 2, 2])]
    #[case::no_type(None, &[9, 2, 2])]
    #[case::an_out_of_range_type(Some(9), &[9, 2, 2])]
    fn a_command_stream_decodes_as_fast_mvt_does(
        #[case] geom_type: Option<u64>,
        #[case] commands: &[u32],
    ) {
        assert_same(geom_type, commands);
    }

    fn mvt_files(dir: &Path, out: &mut Vec<Vec<u8>>) {
        for entry in fs::read_dir(dir).expect("fixture dir") {
            let path = entry.expect("entry").path();
            if path.is_dir() {
                mvt_files(&path, out);
            } else if path.extension().is_some_and(|e| e == "mvt") {
                out.push(fs::read(&path).expect("read fixture"));
            }
        }
    }

    #[test]
    fn every_fixture_feature_decodes_as_fast_mvt_does() {
        let mut tiles = Vec::new();
        mvt_files(
            &Path::new(env!("CARGO_MANIFEST_DIR")).join("../../test/fixtures"),
            &mut tiles,
        );
        assert_ne!(tiles.len(), 0, "no MVT fixtures found");
        let mut features = 0;
        for tile in &tiles {
            let reader = MvtReaderRef::new(tile).expect("a fixture parses");
            for layer in reader.layers() {
                for feature in layer.features() {
                    assert_eq!(direct(feature), oracle(feature), "{}", layer.name());
                    features += 1;
                }
            }
        }
        assert!(features > 0);
    }

    fn command_word() -> impl Strategy<Value = u32> {
        prop_oneof![
            // MoveTo, LineTo and ClosePath with small counts, and the odd invalid one
            4 => prop::sample::select(vec![1_u32, 9, 17, 25, 2, 10, 18, 26, 34, 7, 15, 23, 3, 11]),
            4 => 0_u32..48,
            1 => any::<u32>(),
        ]
    }

    /// One part as a writer of `geom_type` would emit it, with small zigzag deltas: points
    /// are a `MoveTo`, a line adds a `LineTo`, and a ring adds a `ClosePath` too.
    fn part(geom_type: u64) -> impl Strategy<Value = Vec<u32>> {
        let delta = 0_u32..41;
        let moves = if geom_type == 1 { 1..=4_usize } else { 1..=1 };
        (
            moves.prop_flat_map(move |n| prop::collection::vec(0_u32..41, n * 2)),
            prop::collection::vec(delta, 0..=10),
        )
            .prop_map(move |(moves, lines)| {
                let count = |params: &[u32]| u32::try_from(params.len() / 2).expect("small");
                let mut words = vec![count(&moves) << 3 | 1];
                words.extend_from_slice(&moves);
                if geom_type != 1 {
                    let lines = &lines[..lines.len() / 2 * 2];
                    words.push(count(lines) << 3 | 2);
                    words.extend_from_slice(lines);
                }
                if geom_type == 3 {
                    words.push(15);
                }
                words
            })
    }

    /// The type and a stream of well-formed parts for it, now and then cut short or followed
    /// by a stray word.
    fn structured_stream() -> impl Strategy<Value = (u64, Vec<u32>)> {
        (1_u64..4).prop_flat_map(|geom_type| {
            (
                Just(geom_type),
                prop::collection::vec(part(geom_type), 1..5),
                prop::option::weighted(0.1, 0_usize..60),
                prop::option::weighted(0.1, command_word()),
            )
                .prop_map(|(geom_type, parts, cut, stray)| {
                    let mut words = parts.concat();
                    if let Some(cut) = cut {
                        words.truncate(cut);
                    }
                    words.extend(stray);
                    (geom_type, words)
                })
        })
    }

    proptest! {
        #[test]
        fn any_command_stream_decodes_as_fast_mvt_does(
            geom_type in prop::option::of(0_u64..5),
            commands in prop::collection::vec(command_word(), 0..40),
        ) {
            assert_same(geom_type, &commands);
        }

        #[test]
        fn any_well_formed_stream_decodes_as_fast_mvt_does(
            (geom_type, commands) in structured_stream(),
        ) {
            assert_same(Some(geom_type), &commands);
        }
    }
}
