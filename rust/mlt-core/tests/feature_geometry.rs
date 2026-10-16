//! Contracts of `FeatureGeometry`, the owned row geometry with z interleaved
//! (`.tmp/plan/20261015_feature_geometry_phase2_spec.md`, §3, §4, §6).

use std::collections::BTreeMap;
use std::fs;
use std::path::Path;

use mlt_core::encoder::{EncoderConfig, WireVersion};
use mlt_core::geo_traits::to_geo::ToGeoGeometry as _;
use mlt_core::geo_traits::{
    CoordTrait, Dimensions, GeometryTrait, GeometryType as GeoKind, LineStringTrait, PolygonTrait,
};
use mlt_core::geo_types::{
    Coord, Geometry, GeometryCollection, Line, LineString, MultiLineString, MultiPoint,
    MultiPolygon, Point, Polygon, Rect, Triangle,
};
use mlt_core::geojson::{Feature, FeatureCollection};
use mlt_core::test_helpers::{dec, parser};
use mlt_core::{
    Decoder, FeatureGeometry, GeometryType, GeometryValues, Layer, MltError, ParsedLayer,
    ParsedLayer01, Parser, TileFeature, TileLayer, Vertex, ZStep,
};
use test_each_file::test_each_path;

// ───────────────────────────── helpers ─────────────────────────────

fn c(x: i32, y: i32) -> Coord<i32> {
    Coord { x, y }
}

fn v(x: i32, y: i32) -> Vertex {
    Vertex { x, y, z: None }
}

fn vz(x: i32, y: i32, z: i32) -> Vertex {
    Vertex { x, y, z: Some(z) }
}

fn ring(pts: &[(i32, i32)]) -> LineString<i32> {
    LineString(pts.iter().map(|&(x, y)| c(x, y)).collect())
}

fn square_closed() -> Polygon<i32> {
    Polygon::new(ring(&[(0, 0), (10, 0), (10, 10), (0, 10), (0, 0)]), vec![])
}

fn square_open() -> Polygon<i32> {
    Polygon::new(ring(&[(0, 0), (10, 0), (10, 10), (0, 10)]), vec![])
}

fn square_with_hole() -> Polygon<i32> {
    Polygon::new(
        ring(&[(0, 0), (20, 0), (20, 20), (0, 20), (0, 0)]),
        vec![ring(&[(5, 5), (5, 10), (10, 10), (5, 5)])],
    )
}

fn fg(g: &Geometry<i32>) -> FeatureGeometry {
    FeatureGeometry::from_geometry(g).expect("a feature geometry")
}

fn parsed_layers(bytes: &[u8]) -> Vec<ParsedLayer01<'_>> {
    let layers = parser().parse_layers(bytes).expect("parse");
    dec()
        .decode_all(layers)
        .expect("decode")
        .into_iter()
        .filter_map(|layer| match layer {
            ParsedLayer::Tag01(layer) => Some(layer),
            ParsedLayer::Tag02(layer) => Some(layer.into_layer()),
            ParsedLayer::Unknown(_) | _ => None,
        })
        .collect()
}

fn cfg_v2() -> EncoderConfig {
    EncoderConfig::default().with_wire_version(WireVersion::V02)
}

fn step() -> ZStep {
    ZStep::new(-1).unwrap()
}

fn decode_v2(bytes: &[u8]) -> TileLayer {
    let layers = Parser::default().parse_layers(bytes).expect("parse");
    let Layer::Tag02(layer) = layers.into_iter().next().expect("a layer") else {
        panic!("expected a v2 layer")
    };
    layer.into_tile(&mut Decoder::default()).expect("into_tile")
}

fn decode_v1(bytes: &[u8]) -> TileLayer {
    let layers = Parser::default().parse_layers(bytes).expect("parse");
    let Layer::Tag01(layer) = layers.into_iter().next().expect("a layer") else {
        panic!("expected a v1 layer")
    };
    layer.into_tile(&mut Decoder::default()).expect("into_tile")
}

// ───────────────────────────── from_geometry ─────────────────────────────

#[test]
fn from_geometry_keeps_every_simple_kind() {
    let cases: Vec<(Geometry<i32>, GeometryType, usize)> = vec![
        (Geometry::Point(Point::new(1, 2)), GeometryType::Point, 1),
        (
            Geometry::LineString(ring(&[(0, 0), (1, 1), (2, 0)])),
            GeometryType::LineString,
            3,
        ),
        (
            Geometry::Polygon(square_with_hole()),
            GeometryType::Polygon,
            7,
        ),
        (
            Geometry::MultiPoint(MultiPoint(vec![Point::new(0, 0), Point::new(1, 1)])),
            GeometryType::MultiPoint,
            2,
        ),
        (
            Geometry::MultiLineString(MultiLineString(vec![
                ring(&[(0, 0), (1, 1)]),
                ring(&[(2, 2), (3, 3), (4, 4)]),
            ])),
            GeometryType::MultiLineString,
            5,
        ),
        (
            Geometry::MultiPolygon(MultiPolygon(vec![square_closed(), square_with_hole()])),
            GeometryType::MultiPolygon,
            11,
        ),
    ];
    for (geom, kind, vertices) in cases {
        let f = fg(&geom);
        assert_eq!(f.geometry_type(), kind, "{geom:?}");
        assert_eq!(f.dim(), Dimensions::Xy);
        assert_eq!(f.vertex_count(), vertices, "{geom:?}");
        assert_eq!(f.vertices().len(), vertices);
        assert_eq!(f.to_geometry(), geom, "{geom:?}");
        assert!(f.z().is_none());
    }
}

#[test]
fn from_geometry_normalises_rect_triangle_and_line() {
    let rect = Rect::new(c(0, 0), c(4, 2));
    let f = fg(&Geometry::Rect(rect));
    assert_eq!(f.geometry_type(), GeometryType::Polygon);
    assert_eq!(f.vertex_count(), 4);
    assert_eq!(f.to_geometry(), Geometry::Polygon(rect.to_polygon()));

    let tri = Triangle::new(c(0, 0), c(4, 0), c(0, 4));
    let f = fg(&Geometry::Triangle(tri));
    assert_eq!(f.geometry_type(), GeometryType::Polygon);
    assert_eq!(f.vertex_count(), 3);
    assert_eq!(f.to_geometry(), Geometry::Polygon(tri.to_polygon()));

    let line = Line::new(c(0, 0), c(3, 3));
    let f = fg(&Geometry::Line(line));
    assert_eq!(f.geometry_type(), GeometryType::LineString);
    assert_eq!(f.vertex_count(), 2);
    assert_eq!(
        f.to_geometry(),
        Geometry::LineString(LineString(vec![c(0, 0), c(3, 3)]))
    );
}

#[test]
fn an_open_ring_and_its_closed_form_are_the_same_geometry() {
    let open = fg(&Geometry::Polygon(square_open()));
    let closed = fg(&Geometry::Polygon(square_closed()));
    assert_eq!(open, closed);
    assert_eq!(open.vertex_count(), 4);
    assert_eq!(closed.to_geometry(), Geometry::Polygon(square_closed()));
}

#[test]
fn a_geometry_collection_is_rejected() {
    let gc =
        Geometry::GeometryCollection(GeometryCollection(vec![Geometry::Point(Point::new(0, 0))]));
    let err = FeatureGeometry::from_geometry(&gc).unwrap_err();
    assert!(
        matches!(err, MltError::GeometryCollectionUnsupported),
        "{err}"
    );
}

#[test]
fn empty_geometries_are_preserved() {
    let empty_poly = fg(&Geometry::Polygon(Polygon::new(LineString(vec![]), vec![])));
    assert_eq!(empty_poly.vertex_count(), 0);
    assert_eq!(empty_poly.dim(), Dimensions::Xy);
    let GeoKind::Polygon(p) = empty_poly.as_type() else {
        panic!()
    };
    assert!(p.exterior().is_none());
    assert_eq!(
        empty_poly.to_geometry(),
        Geometry::Polygon(Polygon::new(LineString(vec![]), vec![]))
    );

    let empty_multi = fg(&Geometry::MultiPolygon(MultiPolygon(vec![])));
    assert_eq!(empty_multi.vertex_count(), 0);
    assert_eq!(
        empty_multi.to_geometry(),
        Geometry::MultiPolygon(MultiPolygon(vec![]))
    );

    let empty_line = fg(&Geometry::LineString(LineString(vec![])));
    assert_eq!(empty_line.vertex_count(), 0);
}

// ───────────────────────────── constructors and z ─────────────────────────────

#[test]
fn constructors_build_each_kind_from_vertices() {
    let point = FeatureGeometry::point(v(1, 2));
    assert_eq!(point.to_geometry(), Geometry::Point(Point::new(1, 2)));

    let line = FeatureGeometry::line_string(Dimensions::Xy, [v(0, 0), v(1, 1)]).unwrap();
    assert_eq!(
        line.to_geometry(),
        Geometry::LineString(ring(&[(0, 0), (1, 1)]))
    );

    let polygon = FeatureGeometry::polygon(
        Dimensions::Xy,
        [
            vec![v(0, 0), v(20, 0), v(20, 20), v(0, 20), v(0, 0)],
            vec![v(5, 5), v(5, 10), v(10, 10)],
        ],
    )
    .unwrap();
    assert_eq!(polygon.vertex_count(), 7);
    assert_eq!(polygon.to_geometry(), Geometry::Polygon(square_with_hole()));

    let mp = FeatureGeometry::multi_point(Dimensions::Xy, [v(0, 0), v(1, 1)]).unwrap();
    assert_eq!(mp.geometry_type(), GeometryType::MultiPoint);
    let mls = FeatureGeometry::multi_line_string(
        Dimensions::Xy,
        [vec![v(0, 0), v(1, 1)], vec![v(2, 2), v(3, 3), v(4, 4)]],
    )
    .unwrap();
    assert_eq!(mls.vertex_count(), 5);
    let mpoly = FeatureGeometry::multi_polygon(
        Dimensions::Xy,
        [vec![vec![v(0, 0), v(10, 0), v(10, 10), v(0, 10)]]],
    )
    .unwrap();
    assert_eq!(
        mpoly.to_geometry(),
        Geometry::MultiPolygon(MultiPolygon(vec![square_closed()]))
    );
}

#[test]
fn a_vertex_must_match_the_declared_dimension() {
    let err = FeatureGeometry::line_string(Dimensions::Xy, [v(0, 0), vz(1, 1, 1)]).unwrap_err();
    assert!(
        matches!(err, MltError::VertexDimensionMismatch { .. }),
        "{err}"
    );
    let err = FeatureGeometry::line_string(Dimensions::Xyz, [vz(0, 0, 0), v(1, 1)]).unwrap_err();
    assert!(
        matches!(err, MltError::VertexDimensionMismatch { .. }),
        "{err}"
    );
    let err = FeatureGeometry::line_string(Dimensions::Xym, [v(0, 0)]).unwrap_err();
    assert!(
        matches!(err, MltError::GeometryDimensionUnsupported(Dimensions::Xym)),
        "{err}"
    );
}

#[test]
fn ring_closure_is_decided_on_every_dimension() {
    // Same x, y as the first vertex, another z: a stored vertex, not a closing one.
    let wall = FeatureGeometry::polygon(
        Dimensions::Xyz,
        [vec![vz(0, 0, 1), vz(1, 0, 1), vz(1, 1, 1), vz(0, 0, 2)]],
    )
    .unwrap();
    assert_eq!(wall.vertex_count(), 4);
    let flat = FeatureGeometry::polygon(
        Dimensions::Xyz,
        [vec![vz(0, 0, 1), vz(1, 0, 1), vz(1, 1, 1), vz(0, 0, 1)]],
    )
    .unwrap();
    assert_eq!(flat.vertex_count(), 3);
}

#[test]
fn with_z_attaches_one_z_per_stored_vertex() {
    let f = fg(&Geometry::Polygon(square_closed()))
        .with_z([1, 2, 3, 4])
        .unwrap();
    assert_eq!(f.dim(), Dimensions::Xyz);
    assert_eq!(f.vertex_count(), 4);
    let z: Vec<i32> = f.z().unwrap().collect();
    assert_eq!(z, [1, 2, 3, 4]);
    assert!(f.vertices().all(|v| v.z.is_some()));
    let GeoKind::Polygon(p) = f.as_type() else {
        panic!()
    };
    let exterior = p.exterior().unwrap();
    assert_eq!(exterior.num_coords(), 5);
    assert_eq!(
        exterior.coord(4).unwrap().nth(2),
        Some(1),
        "the closing position repeats the first z"
    );
    // z is dropped by to_geometry, the x, y stay.
    assert_eq!(f.to_geometry(), Geometry::Polygon(square_closed()));

    let err = fg(&Geometry::Polygon(square_closed()))
        .with_z([1, 2, 3])
        .unwrap_err();
    assert!(
        matches!(
            err,
            MltError::ZVertexCountMismatch {
                expected: 4,
                actual: 3
            }
        ),
        "{err}"
    );
}

#[test]
fn an_empty_geometry_is_two_dimensional_whatever_it_was_told() {
    let empty = FeatureGeometry::polygon(Dimensions::Xyz, Vec::<Vec<Vertex>>::new()).unwrap();
    assert_eq!(empty.dim(), Dimensions::Xy);
    let empty = fg(&Geometry::MultiPoint(MultiPoint(vec![])))
        .with_z([])
        .unwrap();
    assert_eq!(empty.dim(), Dimensions::Xy);
}

// ───────────────────────────── from_view on every fixture ─────────────────────────────

fn assert_fixture(path: &Path) {
    let bytes = fs::read(path).unwrap();
    for layer in parsed_layers(&bytes) {
        let values = layer.geometry_values();
        let has_z = values.z_step().is_some();
        for index in 0..values.feature_count() {
            let view = values.geometry(index).unwrap();
            let owned = FeatureGeometry::from_view(view);
            assert_eq!(
                owned,
                FeatureGeometry::from_geometry(&view).unwrap(),
                "feature {index}"
            );
            assert_eq!(
                owned.to_geometry(),
                values.to_geojson(index).unwrap(),
                "feature {index}"
            );
            assert_eq!(owned.geometry_type(), view.geometry_type());
            if owned.vertex_count() > 0 {
                assert_eq!(owned.dim(), view.dim(), "feature {index}");
            }
            if has_z {
                let z: Vec<i32> = owned.z().map(Iterator::collect).unwrap_or_default();
                assert_eq!(z, values.z(index).unwrap(), "feature {index}");
            }
        }
    }
}

test_each_path! { for ["mlt"] in "../test/expected/0x01" as v1 => every_v1_feature_copies_out_of_its_view }
test_each_path! { for ["mlt"] in "../test/expected/0x02" as v2 => every_v2_feature_copies_out_of_its_view }

fn every_v1_feature_copies_out_of_its_view([mlt]: [&Path; 1]) {
    assert_fixture(mlt);
}

fn every_v2_feature_copies_out_of_its_view([mlt]: [&Path; 1]) {
    assert_fixture(mlt);
}

// ───────────────────────────── row model ─────────────────────────────

fn z_geoms() -> Vec<Geometry<i32>> {
    vec![
        Geometry::Point(Point::new(1, 1)),
        Geometry::LineString(ring(&[(0, 0), (5, 5), (9, 2)])),
        Geometry::Polygon(square_with_hole()),
        Geometry::MultiPolygon(MultiPolygon(vec![square_closed(), square_with_hole()])),
        Geometry::Polygon(Polygon::new(LineString(vec![]), vec![])),
    ]
}

/// A v2 layer on `step` whose z count up by 7 from 1, one per stored vertex.
fn z_layer() -> TileLayer {
    let mut builder = TileLayer::builder("z", 4096).unwrap();
    builder.set_z_step(step()).unwrap();
    let mut next = 0;
    for geom in z_geoms() {
        let f = fg(&geom);
        let n = f.vertex_count();
        let z: Vec<i32> = (next..next + n)
            .map(|i| 1 + i32::try_from(i).unwrap() * 7)
            .collect();
        next += n;
        builder
            .feature(f.with_z(z).unwrap())
            .unwrap()
            .finish()
            .unwrap();
    }
    builder.finish()
}

#[test]
fn a_tile_layer_round_trips_z_inside_its_geometries() {
    let layer = z_layer();
    for feature in layer.features() {
        if feature.vertex_count() > 0 {
            assert_eq!(feature.geometry().dim(), Dimensions::Xyz);
        }
    }
    let bytes = layer.encode(cfg_v2()).expect("encode");
    assert_eq!(decode_v2(&bytes), layer);
}

#[test]
fn a_v1_round_trip_is_equal_for_open_rings_and_rect_inputs() {
    let mut builder = TileLayer::builder("flat", 4096).unwrap();
    builder
        .feature(Geometry::Polygon(square_open()))
        .unwrap()
        .finish()
        .unwrap();
    builder
        .feature(Geometry::Rect(Rect::new(c(0, 0), c(4, 2))))
        .unwrap()
        .finish()
        .unwrap();
    builder
        .feature(Geometry::Triangle(Triangle::new(c(0, 0), c(4, 0), c(0, 4))))
        .unwrap()
        .finish()
        .unwrap();
    builder
        .feature(Geometry::Line(Line::new(c(0, 0), c(3, 3))))
        .unwrap()
        .finish()
        .unwrap();
    let layer = builder.finish();
    let bytes = layer.encode(EncoderConfig::default()).expect("encode");
    assert_eq!(decode_v1(&bytes), layer);
}

#[test]
fn push_feature_checks_the_dimension_against_the_layer() {
    let mut z = TileLayer::builder("z", 4096).unwrap();
    z.set_z_step(step()).unwrap();
    let err = z
        .feature(Geometry::Point(Point::new(1, 1)))
        .unwrap()
        .finish()
        .unwrap_err();
    assert!(
        matches!(
            err,
            MltError::GeometryDimensionMismatch {
                expected: Dimensions::Xyz,
                actual: Dimensions::Xy
            }
        ),
        "{err}"
    );
    // An empty geometry carries no z, so it fits either kind of layer.
    z.feature(Geometry::Polygon(Polygon::new(LineString(vec![]), vec![])))
        .unwrap()
        .finish()
        .unwrap();
    z.feature(FeatureGeometry::point(vz(1, 1, 1)))
        .unwrap()
        .finish()
        .unwrap();

    let mut flat = TileLayer::builder("flat", 4096).unwrap();
    let err = flat
        .feature(FeatureGeometry::point(vz(1, 1, 1)))
        .unwrap()
        .finish()
        .unwrap_err();
    assert!(
        matches!(
            err,
            MltError::GeometryDimensionMismatch {
                expected: Dimensions::Xy,
                actual: Dimensions::Xyz
            }
        ),
        "{err}"
    );
}

#[test]
fn builders_accept_geo_types_views_and_feature_geometries() {
    let bytes = z_layer().encode(cfg_v2()).expect("encode");
    let layers = parsed_layers(&bytes);
    let view = layers[0].geometry_values().geometry(2).unwrap();

    let mut builder = TileLayer::builder("mixed", 4096).unwrap();
    builder.set_z_step(step()).unwrap();
    builder.feature(view).unwrap().finish().unwrap();
    builder
        .feature(FeatureGeometry::from_view(view))
        .unwrap()
        .finish()
        .unwrap();
    builder
        .feature(fg(&Geometry::Point(Point::new(1, 1))).with_z([3]).unwrap())
        .unwrap()
        .finish()
        .unwrap();
    let gc = Geometry::GeometryCollection(GeometryCollection(vec![]));
    assert!(builder.feature(gc).is_err());
    let layer = builder.finish();
    assert_eq!(layer.features().len(), 3);
    assert_eq!(
        layer.features()[0].geometry(),
        layer.features()[1].geometry()
    );

    let feature = TileFeature::new(Geometry::Point(Point::new(1, 2))).unwrap();
    assert_eq!(
        feature.geometry().to_geometry(),
        Geometry::Point(Point::new(1, 2))
    );
    let feature = TileFeature::with_id(view, 7).unwrap();
    assert_eq!(feature.id(), Some(7));
    assert_eq!(feature.vertex_count(), 7);
}

// ───────────────────────────── GeoJSON ─────────────────────────────

#[test]
fn geojson_positions_carry_z_from_the_geometry() {
    let geometry = fg(&Geometry::Polygon(square_closed()))
        .with_z([1, 2, 3, 4])
        .unwrap();
    let feature = Feature {
        geometry,
        id: Some(1),
        properties: BTreeMap::new(),
        ty: "Feature".into(),
    };
    let json = serde_json::to_string(&feature).unwrap();
    assert!(
        json.contains("[[[0,0,1],[10,0,2],[10,10,3],[0,10,4],[0,0,1]]]"),
        "{json}"
    );
    let back: Feature = serde_json::from_str(&json).unwrap();
    assert_eq!(back, feature);

    let flat: Feature = serde_json::from_str(
        r#"{"type":"Feature","properties":{},"geometry":{"type":"LineString","coordinates":[[0,0],[1,1]]}}"#,
    )
    .unwrap();
    assert_eq!(flat.geometry.dim(), Dimensions::Xy);
    let mixed = serde_json::from_str::<Feature>(
        r#"{"type":"Feature","properties":{},"geometry":{"type":"LineString","coordinates":[[0,0,1],[1,1]]}}"#,
    );
    assert!(mixed.is_err());
}

#[test]
fn a_feature_collection_from_a_z_layer_has_z_in_its_geometries() {
    let bytes = z_layer().encode(cfg_v2()).expect("encode");
    let layers = parser().parse_layers(&bytes).unwrap();
    let layers = dec().decode_all(layers).unwrap();
    let fc = FeatureCollection::from_layers(layers).unwrap();
    assert_eq!(fc.features.len(), 5);
    assert_eq!(fc.features[1].geometry.dim(), Dimensions::Xyz);
    let z: Vec<i32> = fc.features[1].geometry.z().unwrap().collect();
    assert_eq!(z, [8, 15, 22]);
}

// ───────────────────────────── staging ─────────────────────────────

#[test]
fn push_geom_and_push_geometry_stage_the_same_layer() {
    let geoms = z_geoms();
    let mut a = GeometryValues::default();
    let mut b = GeometryValues::default();
    for g in &geoms {
        a.push_geom(&fg(g));
        b.push_geometry(g).unwrap();
    }
    assert_eq!(a, b);
    assert_eq!(a.feature_count(), geoms.len());
    // The encoder's staging form has compact offsets, so only the total is addressable here.
    let stored: usize = geoms.iter().map(|g| fg(g).vertex_count()).sum();
    assert_eq!(a.vertices().map_or(0, <[i32]>::len) / a.stride(), stored);
}

#[test]
fn push_geom_interleaves_z_into_a_z_layer() {
    let f = fg(&Geometry::LineString(ring(&[(0, 0), (5, 5)])))
        .with_z([7, 9])
        .unwrap();
    let values = GeometryValues::default().with_z_step(step()).with_geom(&f);
    assert_eq!(values.stride(), 3);
    assert_eq!(values.vertices().unwrap(), &[0, 0, 7, 5, 5, 9]);
    assert_eq!(values.z(0).unwrap(), [7, 9]);
    assert_eq!(FeatureGeometry::from_view(values.geometry(0).unwrap()), f);
}

#[test]
fn debug_prints_a_flat_geometry_as_geo_types_does() {
    use mlt_core::geo_types::{
        Geometry, LineString, MultiLineString, MultiPoint, MultiPolygon, Point, Polygon,
    };
    let square = |x: i32| LineString::from(vec![(x, 0), (x + 4, 0), (x + 4, 4), (x, 4), (x, 0)]);
    let hole = LineString::from(vec![(1, 1), (1, 2), (2, 2), (1, 1)]);
    let cases: Vec<Geometry<i32>> = vec![
        Point::new(1, 2).into(),
        LineString::from(vec![(0, 0), (1, 1)]).into(),
        LineString::<i32>::new(vec![]).into(),
        Polygon::new(square(0), vec![hole.clone()]).into(),
        Polygon::<i32>::new(LineString::new(vec![]), vec![]).into(),
        MultiPoint::from(vec![(1, 2), (3, 4)]).into(),
        MultiPoint::<i32>::new(vec![]).into(),
        MultiLineString::new(vec![LineString::from(vec![(0, 0), (1, 1)]), square(5)]).into(),
        MultiLineString::<i32>::new(vec![]).into(),
        MultiPolygon::new(vec![
            Polygon::new(square(0), vec![hole]),
            Polygon::new(square(10), vec![]),
        ])
        .into(),
        MultiPolygon::<i32>::new(vec![]).into(),
    ];
    for g in cases {
        let fg = FeatureGeometry::from_geometry(&g).unwrap();
        assert_eq!(format!("{fg:?}"), format!("{g:?}"));
    }
}

#[test]
fn debug_tags_a_3d_geometry_and_prints_its_z() {
    let ring = [(0, 0, 1), (4, 0, 2), (4, 4, 3)].map(|(x, y, z)| Vertex { x, y, z: Some(z) });
    let polygon = FeatureGeometry::polygon(Dimensions::Xyz, [ring.to_vec()]).unwrap();
    assert_eq!(
        format!("{polygon:?}"),
        "POLYGON Z((0 0 1,4 0 2,4 4 3,0 0 1))"
    );
    let point = FeatureGeometry::point(ring[1]);
    assert_eq!(format!("{point:?}"), "POINT Z(4 0 2)");
}
