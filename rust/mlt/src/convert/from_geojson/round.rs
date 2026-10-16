//! Rounding of clipped geometries onto a tile's integer grid, keeping the z of
//! each stored vertex. Vertices that land on their predecessor in x, y, and z
//! are merged, and parts left with too few vertices are dropped. A vertex that
//! only differs in z is kept, so a vertical line or wall keeps its shape.

use mlt_core::geo_traits::Dimensions;
use mlt_core::{FeatureGeometry, Vertex};

use super::EXTENT;
use super::project::{Geom, Vertex as Projected};

/// Round a vertex of the unit square onto a tile's integer grid: `scale` is the
/// grid's size across the whole world at the tile's zoom and `origin` the tile's
/// corner on it. The z is already in grid units, and kept only on a z layer.
#[expect(
    clippy::cast_possible_truncation,
    reason = "clipped x/y lie within -buffer..=extent+buffer of the tile origin, and z was range-checked at projection; a cut point lies between its endpoints"
)]
fn round_vertex(v: &Projected, scale: f64, origin: (f64, f64), keep_z: bool) -> Vertex {
    Vertex {
        x: (v.x * scale - origin.0).round() as i32,
        y: (v.y * scale - origin.1).round() as i32,
        z: keep_z.then(|| v.z.round() as i32),
    }
}

/// Round a run of vertices, dropping any that lands on the previous one in x, y, and z.
fn round_run(vertices: &[Projected], scale: f64, origin: (f64, f64), keep_z: bool) -> Vec<Vertex> {
    let mut run: Vec<Vertex> = Vec::with_capacity(vertices.len());
    for v in vertices {
        let v = round_vertex(v, scale, origin, keep_z);
        if run.last() != Some(&v) {
            run.push(v);
        }
    }
    run
}

/// Round a line, or `None` when fewer than two distinct vertices remain.
fn round_line(
    line: &[Projected],
    scale: f64,
    origin: (f64, f64),
    keep_z: bool,
) -> Option<Vec<Vertex>> {
    let run = round_run(line, scale, origin, keep_z);
    (run.len() >= 2).then_some(run)
}

/// Round an open ring to its stored vertices, or `None` when fewer than three distinct
/// vertices remain. A closing vertex equal to the first is not stored.
fn round_ring(
    open: &[Projected],
    scale: f64,
    origin: (f64, f64),
    keep_z: bool,
) -> Option<Vec<Vertex>> {
    let mut run = round_run(open, scale, origin, keep_z);
    if run.len() > 1 && run.first() == run.last() {
        run.pop();
    }
    (run.len() >= 3).then_some(run)
}

/// Round a polygon's rings, or `None` when its exterior collapses. Holes that
/// collapse are dropped.
fn round_polygon(
    rings: &[Vec<Projected>],
    scale: f64,
    origin: (f64, f64),
    keep_z: bool,
) -> Option<Vec<Vec<Vertex>>> {
    let mut rings = rings.iter();
    let exterior = round_ring(rings.next()?, scale, origin, keep_z)?;
    let holes = rings.filter_map(|r| round_ring(r, scale, origin, keep_z));
    Some(std::iter::once(exterior).chain(holes).collect())
}

/// Round a geometry already clipped to tile `(zoom, col, row)` onto that tile's
/// integer grid, with the z of each stored vertex when `keep_z`. `None` when
/// nothing survives rounding. Multi-part geometries keep their type; a line that
/// was split by clipping arrives here as a `MultiLineString` already.
pub(super) fn to_tile(
    geom: &Geom,
    zoom: u8,
    col: u32,
    row: u32,
    keep_z: bool,
) -> Option<FeatureGeometry> {
    let extent = f64::from(EXTENT);
    let scale = f64::from(1_u32 << zoom) * extent;
    let origin = (f64::from(col) * extent, f64::from(row) * extent);
    let dim = if keep_z {
        Dimensions::Xyz
    } else {
        Dimensions::Xy
    };
    let built = match geom {
        Geom::Point(v) => Ok(FeatureGeometry::point(round_vertex(
            v, scale, origin, keep_z,
        ))),
        Geom::MultiPoint(points) => FeatureGeometry::multi_point(
            dim,
            points
                .iter()
                .map(|v| round_vertex(v, scale, origin, keep_z)),
        ),
        Geom::LineString(line) => {
            FeatureGeometry::line_string(dim, round_line(line, scale, origin, keep_z)?)
        }
        Geom::MultiLineString(parts) => {
            let lines: Vec<_> = parts
                .iter()
                .filter_map(|p| round_line(p, scale, origin, keep_z))
                .collect();
            if lines.is_empty() {
                return None;
            }
            FeatureGeometry::multi_line_string(dim, lines)
        }
        Geom::Polygon(rings) => {
            FeatureGeometry::polygon(dim, round_polygon(rings, scale, origin, keep_z)?)
        }
        Geom::MultiPolygon(polygons) => {
            let polygons: Vec<_> = polygons
                .iter()
                .filter_map(|p| round_polygon(p, scale, origin, keep_z))
                .collect();
            if polygons.is_empty() {
                return None;
            }
            FeatureGeometry::multi_polygon(dim, polygons)
        }
    };
    Some(built.expect("every rounded vertex has the layer's dimension"))
}

#[cfg(test)]
mod tests {
    use mlt_core::GeometryType;

    use super::*;

    fn v(x: f64, y: f64, z: f64) -> Projected {
        Projected { x, y, z }
    }

    const ORIGIN: (f64, f64) = (0.0, 0.0);

    #[test]
    fn a_ring_keeps_its_stored_vertices_and_their_z() {
        let open = [
            v(0.2, 0.0, 1.0),
            v(10.0, 0.0, 2.0),
            v(10.0, 10.0, 3.0),
            v(0.0, 10.0, 4.4),
        ];
        let ring = round_ring(&open, 1.0, ORIGIN, true).unwrap();
        assert_eq!(ring.len(), 4, "the closing vertex is not stored");
        let z: Vec<i32> = ring.iter().map(|v| v.z.unwrap()).collect();
        assert_eq!(z, [1, 2, 3, 4]);
    }

    #[test]
    fn a_ring_collapsing_under_rounding_is_dropped() {
        let open = [v(0.1, 0.1, 0.0), v(0.2, 0.2, 0.0), v(0.3, 0.1, 0.0)];
        assert!(round_ring(&open, 1.0, ORIGIN, true).is_none());
    }

    #[test]
    fn a_closed_input_ring_is_not_double_closed() {
        let open = [
            v(0.0, 0.0, 0.0),
            v(10.0, 0.0, 0.0),
            v(10.0, 10.0, 0.0),
            v(0.0, 0.0, 0.0),
        ];
        let ring = round_ring(&open, 1.0, ORIGIN, true).unwrap();
        assert_eq!(ring.len(), 3);
    }

    #[test]
    fn to_tile_rounds_onto_the_tile_grid() {
        let geom = Geom::LineString(vec![v(0.25, 0.5, 0.4), v(0.5, 0.5, 100.6)]);
        let geometry = to_tile(&geom, 1, 0, 0, true).unwrap();
        assert_eq!(geometry.geometry_type(), GeometryType::LineString);
        let xy: Vec<(i32, i32)> = geometry.vertices().map(|v| (v.x, v.y)).collect();
        assert_eq!(xy, [(2048, 4096), (4096, 4096)]);
        let z: Vec<i32> = geometry.z().unwrap().collect();
        assert_eq!(z, [0, 101]);
    }

    #[test]
    fn a_multi_line_string_losing_every_part_to_rounding_is_dropped() {
        let geom = Geom::MultiLineString(vec![vec![v(0.5, 0.5, 1.0), v(0.500_000_01, 0.5, 1.2)]]);
        assert!(to_tile(&geom, 0, 0, 0, true).is_none());
    }

    #[test]
    fn a_vertical_line_keeps_both_ends() {
        let geom = Geom::LineString(vec![v(0.5, 0.5, 0.0), v(0.5, 0.5, 10.0)]);
        let geometry = to_tile(&geom, 0, 0, 0, true).unwrap();
        let xy: Vec<(i32, i32)> = geometry.vertices().map(|v| (v.x, v.y)).collect();
        assert_eq!(xy, [(2048, 2048); 2]);
        let z: Vec<i32> = geometry.z().unwrap().collect();
        assert_eq!(z, [0, 10]);
    }

    #[test]
    fn a_vertical_ring_keeps_its_four_corners() {
        let open = [
            v(0.0, 0.0, 0.0),
            v(10.0, 0.0, 0.0),
            v(10.0, 0.0, 5.0),
            v(0.0, 0.0, 5.0),
        ];
        let ring = round_ring(&open, 1.0, ORIGIN, true).unwrap();
        assert_eq!(ring.len(), 4);
        let z: Vec<i32> = ring.iter().map(|v| v.z.unwrap()).collect();
        assert_eq!(z, [0, 0, 5, 5]);
    }

    #[test]
    fn a_ring_ending_above_its_start_is_not_closed_early() {
        let open = [v(0.0, 0.0, 0.0), v(10.0, 0.0, 0.0), v(0.0, 0.0, 5.0)];
        let ring = round_ring(&open, 1.0, ORIGIN, true).unwrap();
        assert_eq!(ring.len(), 3);
        let z: Vec<i32> = ring.iter().map(|v| v.z.unwrap()).collect();
        assert_eq!(z, [0, 0, 5]);
    }

    #[test]
    fn a_polygon_whose_hole_collapses_keeps_only_the_shell() {
        let rings = vec![
            vec![
                v(0.0, 0.0, 1.0),
                v(10.0, 0.0, 1.0),
                v(10.0, 10.0, 1.0),
                v(0.0, 10.0, 1.0),
            ],
            vec![v(5.0, 5.0, 2.0), v(5.1, 5.0, 2.0), v(5.1, 5.1, 2.0)],
        ];
        let polygon = round_polygon(&rings, 1.0, ORIGIN, true).unwrap();
        assert_eq!(polygon.len(), 1, "the hole is gone");
        let z: Vec<i32> = polygon[0].iter().map(|v| v.z.unwrap()).collect();
        assert_eq!(z, [1; 4]);
    }
}
