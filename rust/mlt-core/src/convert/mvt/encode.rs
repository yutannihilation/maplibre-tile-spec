//! Encode layers as MVT (Mapbox Vector Tile) bytes

use std::borrow::Borrow;

use fast_mvt::{MvtFeatureBuilder, MvtGeomType, MvtLayerBuilder, MvtTileBuilder, MvtValueRef};
use geo_traits::{
    GeometryTrait, GeometryType as GeoKind, LineStringTrait, MultiLineStringTrait, MultiPointTrait,
    MultiPolygonTrait, PointTrait, PolygonTrait,
};
use geo_types::Coord;

use crate::encoder::LayerSource;
use crate::tile::TileLayer;
use crate::{MltError, MltResult, PropValueRef};

/// Encode row-oriented [`TileLayer`]s as MVT (Mapbox Vector Tile) bytes.
pub fn tile_layers_to_mvt(
    layers: impl IntoIterator<Item = impl Borrow<TileLayer>>,
) -> MltResult<Vec<u8>> {
    let mut tile = MvtTileBuilder::new();
    for layer in layers {
        tile = write_mvt_layer(layer.borrow(), tile)?;
    }
    Ok(tile.encode())
}

/// Adds `source` to `tile`, writing each feature straight from the source.
pub(crate) fn write_mvt_layer(
    source: &impl LayerSource,
    tile: MvtTileBuilder,
) -> MltResult<MvtTileBuilder> {
    if source.name().is_empty() {
        return Err(MltError::MissingLayerName);
    }
    let mut layer = tile.layer(source.name())?;
    layer.extent(source.extent().into());
    for feature in 0..source.feature_count() {
        let mut out = source.mvt_feature(feature, layer)?;
        out.id(source.id(feature));
        for column in 0..source.property_count() {
            if let Some(value) = source.property(feature, column) {
                out.tag_ref(source.property_name(column), value.into())?;
            }
        }
        layer = out.end();
    }
    Ok(layer.end())
}

/// Starts a feature of `geometry` in `layer`, with its geometry written.
///
/// Rings go in as stored, closing vertex or not: the MVT writer closes them itself.
pub(crate) fn mvt_feature_of(
    geometry: &impl GeometryTrait<T = i32>,
    layer: MvtLayerBuilder,
) -> MltResult<MvtFeatureBuilder> {
    fn xy(c: &impl geo_traits::CoordTrait<T = i32>) -> Coord<i32> {
        Coord { x: c.x(), y: c.y() }
    }
    fn line(l: &impl LineStringTrait<T = i32>) -> impl Iterator<Item = Coord<i32>> + '_ {
        l.coords().map(|c| xy(&c))
    }
    fn polygon(out: &mut MvtFeatureBuilder, p: &impl PolygonTrait<T = i32>) -> MltResult<()> {
        if let Some(exterior) = p.exterior() {
            out.ring(line(&exterior), true)?;
        }
        for interior in p.interiors() {
            out.ring(line(&interior), false)?;
        }
        Ok(())
    }
    Ok(match geometry.as_type() {
        GeoKind::Point(p) => {
            let mut out = layer.feature_of(MvtGeomType::Point);
            out.points(p.coord().map(|c| xy(&c)))?;
            out
        }
        GeoKind::MultiPoint(mp) => {
            let mut out = layer.feature_of(MvtGeomType::Point);
            out.points(mp.points().filter_map(|p| p.coord().map(|c| xy(&c))))?;
            out
        }
        GeoKind::LineString(l) => {
            let mut out = layer.feature_of(MvtGeomType::LineString);
            out.line(line(l))?;
            out
        }
        GeoKind::MultiLineString(mls) => {
            let mut out = layer.feature_of(MvtGeomType::LineString);
            for l in mls.line_strings() {
                out.line(line(&l))?;
            }
            out
        }
        GeoKind::Polygon(p) => {
            let mut out = layer.feature_of(MvtGeomType::Polygon);
            polygon(&mut out, p)?;
            out
        }
        GeoKind::MultiPolygon(mp) => {
            let mut out = layer.feature_of(MvtGeomType::Polygon);
            for p in mp.polygons() {
                polygon(&mut out, &p)?;
            }
            out
        }
        GeoKind::GeometryCollection(_)
        | GeoKind::Rect(_)
        | GeoKind::Triangle(_)
        | GeoKind::Line(_) => {
            return Err(MltError::GeometryCollectionUnsupported);
        }
    })
}

impl<'a> From<PropValueRef<'a>> for MvtValueRef<'a> {
    fn from(value: PropValueRef<'a>) -> Self {
        match value {
            PropValueRef::Bool(v) => Self::Bool(v),
            PropValueRef::I8(v) => Self::SInt(v.into()),
            PropValueRef::U8(v) => Self::UInt(v.into()),
            PropValueRef::I32(v) => Self::SInt(v.into()),
            PropValueRef::U32(v) => Self::UInt(v.into()),
            PropValueRef::I64(v) => Self::SInt(v),
            PropValueRef::U64(v) => Self::UInt(v),
            PropValueRef::F32(v) => Self::Float(v),
            PropValueRef::F64(v) => Self::Double(v),
            PropValueRef::Str(v) => Self::String(v),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::FeatureGeometry;
    use crate::mvt::mvt_to_tile_layers;
    use crate::tile::{Extent, TileFeature};
    use geo_traits::to_geo::ToGeoGeometry as _;

    #[test]
    fn empty_input_yields_empty_output() {
        let bytes = tile_layers_to_mvt(Vec::<TileLayer>::new()).unwrap();
        let decoded = mvt_to_tile_layers(bytes).unwrap();
        assert_eq!(decoded, [] as [TileLayer; 0]);
    }

    #[test]
    fn rejects_empty_layer_name() {
        let layer = TileLayer {
            name: String::new(),
            extent: Extent::new(4096).unwrap(),
            property_names: vec![],
            property_kinds: vec![],
            #[cfg(feature = "unstable-v2")]
            m_value_names: vec![],
            #[cfg(feature = "unstable-v2")]
            m_value_kinds: vec![],
            #[cfg(feature = "unstable-v2")]
            nested_names: vec![],
            #[cfg(feature = "unstable-v2")]
            nested_kinds: vec![],
            #[cfg(feature = "unstable-v2")]
            z_step: None,
            features: vec![],
        };

        assert!(matches!(
            tile_layers_to_mvt(vec![layer]),
            Err(MltError::MissingLayerName)
        ));
    }

    /// `ClosePath` repeats the first vertex; an input with the closing
    /// duplicate must therefore round-trip without growing extra vertices.
    #[test]
    fn ring_is_implicitly_closed() {
        use geo_types::{Geometry, LineString, Polygon};
        let ring = vec![
            (0_i32, 0_i32).into(),
            (10, 0).into(),
            (10, 10).into(),
            (0, 10).into(),
            (0, 0).into(),
        ];
        let layer = TileLayer::from_parts(
            "L",
            4096,
            vec![],
            vec![TileFeature {
                id: Some(1),
                geometry: FeatureGeometry::from_geometry(&Geometry::Polygon(Polygon::new(
                    LineString(ring),
                    vec![],
                )))
                .unwrap(),
                properties: vec![],
                #[cfg(feature = "unstable-v2")]
                m_values: vec![],
                #[cfg(feature = "unstable-v2")]
                nested: vec![],
            }],
        )
        .unwrap();
        let bytes = tile_layers_to_mvt(vec![layer]).unwrap();
        let back = mvt_to_tile_layers(bytes).unwrap();
        let geometry = back[0].features()[0].geometry().to_geometry();
        let Geometry::Polygon(p) = geometry else {
            panic!("expected polygon, got {geometry:?}");
        };
        assert_eq!(p.exterior().0.len(), 5);
        assert_eq!(p.exterior().0.first(), p.exterior().0.last());
    }
}
