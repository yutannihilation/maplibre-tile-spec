//! A [`LayerWriter`] holding the features of a [`TileLayer`] encodes to the same MLT and MVT
//! bytes.

use std::fs;
use std::path::Path;

use geo_types::Coord;
use mlt_core::encoder::EncoderConfig;
use mlt_core::fast_mvt::MvtTileBuilder;
use mlt_core::geo_traits::{
    CoordTrait, GeometryTrait, GeometryType as GeoKind, LineStringTrait, MultiLineStringTrait,
    MultiPointTrait, MultiPolygonTrait, PointTrait, PolygonTrait,
};
use mlt_core::mvt::{mvt_to_tile_layers, tile_layers_to_mvt};
use mlt_core::{FeatureWriter, LayerWriter, MltResult, TileLayer};
use test_each_file::test_each_path;

test_each_path! { for ["mvt"] in "../test/fixtures" as fixtures => writer_encodes_like_tile_layer }

fn writer_encodes_like_tile_layer([path]: [&Path; 1]) {
    let layers = mvt_to_tile_layers(fs::read(path).expect("read fixture")).expect("decode fixture");
    let base = EncoderConfig::default();
    let sorted = base
        .with_spatial_morton_sort(true)
        .with_spatial_hilbert_sort(true)
        .with_id_sort(true);
    for layer in layers {
        let writer = write(&layer).expect("write layer");
        for cfg in [base, sorted, base.with_tessellation(true)] {
            assert_eq!(
                writer.encode(cfg).expect("encode writer"),
                layer.encode(cfg).expect("encode layer"),
                "{}: layer {}",
                path.display(),
                layer.name()
            );
        }
        let mvt = |r: MltResult<Vec<u8>>| r.map_err(|e| e.to_string());
        assert_eq!(
            mvt(writer
                .write_mvt(MvtTileBuilder::new())
                .map(MvtTileBuilder::encode)),
            mvt(tile_layers_to_mvt([&layer])),
            "{}: MVT layer {}",
            path.display(),
            layer.name()
        );
    }
}

/// The features of `layer`, written one at a time.
fn write(layer: &TileLayer) -> MltResult<LayerWriter<'_>> {
    let mut writer = LayerWriter::new(layer.name(), layer.extent().get())?;
    let keys = (layer.property_names().iter().zip(layer.property_kinds()))
        .map(|(name, &kind)| writer.add_property(name, kind))
        .collect::<MltResult<Vec<_>>>()?;
    for feature in layer.features() {
        let geometry = feature.geometry();
        let mut out = writer.feature(geometry.geometry_type());
        out.id(feature.id());
        match geometry.as_type() {
            GeoKind::Point(p) => {
                out.points(PointTrait::coord(p).map(Coord::from))?;
            }
            GeoKind::MultiPoint(mp) => {
                out.points(mp.points().filter_map(|p| p.coord().map(Coord::from)))?;
            }
            GeoKind::LineString(ls) => {
                out.line(LineStringTrait::coords(ls).map(Coord::from))?;
            }
            GeoKind::MultiLineString(mls) => {
                for ls in mls.line_strings() {
                    out.line(ls.coords().map(Coord::from))?;
                }
            }
            GeoKind::Polygon(p) => rings(&mut out, p)?,
            GeoKind::MultiPolygon(mp) => {
                for p in mp.polygons() {
                    rings(&mut out, &p)?;
                }
            }
            GeoKind::Line(_)
            | GeoKind::GeometryCollection(_)
            | GeoKind::Rect(_)
            | GeoKind::Triangle(_) => unreachable!("a feature geometry is one of the six kinds"),
        }
        for (&key, value) in keys.iter().zip(feature.properties()) {
            if let Some(value) = value.value_ref() {
                out.property(key, value)?;
            }
        }
        out.finish()?;
    }
    Ok(writer)
}

fn xy(c: &impl CoordTrait<T = i32>) -> Coord<i32> {
    Coord { x: c.x(), y: c.y() }
}

/// The polygon's rings as the writer takes them: an exterior, open or closed, then holes.
fn rings(out: &mut FeatureWriter<'_, '_>, polygon: &impl PolygonTrait<T = i32>) -> MltResult<()> {
    let exterior: Vec<Coord<i32>> = polygon
        .exterior()
        .into_iter()
        .flat_map(|e| e.coords().map(|c| xy(&c)).collect::<Vec<_>>())
        .collect();
    out.exterior_ring(exterior)?;
    for hole in polygon.interiors() {
        out.hole(hole.coords().map(|c| xy(&c)))?;
    }
    Ok(())
}
