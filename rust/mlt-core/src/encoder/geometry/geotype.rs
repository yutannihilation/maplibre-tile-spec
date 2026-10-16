use std::borrow::Cow;

use geo::{Convert as _, TriangulateEarcut as _};
use geo_traits::GeometryTrait;
use geo_types::{Coord, Geometry, LineString, Polygon};

use crate::decoder::{GeometryType, GeometryValues, Vertex};
use crate::feature_geometry::winds_against;
#[cfg(feature = "unstable-v2")]
use crate::tile::ZStep;
use crate::tile::stored_len;
use crate::{FeatureGeometry, LineRef, MltResult, PolygonRef, TileLayer};

impl TryFrom<&Geometry<i32>> for GeometryType {
    type Error = ();

    fn try_from(geom: &Geometry<i32>) -> Result<Self, Self::Error> {
        Ok(match geom {
            Geometry::<i32>::Point(_) => Self::Point,
            Geometry::<i32>::MultiPoint(_) => Self::MultiPoint,
            Geometry::<i32>::LineString(_) => Self::LineString,
            Geometry::<i32>::MultiLineString(_) => Self::MultiLineString,
            Geometry::<i32>::Polygon(_) => Self::Polygon,
            Geometry::<i32>::MultiPolygon(_) => Self::MultiPolygon,
            Geometry::<i32>::Line(_)
            | Geometry::<i32>::GeometryCollection(_)
            | Geometry::<i32>::Rect(_)
            | Geometry::<i32>::Triangle(_) => {
                return Err(());
            }
        })
    }
}

/// A run of vertices the encoder reads: a line string's, or a ring's.
pub(crate) trait VertexSrc: Copy {
    /// Every vertex, as given.
    fn len(&self) -> usize;
    /// The vertices a ring stores: all of them but a closing one.
    fn stored_ring_len(&self) -> usize;
    fn vertex(&self, i: usize) -> Vertex;
    fn xy(&self, i: usize) -> (i32, i32) {
        let v = self.vertex(i);
        (v.x, v.y)
    }
}

/// Coordinates as a [`crate::LayerWriter`] holds them, each ring open or closed.
impl VertexSrc for &[Coord<i32>] {
    fn len(&self) -> usize {
        <[Coord<i32>]>::len(self)
    }

    fn stored_ring_len(&self) -> usize {
        stored_len(self)
    }

    fn vertex(&self, i: usize) -> Vertex {
        self[i].into()
    }
}

/// A part of a [`FeatureGeometry`], whose rings have no closing vertex.
impl VertexSrc for LineRef<'_> {
    fn len(&self) -> usize {
        self.vertex_count()
    }

    fn stored_ring_len(&self) -> usize {
        self.vertex_count()
    }

    fn vertex(&self, i: usize) -> Vertex {
        LineRef::vertex(self, i)
    }
}

/// A ring as the encoder stores it: as given, or reversed after its first vertex so that
/// it winds as MVT does, counter-clockwise outside and clockwise inside.
#[derive(Clone, Copy)]
enum Wound<R> {
    Plain(R),
    Reversed(R),
}

impl<R: VertexSrc> Wound<R> {
    fn of(ring: R, exterior: bool) -> Self {
        if needs_reversal(ring, exterior) {
            Self::Reversed(ring)
        } else {
            Self::Plain(ring)
        }
    }

    /// The vertices stored, closing vertex excluded.
    fn stored(&self) -> usize {
        match self {
            Self::Plain(r) | Self::Reversed(r) => r.stored_ring_len(),
        }
    }

    fn vertex(&self, i: usize) -> Vertex {
        match self {
            Self::Plain(r) => r.vertex(i),
            Self::Reversed(r) => r.vertex(if i == 0 { 0 } else { r.stored_ring_len() - i }),
        }
    }

    #[cfg(test)]
    fn xy_at(&self, i: usize) -> (i32, i32) {
        let v = self.vertex(i);
        (v.x, v.y)
    }
}

/// Whether the ring winds against the MVT winding of its role, see [`winds_against`].
fn needs_reversal(ring: impl VertexSrc, exterior: bool) -> bool {
    let n = ring.stored_ring_len();
    winds_against((0..n).map(move |i| ring.xy(i)), exterior)
}

/// The rings of a polygon wound as MVT winds them.
fn wound<R: VertexSrc>(rings: impl Iterator<Item = R>) -> impl Iterator<Item = Wound<R>> {
    rings.enumerate().map(|(i, ring)| Wound::of(ring, i == 0))
}

/// Run the Earcut algorithm on the polygon with these `rings`, exterior first, append triangle
/// indices (shifted by `vertex_offset`) into `index_buf`, and return `(num_triangles, num_vertices)`.
///
/// `num_vertices` is how many vertices MLT stores for the polygon, which is where the next one starts.
/// A ring whose points all lie on a line is left out of the cut, since it holds no triangle and `earcut` can loop forever on one.
/// Indices are mapped back past it.
fn earcut_into<R: VertexSrc>(
    rings: impl Iterator<Item = Wound<R>>,
    vertex_offset: u32,
    index_buf: &mut Vec<u32>,
) -> (u32, u32) {
    let rings: Vec<Wound<R>> = rings.collect();
    let stored: usize = rings.iter().map(Wound::stored).sum();
    let num_vertices = u32::try_from(stored).expect("too many vertices");
    let Some(exterior) = rings.first().map(|ring| closed(*ring)).filter(has_area) else {
        return (0, num_vertices);
    };

    // Where each ring earcut sees starts among the vertices MLT stores.
    let mut holes = Vec::with_capacity(rings.len() - 1);
    let mut stored_starts = Vec::with_capacity(rings.len());
    stored_starts.push(0);
    let mut stored_start = rings[0].stored();
    for ring in &rings[1..] {
        let hole = closed(*ring);
        if has_area(&hole) {
            holes.push(hole);
            stored_starts.push(stored_start);
        }
        stored_start += ring.stored();
    }
    let polygon_f64: Polygon<f64> = Polygon::new(exterior, holes).convert();
    let raw = polygon_f64.earcut_triangles_raw();
    let num_triangles = u32::try_from(raw.triangle_indices.len() / 3).expect("too many triangles");

    // Earcut numbers the kept rings' vertices back to back, one per coordinate but the closing one.
    let mut earcut_starts = Vec::with_capacity(stored_starts.len());
    let mut earcut_start = 0;
    for ring in std::iter::once(polygon_f64.exterior()).chain(polygon_f64.interiors()) {
        earcut_starts.push(earcut_start);
        earcut_start += ring.0.len() - 1;
    }
    for i in raw.triangle_indices {
        let ring = earcut_starts.partition_point(|&start| start <= i) - 1;
        let stored = stored_starts[ring] + (i - earcut_starts[ring]);
        let idx = u32::try_from(stored)
            .ok()
            .and_then(|s| s.checked_add(vertex_offset))
            .expect("vertex index overflow");
        index_buf.push(idx);
    }

    (num_triangles, num_vertices)
}

/// The ring's stored vertices as a closed `geo` ring.
fn closed(ring: Wound<impl VertexSrc>) -> LineString<i32> {
    // Room for the closing vertex too, so closing does not reallocate.
    let mut coords = Vec::with_capacity(ring.stored() + 1);
    coords.extend((0..ring.stored()).map(|i| Coord::from(ring.vertex(i))));
    let mut line = LineString(coords);
    line.close();
    line
}

/// Whether a closed ring encloses any area, which one whose points all lie on a line does not.
///
/// A signed area would not do, since the lobes of a self-intersecting ring can cancel to `0`.
fn has_area(ring: &LineString<i32>) -> bool {
    let coords = &ring.0;
    if coords.len() < 4 {
        return false;
    }
    let origin = coords[0];
    let Some(&other) = coords.iter().find(|&&c| c != origin) else {
        return false;
    };
    let cross = |c: Coord<i32>| {
        (i64::from(other.x) - i64::from(origin.x)) * (i64::from(c.y) - i64::from(origin.y))
            - (i64::from(other.y) - i64::from(origin.y)) * (i64::from(c.x) - i64::from(origin.x))
    };
    coords.iter().any(|&c| cross(c) != 0)
}

/// Append `v` to the vertex buffer of a layer with `stride` words per vertex.
///
/// A layer with z needs one on every vertex, and a flat layer takes none: either is a
/// contract violation of [`GeometryValues::push_geom`], so it panics.
fn push_vertex(verts: &mut Vec<i32>, stride: usize, v: Vertex) {
    verts.extend([v.x, v.y]);
    if stride == 3 {
        verts.push(v.z.expect("a z on every vertex pushed into a layer with z"));
    } else {
        assert!(v.z.is_none(), "a z on a vertex pushed into a flat layer");
    }
}

impl GeometryValues {
    /// Returns a [`GeometryValues`] with its triangle offsets pre-initialized.
    ///
    /// When they are `Some`, polygon push methods automatically compute and store
    /// Earcut tessellation data as geometries are added.
    /// Use [`Self::default`] when tessellation is not required.
    #[must_use]
    pub fn new_tessellated() -> Self {
        Self {
            triangle_offsets: Some(vec![0]),
            ..Default::default()
        }
    }

    /// Put the vertices on the z grid `step`, three words each, before any is pushed.
    ///
    /// Every geometry pushed afterwards must have z. Panics after a vertex was pushed.
    #[cfg(feature = "unstable-v2")]
    #[must_use]
    pub fn with_z_step(mut self, step: ZStep) -> Self {
        assert!(
            self.vertices.as_ref().is_none_or(Vec::is_empty),
            "with_z_step after vertices were pushed"
        );
        self.z_step = Some(step);
        self
    }

    /// Reserve room for `geoms` more geometries, holding `coords` coordinates between them.
    pub(crate) fn reserve(&mut self, geoms: usize, coords: usize) {
        self.vector_types.reserve(geoms);
        if coords > 0 {
            let stride = self.stride();
            self.vertices
                .get_or_insert_with(Vec::new)
                .reserve(coords * stride);
        }
    }

    /// How many vertices the layer holds so far, which is where the next feature starts.
    fn stored_vertex_count(&self) -> u32 {
        let len = self.vertices.as_ref().map_or(0, Vec::len) / self.stride();
        u32::try_from(len).expect("vertex count overflow")
    }

    /// Tessellate the polygons of one feature, whose vertices start at `first_vertex`,
    /// into `self.index_buffer` and `self.triangle_offsets`.
    ///
    /// Each polygon's indices are shifted past the vertices of the ones before it,
    /// so every index names a vertex of the whole layer.
    fn tessellate_polygons<R: VertexSrc>(
        &mut self,
        polygons: impl IntoIterator<Item = impl Iterator<Item = Wound<R>>>,
        first_vertex: u32,
    ) {
        if let Some(offsets) = self.triangle_offsets.as_mut() {
            let mut total = *offsets.last().expect("offsets start at 0");
            let mut vertex_offset = first_vertex;
            let index_buffer = self.index_buffer.get_or_insert_with(Vec::new);
            for rings in polygons {
                let (num_triangles, num_verts) = earcut_into(rings, vertex_offset, index_buffer);
                total += num_triangles;
                vertex_offset += num_verts;
            }
            offsets.push(total);
        }
    }

    /// The values with `geom` added, see [`Self::push_geom`].
    #[must_use]
    pub fn with_geom(mut self, geom: &FeatureGeometry) -> Self {
        self.push_geom(geom);
        self
    }

    /// Add a feature's geometry, which is the reverse of [`Self::geometry`].
    ///
    /// Polygon rings are stored wound as MVT winds them. The geometry's dimension must
    /// match the layer's: z on every vertex after [`Self::with_z_step`], none otherwise;
    /// a mismatch panics. An empty geometry fits either.
    pub fn push_geom(&mut self, geom: &FeatureGeometry) {
        match geom.geometry_type() {
            GeometryType::Point => {
                self.push_point(geom.first_vertex().expect("a point has a vertex"));
            }
            GeometryType::LineString => self.push_linestring(geom.line_ref()),
            GeometryType::Polygon => self.push_polygon(geom.polygon_at(0).stored_rings()),
            GeometryType::MultiPoint => self.push_multi_point(geom.vertices()),
            GeometryType::MultiLineString => self.push_multi_linestring(geom.line_refs()),
            GeometryType::MultiPolygon => {
                self.push_multi_polygon(geom.polygon_refs().map(PolygonRef::stored_rings));
            }
        }
    }

    /// Add any geometry, as [`FeatureGeometry::from_geometry`] normalises it.
    pub fn push_geometry(&mut self, geom: &impl GeometryTrait<T = i32>) -> MltResult<()> {
        self.push_geom(&FeatureGeometry::from_geometry(geom)?);
        Ok(())
    }

    pub(crate) fn push_point(&mut self, vertex: Vertex) {
        self.vector_types.push(GeometryType::Point);
        let stride = self.stride();
        push_vertex(self.vertices.get_or_insert_with(Vec::new), stride, vertex);
    }

    pub(crate) fn push_linestring(&mut self, line: impl VertexSrc) {
        self.vector_types.push(GeometryType::LineString);

        let stride = self.stride();
        let verts = self.vertices.get_or_insert_with(Vec::new);
        // If ring_offsets exists (i.e., there's a Polygon in the layer),
        // add LineString vertex count to ring_offsets instead of part_offsets.
        // This matches Java's behavior where LineString adds to numRings when containsPolygon.
        let offsets = self
            .ring_offsets
            .as_mut()
            .unwrap_or_else(|| self.part_offsets.get_or_insert_with(Vec::new));

        push_linestrings(std::iter::once(line), verts, stride, offsets);
    }

    /// Add a polygon given as its rings, exterior first, each open or closed.
    pub(crate) fn push_polygon<R: VertexSrc>(&mut self, rings: impl Iterator<Item = R> + Clone) {
        // Only on the very first polygon: if LineStrings were pushed before us,
        // their vertex offsets are sitting in part_offsets. Move them to
        // ring_offsets now, before we set up ring_offsets for polygon use.
        // On subsequent polygons ring_offsets is already initialized and
        // part_offsets holds polygon ring-range data - leave both alone.
        self.vector_types.push(GeometryType::Polygon);
        self.init_polygon_offsets();
        let first_vertex = self.stored_vertex_count();

        let stride = self.stride();
        let verts = self.vertices.get_or_insert_with(Vec::new);
        let ring_offsets = self.ring_offsets.as_mut().unwrap();
        let parts = self.part_offsets.as_mut().unwrap();

        push_polygon_rings(wound(rings.clone()), verts, stride, ring_offsets, parts);
        self.tessellate_polygons([wound(rings)], first_vertex);
    }

    /// Initialize offset arrays for polygon storage. On the first polygon,
    /// moves any `LineString` vertex offsets from `part_offsets` to `ring_offsets`.
    fn init_polygon_offsets(&mut self) {
        if self.ring_offsets.is_none()
            && let Some(ls_parts) = self.part_offsets.take()
        {
            self.ring_offsets = Some(ls_parts);
        }
        init_offsets(self.ring_offsets.get_or_insert_with(Vec::new));
        init_offsets(self.part_offsets.get_or_insert_with(Vec::new));
    }

    pub(crate) fn push_multi_point(&mut self, points: impl Iterator<Item = Vertex>) {
        self.vector_types.push(GeometryType::MultiPoint);

        let stride = self.stride();
        let verts = self.vertices.get_or_insert_with(Vec::new);
        let mut count = 0_u32;
        for point in points {
            push_vertex(verts, stride, point);
            count += 1;
        }

        self.push_geometry_count(count);
    }

    pub(crate) fn push_multi_linestring(
        &mut self,
        lines: impl ExactSizeIterator<Item = impl VertexSrc>,
    ) {
        self.vector_types.push(GeometryType::MultiLineString);
        let count = u32::try_from(lines.len()).expect("linestring count overflow");

        // An empty multi contributes no part, so it must not bring a part level into
        // existence either: the offset arrays a layer has must be ones it fills.
        if count > 0 {
            let stride = self.stride();
            let verts = self.vertices.get_or_insert_with(Vec::new);
            // When a Polygon is present (ring_offsets exists), LineString vertex counts
            // go to ring_offsets instead of part_offsets. This matches Java's behavior.
            let offsets = self
                .ring_offsets
                .as_mut()
                .unwrap_or_else(|| self.part_offsets.get_or_insert_with(Vec::new));

            push_linestrings(lines, verts, stride, offsets);
        }

        self.push_geometry_count(count);
    }

    /// Add polygons, each given as its rings like [`Self::push_polygon`].
    pub(crate) fn push_multi_polygon<R: VertexSrc>(
        &mut self,
        polygons: impl ExactSizeIterator<Item = impl Iterator<Item = R> + Clone> + Clone,
    ) {
        self.vector_types.push(GeometryType::MultiPolygon);
        let first_vertex = self.stored_vertex_count();
        let count = u32::try_from(polygons.len()).expect("polygon count overflow");

        // An empty multi contributes no part and no ring, so it must not bring those
        // levels into existence either: the offset arrays a layer has must be ones it
        // fills. A `POLYGON EMPTY` still pushes its zero-length ring, since a non-multi
        // Polygon always contributes exactly its ring count.
        if count > 0 {
            self.init_polygon_offsets();

            let stride = self.stride();
            let verts = self.vertices.get_or_insert_with(Vec::new);
            let ring_offsets = self.ring_offsets.as_mut().unwrap();
            let parts = self.part_offsets.as_mut().unwrap();

            for rings in polygons.clone() {
                push_polygon_rings(wound(rings), verts, stride, ring_offsets, parts);
            }
        }

        self.push_geometry_count(count);
        self.tessellate_polygons(polygons.map(wound), first_vertex);
    }

    /// Initialize and update `geometry_offsets` with a sub-geometry count.
    fn push_geometry_count(&mut self, count: u32) {
        let g = self.geometry_offsets.get_or_insert_with(Vec::new);
        init_offsets(g);
        g.push(g.last().unwrap() + count);
    }
}

/// The layer with its polygon rings wound as the encoder stores them, and the values held per vertex moved along.
#[must_use]
pub fn wound_layer(layer: &TileLayer) -> TileLayer {
    let mut layer = layer.clone();
    for feature in &mut layer.features {
        #[cfg(feature = "unstable-v2")]
        if let Some(order) = feature.geometry.wound_vertex_order() {
            for m_value in &mut feature.m_values {
                m_value.reorder(&order);
            }
        }
        let wound = match feature.geometry.wound() {
            Cow::Owned(wound) => Some(wound),
            Cow::Borrowed(_) => None,
        };
        if let Some(wound) = wound {
            feature.geometry = wound;
        }
    }
    layer
}

/// Ensure offset array starts with 0.
fn init_offsets(v: &mut Vec<u32>) {
    if v.is_empty() {
        v.push(0);
    }
}

/// Push a single polygon's rings (exterior + interiors) to the offset arrays.
fn push_polygon_rings<R: VertexSrc>(
    polygon: impl Iterator<Item = Wound<R>>,
    verts: &mut Vec<i32>,
    stride: usize,
    rings: &mut Vec<u32>,
    parts: &mut Vec<u32>,
) {
    let mut ring_count = *parts.last().unwrap();
    for ring in polygon {
        push_ring(ring, verts, stride, rings);
        ring_count += 1;
    }
    parts.push(ring_count);
}

/// Push a ring's stored vertices to verts and update the rings offset.
fn push_ring<R: VertexSrc>(
    ring: Wound<R>,
    verts: &mut Vec<i32>,
    stride: usize,
    rings: &mut Vec<u32>,
) {
    let len = ring.stored();
    for i in 0..len {
        push_vertex(verts, stride, ring.vertex(i));
    }
    let prev = *rings.last().unwrap();
    rings.push(prev + u32::try_from(len).expect("vertex count overflow"));
}

/// Push linestrings to vertex buffer and offset array.
fn push_linestrings(
    iter: impl Iterator<Item = impl VertexSrc>,
    verts: &mut Vec<i32>,
    stride: usize,
    offsets: &mut Vec<u32>,
) {
    init_offsets(offsets);
    for ls in iter {
        for i in 0..ls.len() {
            push_vertex(verts, stride, ls.vertex(i));
        }
        let prev = *offsets.last().unwrap();
        offsets.push(prev + u32::try_from(ls.len()).expect("vertex count overflow"));
    }
}

#[cfg(test)]
mod tests {
    use geo_types::{LineString, MultiLineString, MultiPoint, MultiPolygon, Point, Polygon, wkt};
    use insta::assert_snapshot;
    use integer_encoding::VarInt;
    use proptest::prelude::*;

    use super::*;
    use geo_traits::to_geo::ToGeoGeometry as _;

    fn wound_rings(rings: &[&[(i32, i32)]]) -> Vec<Vec<(i32, i32)>> {
        let rings: Vec<Vec<Coord<i32>>> = rings
            .iter()
            .map(|ring| ring.iter().map(|&(x, y)| Coord { x, y }).collect())
            .collect();
        wound(rings.iter().map(Vec::as_slice))
            .map(|ring| (0..ring.stored()).map(|i| ring.xy_at(i)).collect())
            .collect()
    }

    #[test]
    fn wound_geometry_rewinds_every_polygon_of_a_multi_polygon() {
        let against = wkt! { MULTIPOLYGON(((0 0,0 9,9 9,9 0,0 0),(2 2,3 2,3 3,2 3,2 2))) };
        assert_eq!(
            FeatureGeometry::from_geometry(&Geometry::MultiPolygon(against))
                .unwrap()
                .wound()
                .to_geometry(),
            Geometry::MultiPolygon(
                wkt! { MULTIPOLYGON(((0 0,9 0,9 9,0 9,0 0),(2 2,2 3,3 3,3 2,2 2))) }
            )
        );
    }

    #[test]
    fn rings_already_wound_as_mvt_are_kept() {
        assert_eq!(
            wound_rings(&[
                &[(0, 0), (9, 0), (9, 9), (0, 9), (0, 0)],
                &[(2, 2), (2, 3), (3, 3), (3, 2), (2, 2)],
            ]),
            [
                vec![(0, 0), (9, 0), (9, 9), (0, 9)],
                vec![(2, 2), (2, 3), (3, 3), (3, 2)],
            ]
        );
    }

    #[test]
    fn rings_wound_against_mvt_are_reversed_and_keep_their_first_vertex() {
        assert_eq!(
            wound_rings(&[
                &[(0, 0), (0, 9), (9, 9), (9, 0), (0, 0)],
                &[(2, 2), (3, 2), (3, 3), (2, 3), (2, 2)],
            ]),
            [
                vec![(0, 0), (9, 0), (9, 9), (0, 9)],
                vec![(2, 2), (2, 3), (3, 3), (3, 2)],
            ]
        );
    }

    #[test]
    fn a_wound_ring_that_revisits_its_least_vertex_is_kept() {
        let ring: &[(i32, i32)] = &[
            (3702, 1966),
            (-64, -64),
            (-64, 10),
            (-64, -64),
            (-64, -64),
            (3702, 1966),
        ];
        let once = wound_rings(&[ring]);
        let once: Vec<&[(i32, i32)]> = once.iter().map(Vec::as_slice).collect();
        assert_eq!(wound_rings(&once), once);
    }

    #[test]
    fn an_open_ring_is_reversed_without_gaining_a_closing_vertex() {
        assert_eq!(
            wound_rings(&[&[(0, 0), (0, 9), (9, 9)]]),
            [vec![(0, 0), (9, 9), (0, 9)]]
        );
    }

    #[test]
    fn rings_far_from_the_origin_are_wound_without_overflow() {
        assert_eq!(
            wound_rings(&[&[
                (i32::MIN, i32::MIN),
                (i32::MIN, i32::MAX),
                (i32::MAX, i32::MAX),
                (i32::MAX, i32::MIN),
            ]]),
            [vec![
                (i32::MIN, i32::MIN),
                (i32::MAX, i32::MIN),
                (i32::MAX, i32::MAX),
                (i32::MIN, i32::MAX),
            ]]
        );
    }

    #[test]
    fn a_ring_with_no_area_keeps_its_direction() {
        assert_eq!(
            wound_rings(&[&[(0, 0), (4, 4), (8, 8), (0, 0)]]),
            [vec![(0, 0), (4, 4), (8, 8)]]
        );
    }

    use crate::__private::PhysicalEncoding;
    use crate::LazyParsed;
    use crate::decoder::{
        DictionaryType, IntEncoding, LengthType, LogicalEncoding, Morton, OffsetType, RawGeometry,
        StreamMeta, StreamType, VertexLogical,
    };
    use crate::encoder::model::StreamCtx;
    use crate::encoder::{
        Codecs, EncodedStream, Encoder, EncoderConfig, ExplicitEncoder, IntEncoder,
    };
    use crate::test_helpers::{assert_empty, dec, parser};
    use crate::utils::BinarySerializer as _;

    /// Encode, serialize, parse, and decode a `GeometryValues`.
    /// The input must already be in the dense canonical form that `from_encoded`
    /// produces (i.e. built via a previous `roundtrip` call, not via `push_*`).
    fn roundtrip(decoded: &GeometryValues) -> GeometryValues {
        let mut enc = Encoder::default();
        let mut codecs = Codecs::default();
        decoded
            .clone()
            .write_to(&mut enc, &mut codecs)
            .expect("Failed to encode");

        let parsed = assert_empty(RawGeometry::from_bytes(enc.data(), &mut parser()));

        LazyParsed::Raw(parsed)
            .into_parsed(&mut dec())
            .expect("Failed to decode")
    }

    /// Build a `GeometryValues` from a sequence of `geo_types::Geometry::<i32>` values via
    /// `push_geom` and perform a two-cycle encode/decode:
    ///
    /// 1. push -> encode -> decode  (`canonical`): exercises `push_geom` and
    ///    `normalize_geometry_offsets`; normalizes the sparse push_* layout to
    ///    the dense form that `from_encoded` always returns.
    /// 2. canonical -> encode -> decode  (`output`): verifies idempotency of
    ///    encode/decode on the canonical form
    ///
    /// Comparing `canonical == output` catches both panics in the push path
    /// and silent data corruption in encode/decode
    fn roundtrip_via_push(geoms: &[Geometry<i32>]) -> (GeometryValues, GeometryValues) {
        let mut pushed = GeometryValues::default();
        for g in geoms {
            pushed.push_geometry(g).unwrap();
        }
        let canonical = roundtrip(&pushed);
        let output = roundtrip(&canonical);
        (canonical, output)
    }

    fn arb_coord() -> impl Strategy<Value = Coord<i32>> {
        (any::<i32>(), any::<i32>()).prop_map(|(x, y)| Coord::<i32> { x, y })
    }

    fn arb_geom() -> impl Strategy<Value = Geometry<i32>> {
        prop_oneof![
            // Point
            arb_coord().prop_map(Point).prop_map(Geometry::<i32>::Point),
            // LineString
            prop::collection::vec(arb_coord(), 2..10)
                .prop_map(|coords| Geometry::<i32>::LineString(LineString(coords))),
            // Polygon (single exterior ring, no holes)
            prop::collection::vec(arb_coord(), 3..8).prop_map(|mut coords| {
                coords.push(coords[0]);
                Geometry::<i32>::Polygon(Polygon::new(LineString(coords), vec![]))
            }),
            // MultiPoint
            prop::collection::vec(arb_coord(), 2..8).prop_map(|coords| {
                Geometry::<i32>::MultiPoint(MultiPoint(coords.into_iter().map(Point).collect()))
            }),
            // MultiLineString
            prop::collection::vec(prop::collection::vec(arb_coord(), 2..6), 2..5,).prop_map(
                |lines| Geometry::<i32>::MultiLineString(MultiLineString(
                    lines.into_iter().map(LineString).collect(),
                ))
            ),
            // MultiPolygon
            prop::collection::vec(arb_coord(), 3..6).prop_map(|mut coords| {
                coords.push(coords[0]);
                Geometry::<i32>::MultiPolygon(MultiPolygon(vec![Polygon::new(
                    LineString(coords),
                    vec![],
                )]))
            }),
        ]
    }

    /// Mixing `LineString` with `MultiLineString`
    fn arb_mixed_linestring_geoms() -> impl Strategy<Value = Vec<Geometry<i32>>> {
        prop::collection::vec(arb_geom(), 2..12)
            .prop_map(|geoms| {
                geoms
                    .into_iter()
                    .filter(|g| {
                        matches!(
                            g,
                            Geometry::<i32>::LineString(_) | Geometry::<i32>::MultiLineString(_)
                        )
                    })
                    .collect::<Vec<_>>()
            })
            .prop_filter("needs both LS and MLS", |geoms| {
                geoms
                    .iter()
                    .any(|g| matches!(g, Geometry::<i32>::LineString(_)))
                    && geoms
                        .iter()
                        .any(|g| matches!(g, Geometry::<i32>::MultiLineString(_)))
            })
    }

    /// Mixing `Point` with `MultiPoint`
    fn arb_mixed_point_geoms() -> impl Strategy<Value = Vec<Geometry<i32>>> {
        prop::collection::vec(arb_geom(), 2..12)
            .prop_map(|geoms| {
                geoms
                    .into_iter()
                    .filter(|g| {
                        matches!(
                            g,
                            Geometry::<i32>::Point(_) | Geometry::<i32>::MultiPoint(_)
                        )
                    })
                    .collect::<Vec<_>>()
            })
            .prop_filter("needs both P and MP", |geoms| {
                geoms.iter().any(|g| matches!(g, Geometry::<i32>::Point(_)))
                    && geoms
                        .iter()
                        .any(|g| matches!(g, Geometry::<i32>::MultiPoint(_)))
            })
    }

    /// Mixing `Polygon` with `MultiPolygon`
    fn arb_mixed_polygon_geoms() -> impl Strategy<Value = Vec<Geometry<i32>>> {
        prop::collection::vec(arb_geom(), 2..8)
            .prop_map(|geoms| {
                geoms
                    .into_iter()
                    .filter(|g| {
                        matches!(
                            g,
                            Geometry::<i32>::Polygon(_) | Geometry::<i32>::MultiPolygon(_)
                        )
                    })
                    .collect::<Vec<_>>()
            })
            .prop_filter("needs both Poly and MPoly", |geoms| {
                geoms
                    .iter()
                    .any(|g| matches!(g, Geometry::<i32>::Polygon(_)))
                    && geoms
                        .iter()
                        .any(|g| matches!(g, Geometry::<i32>::MultiPolygon(_)))
            })
    }

    /// Mixing `Point` with `MultiLineString`
    fn arb_cross_point_mls_geoms() -> impl Strategy<Value = Vec<Geometry<i32>>> {
        prop::collection::vec(
            prop_oneof![
                arb_coord().prop_map(Point).prop_map(Geometry::<i32>::Point),
                prop::collection::vec(prop::collection::vec(arb_coord(), 2..6), 2..5).prop_map(
                    |lines| {
                        Geometry::<i32>::MultiLineString(MultiLineString(
                            lines.into_iter().map(LineString).collect(),
                        ))
                    }
                ),
            ],
            2..12,
        )
        .prop_filter("needs both Point and MultiLineString", |geoms| {
            geoms.iter().any(|g| matches!(g, Geometry::<i32>::Point(_)))
                && geoms
                    .iter()
                    .any(|g| matches!(g, Geometry::<i32>::MultiLineString(_)))
        })
    }

    /// Mixing `Point` with `MultiPolygon`.
    fn arb_cross_point_mpoly_geoms() -> impl Strategy<Value = Vec<Geometry<i32>>> {
        prop::collection::vec(
            prop_oneof![
                arb_coord().prop_map(Point).prop_map(Geometry::<i32>::Point),
                prop::collection::vec(arb_coord(), 3..6).prop_map(|mut coords| {
                    coords.push(coords[0]);
                    Geometry::<i32>::MultiPolygon(MultiPolygon(vec![Polygon::new(
                        LineString(coords),
                        vec![],
                    )]))
                }),
            ],
            2..10,
        )
        .prop_filter("needs both Point and MultiPolygon", |geoms| {
            geoms.iter().any(|g| matches!(g, Geometry::<i32>::Point(_)))
                && geoms
                    .iter()
                    .any(|g| matches!(g, Geometry::<i32>::MultiPolygon(_)))
        })
    }

    /// Mixing `LineString` with `MultiPolygon`
    fn arb_cross_ls_mpoly_geoms() -> impl Strategy<Value = Vec<Geometry<i32>>> {
        prop::collection::vec(
            prop_oneof![
                prop::collection::vec(arb_coord(), 2..8)
                    .prop_map(|coords| Geometry::<i32>::LineString(LineString(coords))),
                prop::collection::vec(arb_coord(), 3..6).prop_map(|mut coords| {
                    coords.push(coords[0]);
                    Geometry::<i32>::MultiPolygon(MultiPolygon(vec![Polygon::new(
                        LineString(coords),
                        vec![],
                    )]))
                }),
            ],
            2..10,
        )
        .prop_filter("needs both LineString and MultiPolygon", |geoms| {
            geoms
                .iter()
                .any(|g| matches!(g, Geometry::<i32>::LineString(_)))
                && geoms
                    .iter()
                    .any(|g| matches!(g, Geometry::<i32>::MultiPolygon(_)))
        })
    }

    proptest! {
        #[test]
        fn test_geometry_roundtrip(geom in arb_geom()) {
            let (canonical, output) = roundtrip_via_push(&[geom]);
            prop_assert_eq!(output, canonical);
        }

        #[test]
        fn test_mixed_linestring_roundtrip(geoms in arb_mixed_linestring_geoms()) {
            let (canonical, output) = roundtrip_via_push(&geoms);
            prop_assert_eq!(output, canonical);
        }

        #[test]
        fn test_mixed_point_roundtrip(geoms in arb_mixed_point_geoms()) {
            let (canonical, output) = roundtrip_via_push(&geoms);
            prop_assert_eq!(output, canonical);
        }

        #[test]
        fn test_mixed_polygon_roundtrip(geoms in arb_mixed_polygon_geoms()) {
            let (canonical, output) = roundtrip_via_push(&geoms);
            prop_assert_eq!(output, canonical);
        }

        #[ignore = "encoder does not implement this correctly"]
        #[test]
        fn test_cross_point_mls_roundtrip(geoms in arb_cross_point_mls_geoms()) {
            let (canonical, output) = roundtrip_via_push(&geoms);
            prop_assert_eq!(output, canonical);
        }

        #[ignore = "encoder does not implement this correctly"]
        #[test]
        fn test_cross_point_mpoly_roundtrip(geoms in arb_cross_point_mpoly_geoms()) {
            let (canonical, output) = roundtrip_via_push(&geoms);
            prop_assert_eq!(output, canonical);
        }

        #[test]
        fn test_cross_ls_mpoly_roundtrip(geoms in arb_cross_ls_mpoly_geoms()) {
            let (canonical, output) = roundtrip_via_push(&geoms);
            prop_assert_eq!(output, canonical);
        }
    }

    /// Verifies that a Morton-encoded vertex dictionary is fully expanded inside `from_encoded`.
    /// This ensures `GeometryValues` always holds flat `(x, y)` pairs.
    #[test]
    fn test_morton_vertex_dictionary_expansion() {
        use integer_encoding::VarIntWriter as _;

        // Morton vertex dictionary: 3 unique entries.
        // Raw codes [0, 16, 32] -> delta-encoded as [0, 16, 16].
        // The MortonDelta logical encoding means the decoder will undo the delta,
        // then decode each Morton code to an (x, y) pair.
        let mut raw_bytes = vec![];
        let mut buf = [0u8; 10];
        for &v in &[0_u64, 16, 16] {
            let n = v.encode_var(&mut buf);
            raw_bytes.extend_from_slice(&buf[..n]);
        }

        let morton_dict = EncodedStream {
            meta: StreamMeta::new(
                StreamType::Data(DictionaryType::Morton),
                IntEncoding::new(
                    LogicalEncoding::Vertex(VertexLogical::MortonDelta(Morton {
                        bits: 3,
                        shift: 0,
                    })),
                    PhysicalEncoding::VarInt,
                ),
                3, // 3 dictionary entries -> 3 physical u32 values
            ),
            data: raw_bytes,
        };

        // Assemble, serialize, parse, decode - same wire layout as geometry encoder:
        // stream count, then meta (geom type), parts, vertex offsets, Morton dict.
        let mut codecs = Codecs::default();
        let mut enc = Encoder::with_explicit(
            EncoderConfig::default(),
            ExplicitEncoder::all(IntEncoder::varint()),
        );
        enc.write_varint(4u32).unwrap();
        codecs
            .write_int_stream(
                &[GeometryType::LineString as u32],
                &StreamCtx::geom(StreamType::Length(LengthType::VarBinary), "meta"),
                &mut enc,
            )
            .unwrap();
        codecs
            .write_int_stream(
                &[4u32],
                &StreamCtx::geom(StreamType::Length(LengthType::Parts), "parts"),
                &mut enc,
            )
            .unwrap();
        codecs
            .write_int_stream(
                &[0u32, 1, 2, 1],
                &StreamCtx::geom(StreamType::Offset(OffsetType::Vertex), "vertex"),
                &mut enc,
            )
            .unwrap();
        enc.write_stream(&morton_dict).unwrap();
        let buffer = enc.data().to_vec();

        let mut p = parser();
        let parsed = assert_empty(RawGeometry::from_bytes(&buffer, &mut p));
        assert_snapshot!(p.reserved(), @"72");

        let mut d = dec();
        let decoded = LazyParsed::Raw(parsed).into_parsed(&mut d).unwrap();
        assert_snapshot!(d.consumed(), @"100");
        assert_eq!(decoded.vertices, Some(vec![0i32, 0, 4, 0, 0, 4, 4, 0]));

        let geom = decoded.to_geojson(0).unwrap();
        assert_eq!(geom, wkt!(LINESTRING(0 0,4 0,0 4,4 0)).into());
    }

    mod tessellation_tests {
        use geo_types::{Geometry, LineString, MultiPolygon, Polygon};
        use usize_cast::IntoUsize as _;

        use crate::decoder::GeometryValues;

        #[test]
        fn earcut_polygon_indices_in_range() {
            let exterior = LineString::from(vec![(0_i32, 0), (10, 0), (10, 10), (0, 10), (0, 0)]);
            let polygon = Polygon::new(exterior, vec![]);
            let mut g = GeometryValues::new_tessellated();
            g.push_geometry(&Geometry::<i32>::Polygon(polygon)).unwrap();
            let tris = g.triangle_offsets().expect("triangle offsets");
            let n = tris[1];
            assert!(n > 0, "expected at least one triangle");
            let ib = g.index_buffer().expect("index buffer");
            assert_eq!(ib.len(), n.into_usize() * 3);
            // 4 unique (non-closing) vertices -> indices in 0..4
            assert!(ib.iter().all(|&i| i < 4));
        }

        #[test]
        fn earcut_vertex_offset_for_multi_polygon_parts() {
            let exterior1 = LineString::from(vec![(0_i32, 0), (10, 0), (10, 10), (0, 10), (0, 0)]);
            let poly1 = Polygon::new(exterior1, vec![]);
            let exterior2 = LineString::from(vec![(20, 0), (30, 0), (30, 10), (20, 10), (20, 0)]);
            let poly2 = Polygon::new(exterior2, vec![]);
            let mut g = GeometryValues::new_tessellated();
            g.push_geometry(&Geometry::<i32>::MultiPolygon(MultiPolygon(vec![
                poly1, poly2,
            ])))
            .unwrap();
            let ib = g.index_buffer().expect("index buffer");
            let tris = g.triangle_offsets().expect("triangle offsets");
            assert_eq!(tris.len(), 2);
            let total = tris[1].into_usize();
            assert_eq!(ib.len(), total * 3);
            // First quad: 4 verts -> 2 triangles, 6 indices
            let split = 6;
            let (first, second) = ib.split_at(split);
            assert!(
                first.iter().all(|&i| i < 4),
                "first polygon indices should reference verts 0..4: {first:?}"
            );
            assert!(
                second.iter().all(|&i| (4..8).contains(&i)),
                "second polygon indices should reference verts 4..8: {second:?}"
            );
        }

        fn square(x: i32) -> Polygon<i32> {
            Polygon::new(
                LineString::from(vec![(x, 0), (x + 10, 0), (x + 10, 10), (x, 10), (x, 0)]),
                vec![],
            )
        }

        fn triangles(geometry: &Geometry<i32>) -> Vec<u32> {
            let mut g = GeometryValues::new_tessellated();
            g.push_geometry(geometry).unwrap();
            g.index_buffer().unwrap_or_default().to_vec()
        }

        #[test]
        fn a_polygon_of_one_repeated_coordinate_has_no_triangles() {
            let point = Polygon::new(LineString::from(vec![(5, 5), (5, 5), (5, 5)]), vec![]);
            assert_eq!(triangles(&Geometry::Polygon(point)), Vec::<u32>::new());
        }

        #[test]
        fn a_one_coordinate_polygon_still_shifts_the_next_polygons_indices() {
            let point = Polygon::new(LineString::from(vec![(5, 5)]), vec![]);
            let geometry = Geometry::MultiPolygon(MultiPolygon(vec![point, square(20)]));
            assert_eq!(triangles(&geometry), [3, 4, 1, 1, 2, 3]);
        }

        #[test]
        fn a_self_intersecting_ring_is_cut_although_its_signed_area_is_zero() {
            let bowtie = Polygon::new(
                LineString::from(vec![(0, 0), (10, 10), (0, 10), (10, 0), (0, 0)]),
                vec![],
            );
            assert_eq!(triangles(&Geometry::Polygon(bowtie)), [1, 0, 3]);
        }

        #[test]
        fn a_spike_with_a_hole_of_one_repeated_point_is_cut_without_the_hole() {
            let spike = Polygon::new(
                LineString::from(vec![
                    (542, 543),
                    (543, 543),
                    (543, 2657),
                    (543, 543),
                    (543, 543),
                    (543, 543),
                    (543, 543),
                    (543, 543),
                    (542, 543),
                ]),
                vec![
                    LineString::from(vec![(1232, 1232); 8]),
                    LineString::from(vec![
                        (1232, 1232),
                        (1232, 716),
                        (1232, 1232),
                        (1232, 2096),
                        (2096, 2096),
                        (2096, 2096),
                        (1232, 1232),
                    ]),
                ],
            );
            assert_eq!(triangles(&Geometry::Polygon(spike)), Vec::<u32>::new());
        }

        #[test]
        fn a_hole_without_area_is_skipped_but_counted() {
            let mut holed = square(0);
            holed.interiors_push(LineString::from(vec![(2, 2), (3, 3)]));
            let geometry = Geometry::MultiPolygon(MultiPolygon(vec![holed, square(20)]));
            assert_eq!(triangles(&geometry), [2, 3, 0, 0, 1, 2, 8, 9, 6, 6, 7, 8]);
        }
    }

    #[rstest::rstest]
    #[case::line(
        Geometry::Line(geo_types::Line::new((0, 0), (5, 5))),
        wkt!(LINESTRING(0 0, 5 5)).into()
    )]
    #[case::triangle(
        Geometry::Triangle(geo_types::Triangle::new((0, 0).into(), (5, 0).into(), (0, 5).into())),
        wkt!(POLYGON((0 0, 5 0, 0 5, 0 0))).into()
    )]
    #[case::rect(
        Geometry::Rect(geo_types::Rect::new((0, 0), (5, 5))),
        wkt!(POLYGON((5 0, 5 5, 0 5, 0 0, 5 0))).into()
    )]
    fn a_geometry_without_its_own_type_pushes_as_its_equivalent(
        #[case] geometry: Geometry<i32>,
        #[case] equivalent: Geometry<i32>,
    ) {
        assert_eq!(
            GeometryValues::default()
                .with_geom(&FeatureGeometry::from_geometry(&geometry).unwrap()),
            GeometryValues::default()
                .with_geom(&FeatureGeometry::from_geometry(&equivalent).unwrap())
        );
    }

    #[test]
    fn a_geometry_collection_is_not_one_feature() {
        let point: Geometry<i32> = wkt!(POINT(1 2)).into();
        let collection = Geometry::GeometryCollection(geo_types::GeometryCollection(vec![point]));
        let err = GeometryValues::default()
            .push_geometry(&collection)
            .unwrap_err();
        assert!(
            matches!(err, crate::MltError::GeometryCollectionUnsupported),
            "{err}"
        );
    }

    #[test]
    fn a_multi_polygon_fills_every_offset_level() {
        let geometry = GeometryValues::default().with_geom(
            &FeatureGeometry::from_geometry(&Geometry::<i32>::from(wkt!(MULTIPOLYGON(
                ((0 0, 5 0, 0 5, 0 0)),
                ((10 10, 15 10, 10 15, 10 10))
            ))))
            .unwrap(),
        );
        assert_snapshot!(
            format!(
                "{:?} {:?} {:?}",
                geometry.geometry_offsets(),
                geometry.part_offsets(),
                geometry.ring_offsets()
            ),
            @"Some([0, 2]) Some([0, 1, 2]) Some([0, 3, 6])"
        );
    }
}
