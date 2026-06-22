//! End-to-end round-trip tests for the `mlt geojson` subcommand.
//!
//! Each test writes a small `GeoJSON` file, runs the `mlt geojson` binary, then
//! decodes the produced `.mlt` tiles back through `mlt-core` and asserts the
//! geometry (including Z) and properties survive.

use std::path::{Path, PathBuf};
use std::process::Command;

use serde_json::Value;
use tempfile::TempDir;

/// Run `mlt geojson <input> <output> <extra args...>`, returning the output dir.
fn run_geojson(geojson: &str, args: &[&str]) -> (TempDir, PathBuf) {
    let dir = TempDir::new().expect("tempdir");
    let input = dir.path().join("input.geojson");
    std::fs::write(&input, geojson).expect("write input");
    let output = dir.path().join("out");

    let status = Command::new(env!("CARGO_BIN_EXE_mlt"))
        .arg("geojson")
        .arg(&input)
        .arg(&output)
        .args(args)
        .status()
        .expect("run mlt");
    assert!(status.success(), "mlt geojson failed: {status}");
    (dir, output)
}

/// Run expecting failure; returns whether the process exited non-zero.
fn run_geojson_expect_failure(geojson: &str, args: &[&str]) -> (TempDir, PathBuf, bool) {
    let dir = TempDir::new().expect("tempdir");
    let input = dir.path().join("input.geojson");
    std::fs::write(&input, geojson).expect("write input");
    let output = dir.path().join("out");

    let status = Command::new(env!("CARGO_BIN_EXE_mlt"))
        .arg("geojson")
        .arg(&input)
        .arg(&output)
        .args(args)
        .status()
        .expect("run mlt");
    (dir, output, !status.success())
}

/// Decode an `.mlt` tile to a JSON `FeatureCollection` value (via mlt-core).
fn decode_tile(path: &Path) -> Value {
    let buffer = std::fs::read(path).expect("read mlt");
    let mut p = mlt_core::Parser::default();
    let layers = p.parse_layers(&buffer).expect("parse layers");
    let mut d = mlt_core::Decoder::default();
    let decoded = d.decode_all(layers).expect("decode");
    let fc = mlt_core::geojson::FeatureCollection::from_layers(decoded).expect("from_layers");
    serde_json::to_value(&fc).expect("to_value")
}

fn features_of(fc: &Value) -> &Vec<Value> {
    fc["features"].as_array().expect("features array")
}

/// Find a decoded feature by its `name` property (user property survives).
fn feature_by_name<'a>(features: &'a [Value], name: &str) -> &'a Value {
    features
        .iter()
        .find(|f| f["properties"]["name"] == Value::String(name.to_string()))
        .unwrap_or_else(|| panic!("no feature named {name}"))
}

fn coords(feature: &Value) -> &Vec<Value> {
    feature["geometry"]["coordinates"]
        .as_array()
        .expect("coordinates array")
}

fn count_mlt(dir: &Path) -> usize {
    walk_mlt(dir).len()
}

fn walk_mlt(dir: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    if !dir.exists() {
        return out;
    }
    let mut stack = vec![dir.to_path_buf()];
    while let Some(d) = stack.pop() {
        for entry in std::fs::read_dir(&d).expect("read_dir") {
            let path = entry.expect("entry").path();
            if path.is_dir() {
                stack.push(path);
            } else if path.extension().and_then(|e| e.to_str()) == Some("mlt") {
                out.push(path);
            }
        }
    }
    out
}

#[test]
fn mixed_2d_3d_dataset_is_globally_3d() {
    // F1 3D point + named props; F2 3D line; F3 2D point (no id). Any Z => XYZ layer.
    let geojson = r#"{
        "type": "FeatureCollection",
        "features": [
            { "type": "Feature", "id": 1,
              "geometry": { "type": "Point", "coordinates": [0, 0, 1000000] },
              "properties": { "name": "origin", "rank": 5, "score": 3.5, "active": true, "note": null, "meta": {"k": 1} } },
            { "type": "Feature", "id": 2,
              "geometry": { "type": "LineString", "coordinates": [[0, 0, 1000000], [0, 60, 0]] },
              "properties": { "name": "edge", "active": false } },
            { "type": "Feature",
              "geometry": { "type": "Point", "coordinates": [0, -60] },
              "properties": { "name": "south" } }
        ]
    }"#;
    let (_dir, output) = run_geojson(geojson, &["--max-zoom", "0", "--layer", "places"]);

    // Only one tile at z0.
    assert_eq!(count_mlt(&output), 1);
    let tile = output.join("0").join("0").join("0.mlt");
    let fc = decode_tile(&tile);
    let features = features_of(&fc);
    assert_eq!(features.len(), 3);
    for f in features {
        assert_eq!(f["properties"]["_layer"], Value::String("places".into()));
        assert_eq!(f["properties"]["_extent"], Value::Number(4096.into()));
    }

    let f1 = feature_by_name(features, "origin");
    assert_eq!(f1["id"], Value::Number(1.into()));
    assert_eq!(
        coords(f1),
        &vec![json_i(2048), json_i(2048), json_i(100_000_000)]
    );
    assert_eq!(f1["properties"]["rank"], Value::Number(5.into()));
    assert_eq!(f1["properties"]["score"], json_f(3.5));
    assert_eq!(f1["properties"]["active"], Value::Bool(true));
    assert!(f1["properties"]["note"].is_null());
    assert_eq!(f1["properties"]["meta"], Value::String("{\"k\":1}".into()));

    let f2 = feature_by_name(features, "edge");
    assert_eq!(f2["id"], Value::Number(2.into()));
    let c2 = coords(f2);
    assert_eq!(
        c2[0],
        Value::Array(vec![json_i(2048), json_i(2048), json_i(100_000_000)])
    );
    assert_eq!(
        c2[1],
        Value::Array(vec![json_i(2048), json_i(1189), json_i(0)])
    );
    assert_eq!(f2["properties"]["active"], Value::Bool(false));

    let f3 = feature_by_name(features, "south");
    assert!(f3.get("id").is_none() || f3["id"].is_null());
    // 2D feature in a globally-3D layer decodes as [x, y, 0].
    assert_eq!(coords(f3), &vec![json_i(2048), json_i(2907), json_i(0)]);
    assert_eq!(coords(f3).len(), 3);
}

#[test]
fn all_2d_dataset_has_no_z_column() {
    let geojson = r#"{
        "type": "FeatureCollection",
        "features": [
            { "type": "Feature",
              "geometry": { "type": "Point", "coordinates": [0, 0] },
              "properties": { "name": "p" } },
            { "type": "Feature",
              "geometry": { "type": "LineString", "coordinates": [[0, 0], [0, 60]] },
              "properties": { "name": "l" } }
        ]
    }"#;
    let (_dir, output) = run_geojson(geojson, &["--max-zoom", "0", "--layer", "flat"]);
    let tile = output.join("0").join("0").join("0.mlt");
    let fc = decode_tile(&tile);
    let features = features_of(&fc);
    assert_eq!(features.len(), 2);

    let p = feature_by_name(features, "p");
    assert_eq!(coords(p), &vec![json_i(2048), json_i(2048)]);
    assert_eq!(coords(p).len(), 2);

    let l = feature_by_name(features, "l");
    for c in coords(l) {
        assert_eq!(c.as_array().expect("coord").len(), 2);
    }
}

#[test]
fn regression_2d_first_then_3d_keeps_z() {
    // First feature is 2D, second is 3D. The global scan must still pick XYZ and
    // preserve the second feature's Z (a per-first-feature decision would lose it).
    let geojson = r#"{
        "type": "FeatureCollection",
        "features": [
            { "type": "Feature",
              "geometry": { "type": "Point", "coordinates": [0, 0] },
              "properties": { "name": "flat" } },
            { "type": "Feature",
              "geometry": { "type": "Point", "coordinates": [0, 60, 1000000] },
              "properties": { "name": "high" } }
        ]
    }"#;
    let (_dir, output) = run_geojson(geojson, &["--max-zoom", "0", "--layer", "mixed"]);
    let tile = output.join("0").join("0").join("0.mlt");
    let fc = decode_tile(&tile);
    let features = features_of(&fc);

    let flat = feature_by_name(features, "flat");
    assert_eq!(coords(flat), &vec![json_i(2048), json_i(2048), json_i(0)]);

    let high = feature_by_name(features, "high");
    assert_eq!(
        coords(high),
        &vec![json_i(2048), json_i(1189), json_i(100_000_000)]
    );
}

#[test]
fn empty_feature_collection_writes_no_tiles() {
    let geojson = r#"{ "type": "FeatureCollection", "features": [] }"#;
    let (_dir, output) = run_geojson(geojson, &["--max-zoom", "0"]);
    assert_eq!(count_mlt(&output), 0);
}

#[test]
fn null_geometry_feature_is_skipped() {
    let geojson = r#"{
        "type": "FeatureCollection",
        "features": [
            { "type": "Feature", "geometry": null, "properties": { "name": "ghost" } },
            { "type": "Feature",
              "geometry": { "type": "Point", "coordinates": [0, 0] },
              "properties": { "name": "real" } }
        ]
    }"#;
    let (_dir, output) = run_geojson(geojson, &["--max-zoom", "0"]);
    let tile = output.join("0").join("0").join("0.mlt");
    let fc = decode_tile(&tile);
    assert_eq!(features_of(&fc).len(), 1);
}

#[test]
fn min_zoom_greater_than_max_zoom_is_error() {
    let geojson = r#"{ "type": "FeatureCollection", "features": [] }"#;
    let (_dir, output, failed) =
        run_geojson_expect_failure(geojson, &["--min-zoom", "5", "--max-zoom", "2"]);
    assert!(failed);
    assert_eq!(count_mlt(&output), 0);
}

#[test]
fn max_zoom_above_limit_is_error() {
    let geojson = r#"{ "type": "FeatureCollection", "features": [] }"#;
    let (_dir, _output, failed) = run_geojson_expect_failure(geojson, &["--max-zoom", "31"]);
    assert!(failed);
}

#[test]
fn bare_geometry_top_level_makes_one_feature() {
    let geojson = r#"{ "type": "Point", "coordinates": [0, 0] }"#;
    let (_dir, output) = run_geojson(geojson, &["--max-zoom", "0", "--layer", "bare"]);
    let tile = output.join("0").join("0").join("0.mlt");
    let fc = decode_tile(&tile);
    let features = features_of(&fc);
    assert_eq!(features.len(), 1);
    assert!(features[0].get("id").is_none() || features[0]["id"].is_null());
}

#[test]
fn geometry_collection_is_rejected() {
    let geojson = r#"{
        "type": "FeatureCollection",
        "features": [
            { "type": "Feature",
              "geometry": { "type": "GeometryCollection",
                            "geometries": [ { "type": "Point", "coordinates": [0, 0] } ] },
              "properties": {} }
        ]
    }"#;
    let (_dir, _output, failed) = run_geojson_expect_failure(geojson, &["--max-zoom", "0"]);
    assert!(failed);
}

#[test]
fn multipoint_3d_round_trips() {
    let geojson = r#"{
        "type": "FeatureCollection",
        "features": [
            { "type": "Feature",
              "geometry": { "type": "MultiPoint", "coordinates": [[0, 0, 1000000], [0, 60, 0]] },
              "properties": { "name": "mp" } }
        ]
    }"#;
    let (_dir, output) = run_geojson(geojson, &["--max-zoom", "0", "--layer", "mp"]);
    let tile = output.join("0").join("0").join("0.mlt");
    let fc = decode_tile(&tile);
    let features = features_of(&fc);
    let mp = feature_by_name(features, "mp");
    let c = coords(mp);
    assert_eq!(
        c[0],
        Value::Array(vec![json_i(2048), json_i(2048), json_i(100_000_000)])
    );
    assert_eq!(
        c[1],
        Value::Array(vec![json_i(2048), json_i(1189), json_i(0)])
    );
}

fn json_i(v: i64) -> Value {
    Value::Number(v.into())
}

fn json_f(v: f64) -> Value {
    Value::Number(serde_json::Number::from_f64(v).expect("finite"))
}
