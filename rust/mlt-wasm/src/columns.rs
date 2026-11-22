//! `decodeTileColumns`: every layer of a tile as typed arrays, read straight off the decoded
//! columns without going through per-feature rows.
//!
//! Each layer crosses the boundary as one plain object whose shape `js/columns.ts` types.
//! Every array is copied out of WASM memory once: a view into it would be detached the next
//! time that memory grows.
//!
//! A string column's values cross as their UTF-8 bytes and a byte range per feature, for
//! `js/columns.ts` to decode: a JS string made here costs a call into JS for each one.

use js_sys::{
    Array, Float32Array, Float64Array, Int8Array, Int32Array, Object, Reflect, Uint8Array,
    Uint32Array,
};
use mlt_core::{
    Decoder, GeometryValues, HeightMode, ParsedLayer, ParsedLayer01, ParsedProperty, Parser,
    PresentValues, PropKind,
};
use wasm_bindgen::prelude::*;

use crate::to_js_err;

/// Decode the layers of `data` into their columns, in wire order: every layer, or with
/// `names`, only those with one of these names. A layer left out is never decoded.
///
/// v2 layers are skipped unless the crate is built with the `unstable-v2` feature.
#[wasm_bindgen(js_name = decodeTileColumns)]
#[expect(
    clippy::needless_pass_by_value,
    reason = "wasm-bindgen hands a JS array over only as an owned Vec"
)]
pub fn decode_tile_columns(data: &[u8], names: Option<Vec<String>>) -> Result<Array, JsError> {
    let mut parser = Parser::default();
    let raw_layers = parser.parse_layers(data).map_err(|e| to_js_err(&e))?;
    let mut dec = Decoder::default();
    let layers = Array::new();
    for raw_layer in raw_layers {
        if let Some(names) = &names
            && !raw_layer
                .name()
                .is_some_and(|name| names.iter().any(|n| n == name))
        {
            continue;
        }
        #[cfg(not(feature = "unstable-v2"))]
        if !matches!(raw_layer, mlt_core::Layer::Tag01(_)) {
            continue;
        }
        let parsed = raw_layer.decode_all(&mut dec).map_err(|e| to_js_err(&e))?;
        // `ParsedLayer` is non_exhaustive: a layer of a tag this binding does not know is skipped.
        let object = match &parsed {
            ParsedLayer::Tag01(layer) => layer_object(layer, 1)?,
            // A v2 layer's vertex-scoped and nested columns are not passed on.
            #[cfg(feature = "unstable-v2")]
            ParsedLayer::Tag02(layer) => layer_object(layer.layer(), 2)?,
            _ => continue,
        };
        layers.push(&object);
    }
    Ok(layers)
}

/// The columns every wire version has.
fn layer_object(layer: &ParsedLayer01<'_>, version: u8) -> Result<Object, JsError> {
    let object = Object::new();
    set(&object, "name", &layer.name().into());
    set(&object, "extent", &layer.extent().get().into());
    set(&object, "version", &version.into());
    set(&object, "featureCount", &js_len(layer.feature_count()));
    set(
        &object,
        "geometry",
        &geometry_object(layer.geometry_values()),
    );
    if let Some(ids) = layer.id() {
        let (values, present) = scalar(ids);
        set(&object, "ids", &column(None, &values, present.as_ref()));
    }

    let properties = Array::new();
    let mut names = layer.iterate_prop_names();
    for property in layer.properties() {
        for (kind, values, present) in property_columns(property)? {
            let Some(name) = names.next() else {
                return Err(JsError::new("a property column has no name"));
            };
            properties.push(&column(
                Some((&name.to_string(), kind)),
                &values,
                present.as_ref(),
            ));
        }
    }
    if names.next().is_some() {
        return Err(JsError::new("a property name has no column"));
    }
    set(&object, "properties", &properties);
    Ok(object)
}

fn geometry_object(geometry: &GeometryValues) -> Object {
    let object = Object::new();
    let types: Vec<u8> = geometry.vector_types().iter().map(|&t| t as u8).collect();
    set(&object, "types", &Uint8Array::from(&types[..]));
    set(&object, "dimension", &js_len(geometry.stride()));
    set(
        &object,
        "vertices",
        &Int32Array::from(geometry.vertices().unwrap_or_default()),
    );
    if let Some(axis) = geometry.z_axis() {
        set(&object, "zStep", &axis.step.exponent().into());
        let mode = match axis.mode {
            HeightMode::Absolute => "absolute",
            HeightMode::RelativeToGround => "relativeToGround",
        };
        set(&object, "heightMode", &mode.into());
    }
    for (key, offsets) in [
        ("geometryOffsets", geometry.geometry_offsets()),
        ("partOffsets", geometry.part_offsets()),
        ("ringOffsets", geometry.ring_offsets()),
        ("triangleOffsets", geometry.triangle_offsets()),
        ("indexBuffer", geometry.index_buffer()),
    ] {
        if let Some(offsets) = offsets {
            set(&object, key, &Uint32Array::from(offsets));
        }
    }
    object
}

/// A column's type, its values, and its presence when some feature has no value.
type ColumnParts = (&'static str, JsValue, Option<Uint8Array>);

/// The values and presence of each column `property` holds: a shared dictionary holds one
/// per child, every other property one.
fn property_columns(property: &ParsedProperty<'_>) -> Result<Vec<ColumnParts>, JsError> {
    let (values, present) = match property {
        ParsedProperty::Bool(v) => scalar(v),
        ParsedProperty::I8(v) => scalar(v),
        ParsedProperty::U8(v) => scalar(v),
        ParsedProperty::I32(v) => scalar(v),
        ParsedProperty::U32(v) => scalar(v),
        ParsedProperty::I64(v) => scalar(v),
        ParsedProperty::U64(v) => scalar(v),
        ParsedProperty::F32(v) => scalar(v),
        ParsedProperty::F64(v) => scalar(v),
        ParsedProperty::Str(s) => {
            let data = Uint8Array::from(s.corpus().as_bytes());
            strings(&data, s.feature_count(), |i| s.span(u32::try_from(i).ok()?))
        }
        ParsedProperty::SharedDict(dict) => {
            // One copy of the dictionary, which every child's ranges point into.
            let data = Uint8Array::from(dict.corpus().as_bytes());
            return Ok(dict
                .items()
                .iter()
                .map(|item| {
                    let (values, present) =
                        strings(&data, item.feature_count(), |i| item.span(dict, i));
                    ("string", values, present)
                })
                .collect());
        }
        other => {
            return Err(JsError::new(&format!(
                "unsupported property type {:?}",
                other.kind()
            )));
        }
    };
    Ok(vec![(type_name(property.kind()), values, present)])
}

/// `{ name, type, values, present }`, leaving out `name` and `type` for the id column and
/// `present` when every feature has a value.
fn column(
    name_and_type: Option<(&str, &str)>,
    values: &JsValue,
    present: Option<&Uint8Array>,
) -> Object {
    let object = Object::new();
    if let Some((name, kind)) = name_and_type {
        set(&object, "name", &name.into());
        set(&object, "type", &kind.into());
    }
    set(&object, "values", values);
    if let Some(present) = present {
        set(&object, "present", present);
    }
    object
}

/// One value per feature, `T::default()` where a feature has none, and the presence if any
/// has none.
fn scalar<T: JsElement>(presence: &PresentValues<'_, T>) -> (JsValue, Option<Uint8Array>) {
    let n = presence.feature_count();
    let dense = presence.dense_values();
    if dense.len() == n {
        return (T::js_array(dense), None);
    }
    let values: Vec<T> = presence
        .iter_optional()
        .map(Option::unwrap_or_default)
        .collect();
    (T::js_array(&values), bitmap(n, |i| presence.is_present(i)))
}

/// A value type and the typed array it crosses the boundary as.
trait JsElement: Copy + Default {
    fn js_array(values: &[Self]) -> JsValue;
}

macro_rules! js_element {
    ($($t:ty => $array:ty),* $(,)?) => {$(
        impl JsElement for $t {
            fn js_array(values: &[Self]) -> JsValue {
                <$array>::from(values).into()
            }
        }
    )*};
}
js_element!(
    i8 => Int8Array,
    u8 => Uint8Array,
    i32 => Int32Array,
    u32 => Uint32Array,
    f32 => Float32Array,
    f64 => Float64Array,
);

impl JsElement for bool {
    /// `0`/`1` in a `Uint8Array`.
    fn js_array(values: &[Self]) -> JsValue {
        let values: Vec<u8> = values.iter().copied().map(u8::from).collect();
        u8::js_array(&values)
    }
}

macro_rules! js_element_as_f64 {
    ($($t:ty),*) => {$(
        impl JsElement for $t {
            /// A `Float64Array`, so values above 2^53 lose precision.
            #[expect(clippy::cast_precision_loss, reason = "64-bit integers come out as f64")]
            fn js_array(values: &[Self]) -> JsValue {
                let values: Vec<f64> = values.iter().map(|&v| v as f64).collect();
                f64::js_array(&values)
            }
        }
    )*};
}
js_element_as_f64!(i64, u64);

/// The `type` a column of `kind` reports.
fn type_name(kind: PropKind) -> &'static str {
    if kind == PropKind::Str {
        "string"
    } else {
        kind.into()
    }
}

/// `{ data, ranges }`: the byte range of `data` each feature's string is, `(0, 0)` where a
/// feature has none. With it, the presence if any feature has none.
fn strings(
    data: &Uint8Array,
    n: usize,
    span: impl Fn(usize) -> Option<(u32, u32)>,
) -> (JsValue, Option<Uint8Array>) {
    let mut ranges = Vec::with_capacity(n * 2);
    // One lookup per feature: the bitmap's walk fills `ranges` as it goes.
    let present = bitmap(n, |i| {
        let found = span(i);
        let (start, end) = found.unwrap_or_default();
        ranges.extend([start, end]);
        found.is_some()
    });
    let values = Object::new();
    set(&values, "data", data);
    set(&values, "ranges", &Uint32Array::from(&ranges[..]));
    (values.into(), present)
}

/// One bit per feature, LSB-first, or [`None`] when every feature is present.
fn bitmap(n: usize, mut present: impl FnMut(usize) -> bool) -> Option<Uint8Array> {
    let mut bytes = vec![0_u8; n.div_ceil(8)];
    let mut all = true;
    for i in 0..n {
        if present(i) {
            bytes[i / 8] |= 1 << (i % 8);
        } else {
            all = false;
        }
    }
    (!all).then(|| Uint8Array::from(&bytes[..]))
}

fn set(object: &Object, key: &str, value: &JsValue) {
    Reflect::set(object, &JsValue::from_str(key), value)
        .expect("a plain object takes any string key");
}

/// A length as a JS number. Every length here indexes a typed array, so it fits in a u32.
fn js_len(len: usize) -> JsValue {
    u32::try_from(len)
        .expect("a typed array's length fits in u32")
        .into()
}
