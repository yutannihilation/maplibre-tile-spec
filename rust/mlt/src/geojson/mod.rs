//! `mlt geojson`: convert a (possibly 3D) WGS84 `GeoJSON` file into an MLT
//! `z/x/y.mlt` tile tree.
//!
//! `GeoJSON` has no layer or tiling concept, so the whole file becomes a single
//! named layer, re-projected into every tile of every requested zoom level.
//! Layer dimension (2D vs 3D) and the property schema are decided once, globally,
//! so all tiles share one schema (the encoder requires one dimension and one
//! kind per column). See `.tmp/plan/20260622_geojson_to_mlt_cli.md` for the
//! design rationale (Option A Z encoding, no clipping in v1).

mod geometry;
mod project;
mod properties;

use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::rc::Rc;

use anyhow::{Context as _, Result as AnyResult, bail};
use clap::Args;
use geojson::{Feature, GeoJson, GeometryValue};
use geometry::GeometryValueExt as _;
use martin_tile_utils::{MAX_ZOOM, bbox_to_xyz};
use mlt_core::encoder::EncoderConfig;
use mlt_core::wkt::Wkt;
use mlt_core::wkt::types::Dimension;
use mlt_core::{PropKind, PropValue, TileLayer};

#[derive(Args)]
pub struct GeoJsonArgs {
    /// Input `GeoJSON` file (`FeatureCollection`, single `Feature`, or bare geometry)
    input: PathBuf,
    /// Output directory for the `z/x/y.mlt` tile tree
    output: PathBuf,
    /// Lowest zoom level to generate
    #[arg(long, default_value_t = 0)]
    min_zoom: u8,
    /// Highest zoom level to generate
    #[arg(long)]
    max_zoom: u8,
    /// MLT layer name (defaults to the input file stem)
    #[arg(long)]
    layer: Option<String>,
    /// Tile extent grid (vertices per tile edge)
    #[arg(long, default_value_t = 4096)]
    extent: u32,
}

/// One feature projected into a single tile: its id, tile-local geometry, and
/// (shared) property values. Property values are shared (`Rc`) across the tiles
/// a feature lands in rather than re-cloned.
type TileEntry = (Option<u64>, Wkt<i32>, Rc<Vec<PropValue>>);

/// Accumulated per-tile features, keyed by `(zoom, x, y)`.
type TileMap = HashMap<(u8, u32, u32), Vec<TileEntry>>;

pub fn geojson(args: &GeoJsonArgs) -> AnyResult<()> {
    if args.min_zoom > args.max_zoom {
        bail!(
            "--min-zoom ({}) must be <= --max-zoom ({})",
            args.min_zoom,
            args.max_zoom
        );
    }
    if args.max_zoom > MAX_ZOOM {
        bail!("--max-zoom ({}) must be <= {MAX_ZOOM}", args.max_zoom);
    }
    if args.extent == 0 {
        bail!("--extent must be greater than 0");
    }

    let layer_name = match &args.layer {
        Some(name) => name.clone(),
        None => args
            .input
            .file_stem()
            .and_then(|s| s.to_str())
            .map(ToString::to_string)
            .with_context(|| {
                format!(
                    "cannot derive a layer name from {}; pass --layer",
                    args.input.display()
                )
            })?,
    };

    let text = fs::read_to_string(&args.input)
        .with_context(|| format!("reading {}", args.input.display()))?;
    let parsed: GeoJson = text
        .parse()
        .with_context(|| format!("parsing GeoJSON from {}", args.input.display()))?;
    let features = normalize_to_features(parsed);

    // MLT geometry has no GeometryCollection (see docs/specification.md), and the
    // decoder's GeoJSON serializer rejects it. Fail loudly rather than silently
    // dropping such features.
    if features
        .iter()
        .filter_map(|f| f.geometry.as_ref())
        .any(|g| matches!(g.value, GeometryValue::GeometryCollection { .. }))
    {
        bail!(
            "GeometryCollection geometries are not supported by MLT; split them into separate features"
        );
    }

    // One dimension for the whole layer: 3D iff any feature carries a Z anywhere.
    let dim = if features
        .iter()
        .any(|f| f.geometry.as_ref().is_some_and(|g| g.value.has_z()))
    {
        Dimension::XYZ
    } else {
        Dimension::XY
    };

    let schema = properties::infer_schema(&features);

    let mut tiles: TileMap = HashMap::new();
    for feature in &features {
        let Some(geometry) = feature.geometry.as_ref() else {
            continue;
        };
        let Some((min_lon, min_lat, max_lon, max_lat)) = geometry.value.lonlat_bbox() else {
            continue;
        };
        let id = properties::feature_id(feature);
        let values = Rc::new(properties::feature_values(feature, &schema));
        for zoom in args.min_zoom..=args.max_zoom {
            let (min_col, min_row, max_col, max_row) =
                bbox_to_xyz(min_lon, min_lat, max_lon, max_lat, zoom);
            for col in min_col..=max_col {
                for row in min_row..=max_row {
                    // TODO(clipping): clip geom to tile [0,extent] rect (interpolate Z on cuts) before projecting.
                    let Some(wkt) = geometry::project_geometry(
                        &geometry.value,
                        dim,
                        zoom,
                        col,
                        row,
                        args.extent,
                    ) else {
                        continue;
                    };
                    tiles
                        .entry((zoom, col, row))
                        .or_default()
                        .push((id, wkt, Rc::clone(&values)));
                }
            }
        }
    }

    let mut tiles_written = 0_usize;
    let mut features_written = 0_usize;
    for ((zoom, x, y), tile_features) in &tiles {
        let bytes = encode_tile(&layer_name, args.extent, &schema, tile_features)?;
        if bytes.is_empty() {
            continue;
        }
        let dir = args.output.join(zoom.to_string()).join(x.to_string());
        fs::create_dir_all(&dir).with_context(|| format!("creating {}", dir.display()))?;
        let path = dir.join(format!("{y}.mlt"));
        fs::write(&path, &bytes).with_context(|| format!("writing {}", path.display()))?;
        tiles_written += 1;
        features_written += tile_features.len();
    }

    eprintln!(
        "Wrote {tiles_written} tile(s), {features_written} feature instance(s) to {}",
        args.output.display()
    );
    Ok(())
}

/// Build and encode a single tile layer from its accumulated features.
fn encode_tile(
    layer_name: &str,
    extent: u32,
    schema: &[(String, PropKind)],
    features: &[TileEntry],
) -> AnyResult<Vec<u8>> {
    let mut builder = TileLayer::builder(layer_name, extent)?;
    let keys = schema
        .iter()
        .map(|(name, kind)| builder.add_property(name.clone(), *kind))
        .collect::<Result<Vec<_>, _>>()?;

    for (id, wkt, values) in features {
        let mut fb = builder.feature(wkt);
        fb.id(*id);
        for (key, value) in keys.iter().zip(values.iter()) {
            fb.property(*key, value.clone())?;
        }
        fb.finish()?;
    }

    // Fresh config per tile: EncoderConfig is not assumed to be Clone/Copy.
    Ok(builder.finish().encode(EncoderConfig::default())?)
}

/// Flatten any top-level `GeoJSON` shape into a list of features. A bare geometry
/// becomes a single feature with no id and no properties.
fn normalize_to_features(geojson: GeoJson) -> Vec<Feature> {
    match geojson {
        GeoJson::FeatureCollection(fc) => fc.features,
        GeoJson::Feature(f) => vec![f],
        GeoJson::Geometry(geometry) => vec![Feature {
            bbox: None,
            geometry: Some(geometry),
            id: None,
            properties: None,
            foreign_members: None,
        }],
    }
}
