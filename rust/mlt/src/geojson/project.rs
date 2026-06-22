//! Pure projection math: WGS84 lon/lat/alt -> tile-local integer grid coordinates.
//!
//! All functions here are deterministic and side-effect free so they can be unit
//! tested directly against known map points.

use martin_tile_utils::{EARTH_CIRCUMFERENCE, wgs84_to_webmercator};
use mlt_core::wkt::types::Coord;

/// Latitude bound of the Web Mercator projection. Latitudes are clamped here so
/// `wgs84_to_webmercator` never produces infinities at the poles.
const MAX_LAT: f64 = 85.051_128_779_806_59;

/// Project a single WGS84 position into the tile-local integer grid of tile
/// `(zoom, col, row)` with the given `extent`.
///
/// X/Y use the standard slippy-map transform (Y is flipped so the tile origin is
/// top-left). When the layer is 3D (`dim_xyz`), Z is encoded with the **same**
/// tile-grid scale as X/Y — `round(alt * extent / tile_len)` — with no origin
/// offset and no `cos(lat)` correction (Option A: self-describing, consistent
/// inverse transform for all three axes). When the layer is 2D, the Z coordinate
/// is `None`.
#[expect(
    clippy::cast_possible_truncation,
    reason = "projected grid coordinates are bounded by realistic extents/zooms and rounded before casting; \
              no-clipping keeps out-of-extent values as-is by design"
)]
#[expect(
    clippy::too_many_arguments,
    reason = "a flat positional signature keeps this pure math fn cheap to unit-test against known map points"
)]
pub(super) fn tile_local(
    lon: f64,
    lat: f64,
    alt: Option<f64>,
    zoom: u8,
    col: u32,
    row: u32,
    extent: u32,
    dim_xyz: bool,
) -> Coord<i32> {
    let lat = lat.clamp(-MAX_LAT, MAX_LAT);
    let (wmx, wmy) = wgs84_to_webmercator(lon, lat);

    let tile_len = EARTH_CIRCUMFERENCE / f64::from(1_u32 << zoom);
    let min_x = -EARTH_CIRCUMFERENCE / 2.0 + f64::from(col) * tile_len;
    let max_y = EARTH_CIRCUMFERENCE / 2.0 - f64::from(row) * tile_len;

    let extent = f64::from(extent);
    let x = ((wmx - min_x) / tile_len * extent).round() as i32;
    // Y is flipped: larger Web Mercator Y (north) maps to smaller tile Y (top).
    let y = ((max_y - wmy) / tile_len * extent).round() as i32;

    let z = if dim_xyz {
        Some(alt.map_or(0, |a| (a * extent / tile_len).round() as i32))
    } else {
        None
    };

    Coord { x, y, z, m: None }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn origin_at_z0_is_tile_center() {
        let c = tile_local(0.0, 0.0, None, 0, 0, 0, 4096, false);
        assert_eq!(c.x, 2048);
        assert_eq!(c.y, 2048);
        assert_eq!(c.z, None);
    }

    #[test]
    fn origin_at_z1_lands_on_shared_corner() {
        // The equator/prime-meridian origin sits at the meeting corner of the
        // four z1 tiles: bottom-right of (0,0) and top-left of (1,1).
        let c = tile_local(0.0, 0.0, None, 1, 0, 0, 4096, false);
        assert_eq!((c.x, c.y), (4096, 4096));
        let c = tile_local(0.0, 0.0, None, 1, 1, 1, 4096, false);
        assert_eq!((c.x, c.y), (0, 0));
    }

    #[test]
    fn y_axis_is_flipped() {
        let north = tile_local(0.0, 60.0, None, 0, 0, 0, 4096, false);
        let south = tile_local(0.0, -60.0, None, 0, 0, 0, 4096, false);
        assert_eq!((north.x, north.y), (2048, 1189));
        assert_eq!(south.y, 2907);
        // Northern latitudes sit above the center, southern below.
        assert!(north.y < 2048);
        assert!(2048 < south.y);
    }

    #[test]
    fn white_house_z14() {
        // tile_len @ z14 = 2445.984905; z = round(100 * 4096 / 2445.984905) = round(167.498) = 167.
        let c = tile_local(
            -77.036_560,
            38.897_957,
            Some(100.0),
            14,
            4685,
            6267,
            4096,
            true,
        );
        assert_eq!(c.x, 4016);
        assert_eq!(c.y, 2438);
        assert_eq!(c.z, Some(167));
    }

    #[test]
    fn z_uses_same_scale_as_xy() {
        // alt == tile_len -> exactly `extent`; alt == tile_len/4 -> extent/4.
        let tile_len_z14 = 2_445.984_905;
        let c = tile_local(0.0, 0.0, Some(tile_len_z14), 14, 0, 0, 4096, true);
        assert_eq!(c.z, Some(4096));
        let c = tile_local(0.0, 0.0, Some(tile_len_z14 / 4.0), 14, 0, 0, 4096, true);
        assert_eq!(c.z, Some(1024));
    }

    #[test]
    fn z_is_coarse_at_low_zoom() {
        // At z0 the tile spans the whole world, so 100 m rounds to 0 grid units.
        let c = tile_local(0.0, 0.0, Some(100.0), 0, 0, 0, 4096, true);
        assert_eq!(c.z, Some(0));
        // A megameter of altitude is resolvable even at z0.
        let c = tile_local(0.0, 0.0, Some(1_000_000.0), 0, 0, 0, 4096, true);
        assert_eq!(c.z, Some(102));
    }

    #[test]
    fn absent_altitude_in_3d_layer_is_zero() {
        let c = tile_local(0.0, 0.0, None, 14, 0, 0, 4096, true);
        assert_eq!(c.z, Some(0));
    }

    #[test]
    fn altitude_is_dropped_in_2d_layer() {
        let c = tile_local(0.0, 0.0, Some(100.0), 14, 0, 0, 4096, false);
        assert_eq!(c.z, None);
    }
}
