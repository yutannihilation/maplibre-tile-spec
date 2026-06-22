//! Pure property schema inference + value conversion for `GeoJSON` features.
//!
//! `GeoJSON` properties are dynamically typed JSON, while an MLT layer needs one
//! fixed [`PropKind`] per column shared across every feature (and every tile).
//! We therefore scan all features once to infer a column kind, mirroring
//! `mlt_core`'s MVT importer (`convert/mvt/decode.rs::InferredType`): unknown
//! and conflicting columns collapse to `Str`, integer/float ranges widen, and a
//! column that is always absent or `null` becomes `Str`.

use geojson::feature::Id;
use geojson::{Feature, JsonValue};
use mlt_core::{PropKind, PropValue};

/// Column type inferred from JSON property values across all features.
///
/// `Unknown` is the pre-merge state for a column seen only as absent/`null`; it
/// resolves to `Str` in the final schema.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum InferredKind {
    Unknown,
    Bool,
    I64,
    U64,
    F64,
    Str,
}

impl InferredKind {
    /// Classify a single (non-null) JSON value. Integral numbers split by sign
    /// (`>= 0` -> `U64`, `< 0` -> `I64`); non-integral numbers and out-of-range
    /// integers become `F64`; objects/arrays are stringified, so they read as
    /// `Str`. JSON `null` is `Unknown`.
    fn from_json(val: &JsonValue) -> Self {
        match val {
            JsonValue::Null => Self::Unknown,
            JsonValue::Bool(_) => Self::Bool,
            JsonValue::Number(n) => {
                if n.is_u64() {
                    Self::U64
                } else if n.is_i64() {
                    Self::I64
                } else {
                    Self::F64
                }
            }
            // Strings stay strings; nested arrays/objects are serialized to a JSON string.
            JsonValue::String(_) | JsonValue::Array(_) | JsonValue::Object(_) => Self::Str,
        }
    }

    /// Merge with another kind, widening when necessary and falling back to
    /// `Str` on any irreconcilable conflict.
    fn merge(self, other: Self) -> Self {
        if self == Self::Unknown {
            return other;
        }
        if other == Self::Unknown || self == other {
            return self;
        }
        match (self, other) {
            (Self::I64, Self::U64) | (Self::U64, Self::I64) => Self::I64,
            (Self::F64, Self::I64 | Self::U64) | (Self::I64 | Self::U64, Self::F64) => Self::F64,
            _ => Self::Str,
        }
    }

    fn to_kind(self) -> PropKind {
        match self {
            Self::Unknown | Self::Str => PropKind::Str,
            Self::Bool => PropKind::Bool,
            Self::I64 => PropKind::I64,
            Self::U64 => PropKind::U64,
            Self::F64 => PropKind::F64,
        }
    }
}

/// Build the ordered, shared property schema for a set of features.
///
/// Column order is first-seen order across features. The returned kinds are the
/// merged inference for each column; always-absent/always-null columns are
/// `Str`.
#[must_use]
pub(super) fn infer_schema(features: &[Feature]) -> Vec<(String, PropKind)> {
    let mut names: Vec<String> = Vec::new();
    let mut kinds: Vec<InferredKind> = Vec::new();

    for feature in features {
        let Some(props) = feature.properties.as_ref() else {
            continue;
        };
        for (name, value) in props {
            let idx = names.iter().position(|n| n == name).unwrap_or_else(|| {
                names.push(name.clone());
                kinds.push(InferredKind::Unknown);
                names.len() - 1
            });
            kinds[idx] = kinds[idx].merge(InferredKind::from_json(value));
        }
    }

    names
        .into_iter()
        .zip(kinds)
        .map(|(name, kind)| (name, kind.to_kind()))
        .collect()
}

/// Convert one JSON value into the [`PropValue`] of the given column kind. A
/// missing key or JSON `null` yields the typed null for that column.
fn to_prop_value(kind: PropKind, value: Option<&JsonValue>) -> PropValue {
    let Some(value) = value else {
        return PropValue::null(kind);
    };
    match (kind, value) {
        (_, JsonValue::Null) => PropValue::null(kind),
        (PropKind::Bool, JsonValue::Bool(b)) => PropValue::Bool(Some(*b)),
        (PropKind::I64, JsonValue::Number(n)) => n
            .as_i64()
            .map_or(PropValue::I64(None), |i| PropValue::I64(Some(i))),
        (PropKind::U64, JsonValue::Number(n)) => n
            .as_u64()
            .map_or(PropValue::U64(None), |u| PropValue::U64(Some(u))),
        (PropKind::F64, JsonValue::Number(n)) => n
            .as_f64()
            .map_or(PropValue::F64(None), |f| PropValue::F64(Some(f))),
        (PropKind::Str, JsonValue::String(s)) => PropValue::Str(Some(s.clone())),
        // Nested arrays/objects (and any residual type conflict) become a
        // compact JSON string in a `Str` column.
        (PropKind::Str, other) => PropValue::Str(Some(other.to_string())),
        // Any remaining mismatch falls back to the column's typed null rather
        // than guessing a value.
        _ => PropValue::null(kind),
    }
}

/// Produce property values for one feature, in schema column order. Absent keys
/// and JSON nulls become typed nulls so every feature shares the schema shape.
#[must_use]
pub(super) fn feature_values(feature: &Feature, schema: &[(String, PropKind)]) -> Vec<PropValue> {
    let props = feature.properties.as_ref();
    schema
        .iter()
        .map(|(name, kind)| {
            let value = props.and_then(|p| p.get(name));
            to_prop_value(*kind, value)
        })
        .collect()
}

/// Map a `GeoJSON` feature `id` to an MLT feature id. Only integral numbers in the
/// `u64` range survive; string ids, negative numbers, and non-integers drop.
#[must_use]
pub(super) fn feature_id(feature: &Feature) -> Option<u64> {
    match feature.id.as_ref()? {
        Id::Number(n) => n.as_u64(),
        Id::String(_) => None,
    }
}

#[cfg(test)]
mod tests {
    use geojson::Feature;
    use serde_json::json;

    use super::*;

    fn feature_with_props(value: &serde_json::Value) -> Feature {
        serde_json::from_value(json!({
            "type": "Feature",
            "geometry": null,
            "properties": value,
        }))
        .expect("valid feature")
    }

    fn schema_of(features: &[Feature]) -> Vec<(String, PropKind)> {
        infer_schema(features)
    }

    #[test]
    fn infers_scalar_kinds() {
        let f = feature_with_props(&json!({
            "b": true,
            "u": 5,
            "i": -3,
            "f": 3.5,
            "s": "hi",
        }));
        let schema = schema_of(std::slice::from_ref(&f));
        let kinds: std::collections::BTreeMap<_, _> = schema.into_iter().collect();
        assert_eq!(kinds["b"], PropKind::Bool);
        assert_eq!(kinds["u"], PropKind::U64);
        assert_eq!(kinds["i"], PropKind::I64);
        assert_eq!(kinds["f"], PropKind::F64);
        assert_eq!(kinds["s"], PropKind::Str);
    }

    #[test]
    fn merge_int_unsigned_to_signed() {
        let f1 = feature_with_props(&json!({ "n": -1 }));
        let f2 = feature_with_props(&json!({ "n": 5 }));
        let schema = schema_of(&[f1, f2]);
        assert_eq!(schema, vec![("n".to_string(), PropKind::I64)]);
    }

    #[test]
    fn merge_float_widens_integers() {
        let f1 = feature_with_props(&json!({ "n": 3.5 }));
        let f2 = feature_with_props(&json!({ "n": 1 }));
        let schema = schema_of(&[f1, f2]);
        assert_eq!(schema, vec![("n".to_string(), PropKind::F64)]);
    }

    #[test]
    fn conflicting_kinds_fall_back_to_str() {
        let f1 = feature_with_props(&json!({ "a": true, "b": 1 }));
        let f2 = feature_with_props(&json!({ "a": "x", "b": "y" }));
        let schema: std::collections::BTreeMap<_, _> = schema_of(&[f1, f2]).into_iter().collect();
        assert_eq!(schema["a"], PropKind::Str); // Bool + Str
        assert_eq!(schema["b"], PropKind::Str); // Number + Str
    }

    #[test]
    fn always_null_column_is_str() {
        let f1 = feature_with_props(&json!({ "x": null }));
        let f2 = feature_with_props(&json!({ "x": null }));
        let schema = schema_of(&[f1, f2]);
        assert_eq!(schema, vec![("x".to_string(), PropKind::Str)]);
        let vals = feature_values(&schema_features(&schema)[0], &schema);
        assert_eq!(vals, vec![PropValue::Str(None)]);
    }

    // Build a fresh feature carrying a JSON null for every schema column, used to
    // check typed-null shaping.
    fn schema_features(schema: &[(String, PropKind)]) -> Vec<Feature> {
        let props: serde_json::Map<String, serde_json::Value> = schema
            .iter()
            .map(|(name, _)| (name.clone(), serde_json::Value::Null))
            .collect();
        vec![feature_with_props(&serde_json::Value::Object(props))]
    }

    #[test]
    fn missing_key_is_typed_null() {
        let schema = vec![
            ("present".to_string(), PropKind::U64),
            ("absent".to_string(), PropKind::I64),
        ];
        let f = feature_with_props(&json!({ "present": 7 }));
        let vals = feature_values(&f, &schema);
        assert_eq!(vals, vec![PropValue::U64(Some(7)), PropValue::I64(None)]);
    }

    #[test]
    fn json_null_in_typed_column_is_typed_null() {
        let schema = vec![("n".to_string(), PropKind::I64)];
        let f = feature_with_props(&json!({ "n": null }));
        let vals = feature_values(&f, &schema);
        assert_eq!(vals, vec![PropValue::I64(None)]);
    }

    #[test]
    fn nested_values_stringify_compactly() {
        let f = feature_with_props(&json!({ "obj": { "x": 1 }, "arr": [1, 2] }));
        let schema: std::collections::BTreeMap<_, _> =
            schema_of(std::slice::from_ref(&f)).into_iter().collect();
        assert_eq!(schema["obj"], PropKind::Str);
        assert_eq!(schema["arr"], PropKind::Str);

        let ordered: Vec<_> = schema.into_iter().collect();
        let vals = feature_values(&f, &ordered);
        let map: std::collections::BTreeMap<_, _> =
            ordered.iter().map(|(n, _)| n.clone()).zip(vals).collect();
        assert_eq!(map["obj"], PropValue::Str(Some("{\"x\":1}".to_string())));
        assert_eq!(map["arr"], PropValue::Str(Some("[1,2]".to_string())));
    }

    fn feature_with_id(id: &serde_json::Value) -> Feature {
        serde_json::from_value(json!({
            "type": "Feature",
            "id": id,
            "geometry": null,
            "properties": {},
        }))
        .expect("valid feature")
    }

    #[test]
    fn feature_id_mapping() {
        assert_eq!(feature_id(&feature_with_id(&json!(42))), Some(42));
        assert_eq!(feature_id(&feature_with_id(&json!(0))), Some(0));
        assert_eq!(feature_id(&feature_with_id(&json!(-1))), None);
        assert_eq!(feature_id(&feature_with_id(&json!(3.5))), None);
        assert_eq!(feature_id(&feature_with_id(&json!("abc"))), None);

        let absent: Feature = serde_json::from_value(json!({
            "type": "Feature",
            "geometry": null,
            "properties": {},
        }))
        .unwrap();
        assert_eq!(feature_id(&absent), None);
    }
}
