//! Geometry inspection and projection: `GeoJSON` [`GeometryValue`] -> tile-local
//! [`Wkt<i32>`].
//!
//! Z presence is detected globally by the orchestrator, which passes a single
//! [`Dimension`] down so every geometry in a layer shares one dimension (the
//! encoder requires one dimension per geometry column). In a 3D layer,
//! originally-2D positions are padded with `z = Some(0)` by [`super::project`].

use geojson::{GeometryValue, Position};
use mlt_core::wkt::Wkt;
use mlt_core::wkt::types::{
    Coord, Dimension, LineString, MultiLineString, MultiPoint, MultiPolygon, Point, Polygon,
};

use super::project::tile_local;

/// Read longitude, latitude, and optional altitude from a `GeoJSON` position
/// without panicking on short coordinate arrays.
fn lon_lat_alt(pos: &Position) -> Option<(f64, f64, Option<f64>)> {
    let s = pos.as_slice();
    let lon = *s.first()?;
    let lat = *s.get(1)?;
    Some((lon, lat, s.get(2).copied()))
}

/// Inspection helpers on the foreign [`GeometryValue`] type.
///
/// `GeometryValue` is defined in the `geojson` crate, so these are added through
/// an extension trait rather than an inherent `impl`.
pub(super) trait GeometryValueExt {
    /// Iterate every position in the geometry, recursing into nested collections.
    fn positions(&self) -> Box<dyn Iterator<Item = &Position> + '_>;

    /// Whether any position in the geometry carries a Z coordinate.
    fn has_z(&self) -> bool {
        self.positions().any(|p| p.as_slice().len() >= 3)
    }

    /// Longitude/latitude bounding box `(min_lon, min_lat, max_lon, max_lat)` of
    /// the geometry, or `None` if it has no usable positions.
    fn lonlat_bbox(&self) -> Option<(f64, f64, f64, f64)> {
        let mut bbox: Option<(f64, f64, f64, f64)> = None;
        for pos in self.positions() {
            let Some((lon, lat, _)) = lon_lat_alt(pos) else {
                continue;
            };
            bbox = Some(match bbox {
                Some((min_lon, min_lat, max_lon, max_lat)) => (
                    min_lon.min(lon),
                    min_lat.min(lat),
                    max_lon.max(lon),
                    max_lat.max(lat),
                ),
                None => (lon, lat, lon, lat),
            });
        }
        bbox
    }
}

impl GeometryValueExt for GeometryValue {
    fn positions(&self) -> Box<dyn Iterator<Item = &Position> + '_> {
        match self {
            Self::Point { coordinates } => Box::new(std::iter::once(coordinates)),
            Self::MultiPoint { coordinates } | Self::LineString { coordinates } => {
                Box::new(coordinates.iter())
            }
            Self::MultiLineString { coordinates } | Self::Polygon { coordinates } => {
                Box::new(coordinates.iter().flatten())
            }
            Self::MultiPolygon { coordinates } => Box::new(coordinates.iter().flatten().flatten()),
            Self::GeometryCollection { geometries } => {
                Box::new(geometries.iter().flat_map(|g| g.value.positions()))
            }
        }
    }
}

/// Project one position into a tile-local [`Coord`], padding/truncating Z to the
/// layer dimension via [`tile_local`].
fn project_pos(
    pos: &Position,
    dim: Dimension,
    zoom: u8,
    col: u32,
    row: u32,
    extent: u32,
) -> Coord<i32> {
    let (lon, lat, alt) = lon_lat_alt(pos).unwrap_or((0.0, 0.0, None));
    tile_local(lon, lat, alt, zoom, col, row, extent, dim == Dimension::XYZ)
}

fn project_line(
    coords: &[Position],
    dim: Dimension,
    zoom: u8,
    col: u32,
    row: u32,
    extent: u32,
) -> LineString<i32> {
    let coords = coords
        .iter()
        .map(|p| project_pos(p, dim, zoom, col, row, extent))
        .collect();
    LineString::new(coords, dim)
}

fn project_polygon(
    rings: &[Vec<Position>],
    dim: Dimension,
    zoom: u8,
    col: u32,
    row: u32,
    extent: u32,
) -> Polygon<i32> {
    let rings = rings
        .iter()
        .map(|r| project_line(r, dim, zoom, col, row, extent))
        .collect();
    Polygon::new(rings, dim)
}

/// Project a whole geometry into tile-local coordinates, stamping the supplied
/// layer [`Dimension`] on every container.
///
/// Returns `None` for an empty geometry or a `GeometryCollection` (rejected
/// upstream by the orchestrator, so this branch is not expected to be reached).
pub(super) fn project_geometry(
    value: &GeometryValue,
    dim: Dimension,
    zoom: u8,
    col: u32,
    row: u32,
    extent: u32,
) -> Option<Wkt<i32>> {
    let wkt = match value {
        GeometryValue::Point { coordinates } => Wkt::Point(Point::new(
            Some(project_pos(coordinates, dim, zoom, col, row, extent)),
            dim,
        )),
        GeometryValue::LineString { coordinates } => {
            Wkt::LineString(project_line(coordinates, dim, zoom, col, row, extent))
        }
        GeometryValue::Polygon { coordinates } => {
            Wkt::Polygon(project_polygon(coordinates, dim, zoom, col, row, extent))
        }
        GeometryValue::MultiPoint { coordinates } => {
            let points = coordinates
                .iter()
                .map(|p| Point::new(Some(project_pos(p, dim, zoom, col, row, extent)), dim))
                .collect();
            Wkt::MultiPoint(MultiPoint::new(points, dim))
        }
        GeometryValue::MultiLineString { coordinates } => {
            let lines = coordinates
                .iter()
                .map(|l| project_line(l, dim, zoom, col, row, extent))
                .collect();
            Wkt::MultiLineString(MultiLineString::new(lines, dim))
        }
        GeometryValue::MultiPolygon { coordinates } => {
            let polys = coordinates
                .iter()
                .map(|poly| project_polygon(poly, dim, zoom, col, row, extent))
                .collect();
            Wkt::MultiPolygon(MultiPolygon::new(polys, dim))
        }
        // Rejected by the orchestrator before reaching here.
        GeometryValue::GeometryCollection { .. } => return None,
    };
    Some(wkt)
}
