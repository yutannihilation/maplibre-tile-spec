//! One feature's geometry in row form.
//!
//! A [`FeatureGeometry`] stores its coordinates interleaved, `x y` or `x y z` per
//! vertex, with every ring's closing vertex left out: the form the wire stores and
//! m-values and z run over. It implements the [`geo_traits`] traits with `T = i32`,
//! closing rings on read like [`GeometryView`] does, and is what [`crate::TileFeature`]
//! holds. The rule deciding which vertices a geometry stores lives here and nowhere else.

use std::borrow::Cow;

use geo_traits::{
    CoordTrait, Dimensions, GeometryTrait, GeometryType as GeoKind, LineStringTrait, LineTrait,
    MultiLineStringTrait, MultiPointTrait, MultiPolygonTrait, PointTrait, PolygonTrait, RectTrait,
    TriangleTrait, UnimplementedGeometryCollection, UnimplementedLine,
    UnimplementedMultiLineString, UnimplementedMultiPoint, UnimplementedMultiPolygon,
    UnimplementedRect, UnimplementedTriangle,
};
use smallvec::SmallVec;
use usize_cast::IntoUsize as _;

use crate::MltError::{
    EmptyPoint, GeometryCollectionUnsupported, GeometryDimensionUnsupported,
    VertexDimensionMismatch, ZAlreadySet, ZVertexCountMismatch,
};
use crate::decoder::{GeometryType, GeometryView, LineView, PolygonView, Vertex};
use crate::errors::AsMltError as _;
use crate::{Decoder, MltResult};

/// Words a geometry holds without a heap allocation: a 2D or 3D point.
const INLINE_WORDS: usize = 6;

/// Part or polygon ends held without a heap allocation, so a polygon with up to three
/// holes, or a multi-part geometry of up to four parts, allocates only its coordinates.
const INLINE_ENDS: usize = 4;

type Ends = SmallVec<[u32; INLINE_ENDS]>;

/// One feature's geometry: coordinates interleaved on its dimension, closing vertices omitted.
///
/// Built by [`Self::from_geometry`] from anything implementing [`GeometryTrait`], by
/// [`Self::from_view`] from a decoded feature, or by the shape constructors. A point
/// allocates nothing; any other geometry allocates its coordinates and, when it has
/// several parts, the part and polygon boundaries.
#[derive(Clone, PartialEq, Eq, Hash)]
pub struct FeatureGeometry {
    kind: GeometryType,
    /// `Xy` or `Xyz`; `Xy` when there are no vertices.
    dim: Dimensions,
    coords: SmallVec<[i32; INLINE_WORDS]>,
    /// Cumulative stored vertices at the end of each part: the lines of a multi-line-string,
    /// or the rings of the polygons. Empty for a point, multi-point or line string.
    part_ends: Ends,
    /// Cumulative parts at the end of each polygon of a multi-polygon; empty otherwise.
    polygon_ends: Ends,
}

/// A value that can become a [`FeatureGeometry`], which [`crate::TileFeature`] and
/// [`crate::TileLayerBuilder`] take.
///
/// Implemented for `FeatureGeometry` itself, [`GeometryView`], and `geo_types::Geometry<i32>`
/// by value or reference. Any other [`GeometryTrait`] type goes through
/// [`FeatureGeometry::from_geometry`].
pub trait IntoFeatureGeometry {
    fn into_feature_geometry(self) -> MltResult<FeatureGeometry>;
}

impl IntoFeatureGeometry for FeatureGeometry {
    fn into_feature_geometry(self) -> MltResult<FeatureGeometry> {
        Ok(self)
    }
}

impl IntoFeatureGeometry for &FeatureGeometry {
    fn into_feature_geometry(self) -> MltResult<FeatureGeometry> {
        Ok(self.clone())
    }
}

impl IntoFeatureGeometry for GeometryView<'_> {
    fn into_feature_geometry(self) -> MltResult<FeatureGeometry> {
        Ok(FeatureGeometry::from_view(self))
    }
}

impl IntoFeatureGeometry for geo_types::Geometry<i32> {
    fn into_feature_geometry(self) -> MltResult<FeatureGeometry> {
        FeatureGeometry::from_geometry(&self)
    }
}

impl IntoFeatureGeometry for &geo_types::Geometry<i32> {
    fn into_feature_geometry(self) -> MltResult<FeatureGeometry> {
        FeatureGeometry::from_geometry(self)
    }
}

impl From<geo_types::Coord<i32>> for Vertex {
    fn from(c: geo_types::Coord<i32>) -> Self {
        Self {
            x: c.x,
            y: c.y,
            z: None,
        }
    }
}

impl From<Vertex> for geo_types::Coord<i32> {
    fn from(v: Vertex) -> Self {
        Self { x: v.x, y: v.y }
    }
}

/// Whether `dim` is one a feature can store.
fn check_dim(dim: Dimensions) -> MltResult<()> {
    match dim {
        Dimensions::Xy | Dimensions::Xyz => Ok(()),
        Dimensions::Xym | Dimensions::Xyzm | Dimensions::Unknown(_) => {
            Err(GeometryDimensionUnsupported(dim))
        }
    }
}

/// Whether the ring winds against the MVT winding of its role, counter-clockwise outside and
/// clockwise inside, by the sign of the surveyor's area over its stored vertices.
///
/// A ring of zero area has no winding. Reversing a ring negates its area, so a wound ring
/// is never reversed again. The area is summed on `i128`, since `i32` products overflow.
pub(crate) fn winds_against(
    stored: impl Iterator<Item = (i32, i32)> + Clone,
    exterior: bool,
) -> bool {
    let next = stored.clone().cycle().skip(1);
    let area: i128 = stored
        .zip(next)
        .map(|(a, b)| i128::from(a.0) * i128::from(b.1) - i128::from(b.0) * i128::from(a.1))
        .sum();
    if exterior { area < 0 } else { area > 0 }
}

/// Assembles a geometry part by part, holding the one rule about which vertices are stored.
pub(crate) struct Builder {
    kind: GeometryType,
    dim: Dimensions,
    coords: SmallVec<[i32; INLINE_WORDS]>,
    part_ends: Ends,
    polygon_ends: Ends,
}

impl Builder {
    fn new(kind: GeometryType, dim: Dimensions) -> MltResult<Self> {
        check_dim(dim)?;
        Ok(Self {
            kind,
            dim,
            coords: SmallVec::new(),
            part_ends: Ends::new(),
            polygon_ends: Ends::new(),
        })
    }

    /// Room for `vertices` vertices, `parts` parts and `polygons` polygons, at most one
    /// allocation each.
    fn reserve(&mut self, vertices: usize, parts: usize, polygons: usize) {
        self.coords.reserve_exact(vertices * self.dim.size());
        self.part_ends.reserve_exact(parts);
        self.polygon_ends.reserve_exact(polygons);
    }

    fn vertex_count(&self) -> usize {
        self.coords.len() / self.dim.size()
    }

    fn vertex(&mut self, v: Vertex) -> MltResult<()> {
        if v.z.is_some() != (self.dim == Dimensions::Xyz) {
            return Err(VertexDimensionMismatch {
                expected: self.dim,
                vertex: self.vertex_count(),
            });
        }
        self.coords.push(v.x);
        self.coords.push(v.y);
        if let Some(z) = v.z {
            self.coords.push(z);
        }
        Ok(())
    }

    pub(crate) fn end_part(&mut self) -> MltResult<()> {
        let end = u32::try_from(self.vertex_count()).or_overflow()?;
        self.part_ends.push(end);
        Ok(())
    }

    pub(crate) fn end_polygon(&mut self) -> MltResult<()> {
        let end = u32::try_from(self.part_ends.len()).or_overflow()?;
        self.polygon_ends.push(end);
        Ok(())
    }

    /// A line string, or the points of a multi-point: every vertex is stored.
    fn run(&mut self, vertices: impl IntoIterator<Item = Vertex>) -> MltResult<()> {
        for v in vertices {
            self.vertex(v)?;
        }
        Ok(())
    }

    /// A ring: a closing vertex equal to the first in every dimension is not stored, and a
    /// ring left with no vertex is not a ring.
    fn ring(&mut self, vertices: impl IntoIterator<Item = Vertex>) -> MltResult<()> {
        let stride = self.dim.size();
        let start = self.coords.len();
        self.run(vertices)?;
        let stored = (self.coords.len() - start) / stride;
        if stored > 1
            && self.coords[start..start + stride] == self.coords[self.coords.len() - stride..]
        {
            self.coords.truncate(self.coords.len() - stride);
        }
        if self.coords.len() == start {
            return Ok(());
        }
        self.end_part()
    }

    /// A decoded line string or part: its stored words, copied whole when contiguous.
    fn run_view(&mut self, l: &LineView<'_>, read: Read) -> MltResult<()> {
        match l.stored_words() {
            Some(words) => {
                self.coords.extend_from_slice(words);
                Ok(())
            }
            None => self.run(read.line(l)),
        }
    }

    /// A decoded ring. The view closes a stored ring by repeating its first vertex, which
    /// [`Self::ring`] drops again, so the stored words are what a ring keeps.
    fn ring_view(&mut self, l: &LineView<'_>, read: Read) -> MltResult<()> {
        match l.stored_words() {
            Some([]) => Ok(()),
            Some(words) => {
                self.coords.extend_from_slice(words);
                self.end_part()
            }
            None => self.ring(read.line(l)),
        }
    }

    fn polygon_view(&mut self, p: &PolygonView<'_>, read: Read) -> MltResult<()> {
        if let Some(exterior) = p.exterior() {
            self.ring_view(&exterior, read)?;
        }
        for interior in p.interiors() {
            self.ring_view(&interior, read)?;
        }
        Ok(())
    }

    fn polygon(
        &mut self,
        rings: impl IntoIterator<Item = impl IntoIterator<Item = Vertex>>,
    ) -> MltResult<()> {
        for ring in rings {
            self.ring(ring)?;
        }
        Ok(())
    }

    /// A flat builder for a decoder that learns the geometry's kind only after reading
    /// every part, with room for `words` coordinate words. The decoder stores every vertex
    /// it is given, marks part and polygon ends as a multi-geometry would, and names the
    /// kind in [`Self::finish_as`].
    pub(crate) fn flat(words: usize) -> Self {
        let mut b = Self {
            kind: GeometryType::MultiPoint,
            dim: Dimensions::Xy,
            coords: SmallVec::new(),
            part_ends: Ends::new(),
            polygon_ends: Ends::new(),
        };
        b.coords.reserve_exact(words);
        b
    }

    pub(crate) fn push_xy(&mut self, x: i32, y: i32) {
        self.coords.push(x);
        self.coords.push(y);
    }

    /// The coordinate words stored so far.
    pub(crate) fn words(&self) -> &[i32] {
        &self.coords
    }

    /// Finish as `kind`, dropping the ends a single geometry of that kind does not keep:
    /// a line string has no part ends, a polygon no polygon ends.
    pub(crate) fn finish_as(mut self, kind: GeometryType) -> FeatureGeometry {
        match kind {
            GeometryType::Point | GeometryType::LineString => self.part_ends.clear(),
            GeometryType::Polygon => self.polygon_ends.clear(),
            GeometryType::MultiPoint
            | GeometryType::MultiLineString
            | GeometryType::MultiPolygon => {}
        }
        self.kind = kind;
        self.finish()
    }

    fn finish(self) -> FeatureGeometry {
        let dim = if self.coords.is_empty() {
            Dimensions::Xy
        } else {
            self.dim
        };
        FeatureGeometry {
            kind: self.kind,
            dim,
            coords: self.coords,
            part_ends: self.part_ends,
            polygon_ends: self.polygon_ends,
        }
    }
}

impl FeatureGeometry {
    /// A point, which is stored inline.
    #[must_use]
    pub fn point(v: Vertex) -> Self {
        let mut coords = SmallVec::new();
        coords.extend([v.x, v.y]);
        coords.extend(v.z);
        Self {
            kind: GeometryType::Point,
            dim: v.dim(),
            coords,
            part_ends: Ends::new(),
            polygon_ends: Ends::new(),
        }
    }

    /// A multi-point of `points`, each of which must have `dim`.
    pub fn multi_point(
        dim: Dimensions,
        points: impl IntoIterator<Item = Vertex>,
    ) -> MltResult<Self> {
        let mut b = Builder::new(GeometryType::MultiPoint, dim)?;
        b.run(points)?;
        Ok(b.finish())
    }

    /// A line string of `vertices`, each of which must have `dim`.
    pub fn line_string(
        dim: Dimensions,
        vertices: impl IntoIterator<Item = Vertex>,
    ) -> MltResult<Self> {
        let mut b = Builder::new(GeometryType::LineString, dim)?;
        b.run(vertices)?;
        Ok(b.finish())
    }

    /// A multi-line-string of `lines`.
    pub fn multi_line_string(
        dim: Dimensions,
        lines: impl IntoIterator<Item = impl IntoIterator<Item = Vertex>>,
    ) -> MltResult<Self> {
        let mut b = Builder::new(GeometryType::MultiLineString, dim)?;
        for line in lines {
            b.run(line)?;
            b.end_part()?;
        }
        Ok(b.finish())
    }

    /// A polygon of `rings`, exterior first, each open or closed. A ring with no vertices
    /// is left out, so `POLYGON EMPTY` is a polygon of no rings.
    pub fn polygon(
        dim: Dimensions,
        rings: impl IntoIterator<Item = impl IntoIterator<Item = Vertex>>,
    ) -> MltResult<Self> {
        let mut b = Builder::new(GeometryType::Polygon, dim)?;
        b.polygon(rings)?;
        Ok(b.finish())
    }

    /// A multi-polygon of `polygons`, each given as its rings like [`Self::polygon`].
    pub fn multi_polygon(
        dim: Dimensions,
        polygons: impl IntoIterator<Item = impl IntoIterator<Item = impl IntoIterator<Item = Vertex>>>,
    ) -> MltResult<Self> {
        let mut b = Builder::new(GeometryType::MultiPolygon, dim)?;
        for polygon in polygons {
            b.polygon(polygon)?;
            b.end_polygon()?;
        }
        Ok(b.finish())
    }

    /// Any geometry as a feature's: `Rect` and `Triangle` become a polygon, `Line` a line
    /// string, and a ring's closing vertex is dropped.
    ///
    /// Fails for a geometry collection, a dimension other than `Xy` or `Xyz`, an empty
    /// point, or a part count past `u32`.
    pub fn from_geometry(g: &impl GeometryTrait<T = i32>) -> MltResult<Self> {
        Self::build(g, Builder::new)
    }

    /// Feature `view` copied out of its layer, z included.
    #[must_use]
    pub fn from_view(view: GeometryView<'_>) -> Self {
        Self::build_view(&view, Builder::new).expect("a validated view is a feature geometry")
    }

    /// [`Self::from_view`] with every vector charged to `dec`'s budget.
    pub(crate) fn from_view_budgeted(view: GeometryView<'_>, dec: &mut Decoder) -> MltResult<Self> {
        let (vertices, parts, polygons) = Self::counts(&view);
        let stride = view.dim().size();
        Self::build_view(&view, |kind, dim| {
            // Charge the budget, then allocate only what does not fit inline.
            dec.consume_items::<i32>(vertices * stride)?;
            dec.consume_items::<u32>(parts + polygons)?;
            Ok(Builder {
                kind,
                dim,
                coords: SmallVec::with_capacity(vertices * stride),
                part_ends: Ends::with_capacity(parts),
                polygon_ends: Ends::with_capacity(polygons),
            })
        })
    }

    /// How many vertices, parts and polygons `g` holds, counting ring closing vertices.
    fn counts(g: &impl GeometryTrait<T = i32>) -> (usize, usize, usize) {
        fn polygon(p: &impl PolygonTrait<T = i32>) -> (usize, usize) {
            let exterior = p.exterior().map_or(0, |e| e.num_coords());
            let interiors: usize = p.interiors().map(|r| r.num_coords()).sum();
            (
                exterior + interiors,
                p.num_interiors() + usize::from(exterior > 0),
            )
        }
        match g.as_type() {
            GeoKind::Point(_) => (1, 0, 0),
            GeoKind::LineString(l) => (l.num_coords(), 0, 0),
            GeoKind::Polygon(p) => {
                let (v, r) = polygon(p);
                (v, r, 0)
            }
            GeoKind::MultiPoint(mp) => (mp.num_points(), 0, 0),
            GeoKind::MultiLineString(mls) => (
                mls.line_strings().map(|l| l.num_coords()).sum(),
                mls.num_line_strings(),
                0,
            ),
            GeoKind::MultiPolygon(mp) => {
                let mut vertices = 0;
                let mut rings = 0;
                for p in mp.polygons() {
                    let (v, r) = polygon(&p);
                    vertices += v;
                    rings += r;
                }
                (vertices, rings, mp.num_polygons())
            }
            GeoKind::Rect(_) => (4, 1, 0),
            GeoKind::Triangle(_) => (3, 1, 0),
            GeoKind::Line(_) => (2, 0, 0),
            GeoKind::GeometryCollection(_) => (0, 0, 0),
        }
    }

    fn build(
        g: &impl GeometryTrait<T = i32>,
        builder: impl FnOnce(GeometryType, Dimensions) -> MltResult<Builder>,
    ) -> MltResult<Self> {
        let dim = g.dim();
        check_dim(dim)?;
        let vertex = Read {
            xyz: dim == Dimensions::Xyz,
        };
        let (vertices, parts, polygons) = Self::counts(g);
        let mut b = match g.as_type() {
            GeoKind::Point(_) => builder(GeometryType::Point, dim)?,
            GeoKind::LineString(_) | GeoKind::Line(_) => builder(GeometryType::LineString, dim)?,
            GeoKind::Polygon(_) | GeoKind::Rect(_) | GeoKind::Triangle(_) => {
                builder(GeometryType::Polygon, dim)?
            }
            GeoKind::MultiPoint(_) => builder(GeometryType::MultiPoint, dim)?,
            GeoKind::MultiLineString(_) => builder(GeometryType::MultiLineString, dim)?,
            GeoKind::MultiPolygon(_) => builder(GeometryType::MultiPolygon, dim)?,
            GeoKind::GeometryCollection(_) => return Err(GeometryCollectionUnsupported),
        };
        b.reserve(vertices, parts, polygons);
        match g.as_type() {
            GeoKind::Point(p) => {
                let c = p.coord().ok_or(EmptyPoint)?;
                b.vertex(vertex.of(&c))?;
            }
            GeoKind::LineString(l) => b.run(vertex.line(l))?,
            GeoKind::Line(l) => b.run([vertex.of(&l.start()), vertex.of(&l.end())])?,
            GeoKind::Polygon(p) => polygon_into(&mut b, p, vertex)?,
            GeoKind::Rect(r) => {
                if dim != Dimensions::Xy {
                    return Err(GeometryDimensionUnsupported(dim));
                }
                let (min, max) = (r.min(), r.max());
                let corner = |x, y| Vertex { x, y, z: None };
                b.ring([
                    corner(max.x(), min.y()),
                    corner(max.x(), max.y()),
                    corner(min.x(), max.y()),
                    corner(min.x(), min.y()),
                ])?;
            }
            GeoKind::Triangle(t) => {
                b.ring([
                    vertex.of(&t.first()),
                    vertex.of(&t.second()),
                    vertex.of(&t.third()),
                ])?;
            }
            GeoKind::MultiPoint(mp) => {
                b.run(mp.points().filter_map(|p| p.coord().map(|c| vertex.of(&c))))?;
            }
            GeoKind::MultiLineString(mls) => {
                for l in mls.line_strings() {
                    b.run(vertex.line(&l))?;
                    b.end_part()?;
                }
            }
            GeoKind::MultiPolygon(mp) => {
                for p in mp.polygons() {
                    polygon_into(&mut b, &p, vertex)?;
                    b.end_polygon()?;
                }
            }
            GeoKind::GeometryCollection(_) => return Err(GeometryCollectionUnsupported),
        }
        Ok(b.finish())
    }

    /// [`Self::build`] for a decoded view, copying each contiguous run of stored vertices
    /// whole instead of vertex by vertex. Stores exactly what [`Self::build`] would.
    fn build_view(
        view: &GeometryView<'_>,
        builder: impl FnOnce(GeometryType, Dimensions) -> MltResult<Builder>,
    ) -> MltResult<Self> {
        let dim = view.dim();
        let read = Read {
            xyz: dim == Dimensions::Xyz,
        };
        let (vertices, parts, polygons) = Self::counts(view);
        // The shape the view reads, which for a triangles-only polygon is a multi-polygon
        // of its triangles rather than the type the layer records.
        let kind = match view.as_type() {
            GeoKind::Point(_) => GeometryType::Point,
            GeoKind::LineString(_) => GeometryType::LineString,
            GeoKind::Polygon(_) => GeometryType::Polygon,
            GeoKind::MultiPoint(_) => GeometryType::MultiPoint,
            GeoKind::MultiLineString(_) => GeometryType::MultiLineString,
            GeoKind::MultiPolygon(_) => GeometryType::MultiPolygon,
            GeoKind::Line(_)
            | GeoKind::Rect(_)
            | GeoKind::Triangle(_)
            | GeoKind::GeometryCollection(_) => unreachable!("a view is one of the six MLT kinds"),
        };
        let mut b = builder(kind, dim)?;
        b.reserve(vertices, parts, polygons);
        match view.as_type() {
            GeoKind::Point(p) => {
                let c = p.coord().ok_or(EmptyPoint)?;
                b.vertex(read.of(&c))?;
            }
            GeoKind::LineString(l) => b.run_view(l, read)?,
            GeoKind::Polygon(p) => b.polygon_view(p, read)?,
            GeoKind::MultiPoint(mp) => {
                b.run(mp.points().filter_map(|p| p.coord().map(|c| read.of(&c))))?;
            }
            GeoKind::MultiLineString(mls) => {
                for l in mls.line_strings() {
                    b.run_view(&l, read)?;
                    b.end_part()?;
                }
            }
            GeoKind::MultiPolygon(mp) => {
                for p in mp.polygons() {
                    b.polygon_view(&p, read)?;
                    b.end_polygon()?;
                }
            }
            GeoKind::Line(_)
            | GeoKind::Rect(_)
            | GeoKind::Triangle(_)
            | GeoKind::GeometryCollection(_) => unreachable!("a view is one of the six MLT kinds"),
        }
        Ok(b.finish())
    }

    /// The geometry with one z per stored vertex, which must have had none.
    pub fn with_z(mut self, z: impl IntoIterator<Item = i32>) -> MltResult<Self> {
        if self.dim == Dimensions::Xyz {
            return Err(ZAlreadySet);
        }
        let expected = self.vertex_count();
        let mut z = z.into_iter();
        let mut coords = SmallVec::new();
        coords.reserve_exact(expected * 3);
        for (count, xy) in self.coords.as_chunks::<2>().0.iter().enumerate() {
            let Some(z) = z.next() else {
                return Err(ZVertexCountMismatch {
                    expected,
                    actual: count,
                });
            };
            coords.extend([xy[0], xy[1], z]);
        }
        let extra = z.count();
        if extra > 0 {
            return Err(ZVertexCountMismatch {
                expected,
                actual: expected + extra,
            });
        }
        if expected > 0 {
            self.coords = coords;
            self.dim = Dimensions::Xyz;
        }
        Ok(self)
    }

    /// The geometry's type in MLT's terms.
    #[must_use]
    pub fn geometry_type(&self) -> GeometryType {
        self.kind
    }

    /// `Xyz` when every vertex has a z, else `Xy`; an empty geometry is `Xy`.
    #[must_use]
    pub fn dim(&self) -> Dimensions {
        self.dim
    }

    fn stride(&self) -> usize {
        self.dim.size()
    }

    /// How many vertices the geometry stores: what an m-value holds one value per, and what
    /// the layer's vertex sequence counts. A ring's closing vertex is not among them.
    #[must_use]
    pub fn vertex_count(&self) -> usize {
        self.coords.len() / self.stride()
    }

    /// The stored vertices, in storage order.
    pub fn vertices(&self) -> impl ExactSizeIterator<Item = Vertex> + DoubleEndedIterator + '_ {
        self.coords.chunks_exact(self.stride()).map(|w| Vertex {
            x: w[0],
            y: w[1],
            z: w.get(2).copied(),
        })
    }

    /// The first stored vertex, which spatial sorts order features by.
    #[must_use]
    pub fn first_vertex(&self) -> Option<Vertex> {
        self.vertices().next()
    }

    /// Every vertex's z in storage order, or `None` for a flat geometry.
    #[must_use]
    pub fn z(&self) -> Option<impl ExactSizeIterator<Item = i32> + '_> {
        (self.dim == Dimensions::Xyz).then(|| self.coords.as_chunks::<3>().0.iter().map(|w| w[2]))
    }

    /// The interleaved coordinate words, `x y [z]` per stored vertex.
    ///
    /// Named apart from [`LineStringTrait::coords`], which an inherent method would shadow.
    #[must_use]
    pub fn words(&self) -> &[i32] {
        &self.coords
    }

    /// Cumulative stored vertices at the end of each part, see the type's fields.
    #[must_use]
    pub fn part_ends(&self) -> &[u32] {
        &self.part_ends
    }

    /// Cumulative parts at the end of each polygon of a multi-polygon.
    #[must_use]
    pub fn polygon_ends(&self) -> &[u32] {
        &self.polygon_ends
    }

    fn vertex_at(&self, i: usize) -> Vertex {
        let w = &self.coords[i * self.stride()..];
        Vertex {
            x: w[0],
            y: w[1],
            z: (self.stride() == 3).then(|| w[2]),
        }
    }

    /// Part `i`'s stored vertex range.
    fn part_range(&self, i: usize) -> (usize, usize) {
        let start = if i == 0 {
            0
        } else {
            self.part_ends[i - 1].into_usize()
        };
        (start, self.part_ends[i].into_usize())
    }

    /// The whole geometry as one line, for a line string.
    pub(crate) fn line_ref(&self) -> LineRef<'_> {
        LineRef {
            words: &self.coords,
            stride: self.stride(),
            ring: false,
        }
    }

    /// The lines of a multi-line-string.
    pub(crate) fn line_refs(&self) -> impl ExactSizeIterator<Item = LineRef<'_>> + Clone {
        (0..self.part_ends.len()).map(move |i| self.part(i, false))
    }

    /// Polygon `j` of a polygon kind, see [`Self::polygons`].
    pub(crate) fn polygon_at(&self, j: usize) -> PolygonRef<'_> {
        self.polygon_ref(j)
    }

    /// The polygons of a polygon kind: one for a polygon, each for a multi-polygon.
    /// Named apart from [`MultiPolygonTrait::polygons`], which an inherent method would shadow.
    pub(crate) fn polygon_refs(&self) -> impl ExactSizeIterator<Item = PolygonRef<'_>> + Clone {
        (0..self.polygon_count()).map(move |j| self.polygon_ref(j))
    }

    fn part(&self, i: usize, ring: bool) -> LineRef<'_> {
        let (start, end) = self.part_range(i);
        let stride = self.stride();
        LineRef {
            words: &self.coords[start * stride..end * stride],
            stride,
            ring,
        }
    }

    /// How many polygons the geometry holds as a polygon kind.
    fn polygon_count(&self) -> usize {
        match self.kind {
            GeometryType::Polygon => 1,
            GeometryType::MultiPolygon => self.polygon_ends.len(),
            GeometryType::Point
            | GeometryType::LineString
            | GeometryType::MultiPoint
            | GeometryType::MultiLineString => 0,
        }
    }

    /// Polygon `j` of a polygon kind.
    fn polygon_ref(&self, j: usize) -> PolygonRef<'_> {
        let (first_ring, end_ring) = match self.kind {
            GeometryType::Polygon => (0, self.part_ends.len()),
            GeometryType::MultiPolygon => {
                let first = if j == 0 {
                    0
                } else {
                    self.polygon_ends[j - 1].into_usize()
                };
                (first, self.polygon_ends[j].into_usize())
            }
            GeometryType::Point
            | GeometryType::LineString
            | GeometryType::MultiPoint
            | GeometryType::MultiLineString => (0, 0),
        };
        let base = if first_ring == 0 {
            0
        } else {
            self.part_ends[first_ring - 1].into_usize()
        };
        PolygonRef {
            words: &self.coords,
            stride: self.stride(),
            ends: &self.part_ends[first_ring..end_ring],
            base,
        }
    }

    /// Every ring with the polygon it belongs to, as `(exterior, LineRef)`.
    fn rings(&self) -> impl Iterator<Item = (bool, LineRef<'_>)> + '_ {
        (0..self.polygon_count()).flat_map(move |j| {
            let polygon = self.polygon_ref(j);
            (0..polygon.ring_count()).map(move |i| (i == 0, polygon.ring(i)))
        })
    }

    /// The geometry with its polygon rings wound as the encoder stores them, counter-clockwise
    /// outside and clockwise inside, each reversed ring keeping its first vertex. z follows.
    #[must_use]
    pub fn wound(&self) -> Cow<'_, Self> {
        let reversal_needed = self
            .rings()
            .any(|(exterior, ring)| winds_against(ring.xy(), exterior));
        if !reversal_needed {
            return Cow::Borrowed(self);
        }
        let mut wound = self.clone();
        let stride = self.stride();
        let mut ring_index = 0;
        for j in 0..self.polygon_count() {
            let polygon = self.polygon_ref(j);
            for i in 0..polygon.ring_count() {
                let ring = polygon.ring(i);
                if winds_against(ring.xy(), i == 0) {
                    let (start, end) = self.part_range(ring_index);
                    reverse_after_first(&mut wound.coords[start * stride..end * stride], stride);
                }
                ring_index += 1;
            }
        }
        Cow::Owned(wound)
    }

    /// Where each stored vertex ends up once the polygon rings are wound, see [`Self::wound`].
    ///
    /// Entry `i` is the input position of the vertex stored at `i`, so a value held per vertex
    /// follows by reading its run through the entries. `None` when no ring is reversed.
    #[must_use]
    pub fn wound_vertex_order(&self) -> Option<Vec<usize>> {
        let mut order = Vec::with_capacity(self.vertex_count());
        let mut reversed = false;
        let mut ring_index = 0;
        for j in 0..self.polygon_count() {
            let polygon = self.polygon_ref(j);
            for i in 0..polygon.ring_count() {
                let (start, end) = self.part_range(ring_index);
                if winds_against(polygon.ring(i).xy(), i == 0) {
                    reversed = true;
                    // Reversing the ring leaves its first vertex where it was.
                    order.extend((start..end.min(start + 1)).chain((start + 1..end).rev()));
                } else {
                    order.extend(start..end);
                }
                ring_index += 1;
            }
        }
        reversed.then_some(order)
    }
}

/// Reverse the vertices of `words` but the first one, in place.
fn reverse_after_first(words: &mut [i32], stride: usize) {
    let n = words.len() / stride;
    if n < 3 {
        return;
    }
    let rest = &mut words[stride..];
    let m = n - 1;
    for i in 0..m / 2 {
        for k in 0..stride {
            rest.swap(i * stride + k, (m - 1 - i) * stride + k);
        }
    }
}

fn polygon_into(b: &mut Builder, p: &impl PolygonTrait<T = i32>, vertex: Read) -> MltResult<()> {
    if let Some(exterior) = p.exterior() {
        b.ring(vertex.line(&exterior))?;
    }
    for interior in p.interiors() {
        b.ring(vertex.line(&interior))?;
    }
    Ok(())
}

/// Reads coordinates of a geometry whose dimension is known, monomorphised per source type
/// so the per-vertex calls inline.
#[derive(Clone, Copy)]
struct Read {
    xyz: bool,
}

impl Read {
    #[inline]
    fn of(self, c: &impl CoordTrait<T = i32>) -> Vertex {
        Vertex {
            x: c.x(),
            y: c.y(),
            z: self.xyz.then(|| c.nth_or_panic(2)),
        }
    }

    fn line(self, l: &impl LineStringTrait<T = i32>) -> impl Iterator<Item = Vertex> {
        l.coords().map(move |c| self.of(&c))
    }
}

// ───────────────────────────── borrowed parts ─────────────────────────────

/// One point of a multi-point.
#[derive(Clone, Copy, Debug)]
pub struct PointRef(Vertex);

/// A line string, or a ring, of a [`FeatureGeometry`]. A ring is closed on read.
#[derive(Clone, Copy, Debug)]
pub struct LineRef<'a> {
    words: &'a [i32],
    stride: usize,
    ring: bool,
}

impl LineRef<'_> {
    /// How many vertices the part stores, closing vertex excluded.
    #[must_use]
    pub fn vertex_count(&self) -> usize {
        self.words.len() / self.stride
    }

    /// Whether this is a polygon ring, which the view closes.
    #[must_use]
    pub fn is_ring(&self) -> bool {
        self.ring
    }

    /// The stored vertices, in storage order, closing vertex excluded.
    pub fn vertices(&self) -> impl ExactSizeIterator<Item = Vertex> + '_ {
        self.words.chunks_exact(self.stride).map(|w| Vertex {
            x: w[0],
            y: w[1],
            z: w.get(2).copied(),
        })
    }

    pub(crate) fn vertex(&self, i: usize) -> Vertex {
        let w = &self.words[i * self.stride..];
        Vertex {
            x: w[0],
            y: w[1],
            z: (self.stride == 3).then(|| w[2]),
        }
    }

    fn xy(&self) -> impl Iterator<Item = (i32, i32)> + Clone + '_ {
        self.words.chunks_exact(self.stride).map(|w| (w[0], w[1]))
    }

    fn dim(&self) -> Dimensions {
        if self.stride == 3 {
            Dimensions::Xyz
        } else {
            Dimensions::Xy
        }
    }
}

/// One polygon of a multi-polygon, or the polygon itself, as its rings.
#[derive(Clone, Copy, Debug)]
pub struct PolygonRef<'a> {
    /// Every word of the geometry.
    words: &'a [i32],
    stride: usize,
    /// The rings' cumulative vertex ends, counted from the geometry's first vertex.
    ends: &'a [u32],
    /// The first ring's first vertex.
    base: usize,
}

impl<'a> PolygonRef<'a> {
    fn ring_count(&self) -> usize {
        self.ends.len()
    }

    /// The rings as the wire stores them: a polygon with none stores one empty ring,
    /// which is what `POLYGON EMPTY` always encoded as.
    pub(crate) fn stored_rings(self) -> impl Iterator<Item = LineRef<'a>> + Clone {
        let n = self.ring_count();
        (0..n.max(1)).map(move |i| {
            if n == 0 {
                LineRef {
                    words: &[],
                    stride: self.stride,
                    ring: true,
                }
            } else {
                self.ring(i)
            }
        })
    }

    fn ring(&self, i: usize) -> LineRef<'a> {
        let start = if i == 0 {
            self.base
        } else {
            self.ends[i - 1].into_usize()
        };
        let end = self.ends[i].into_usize();
        LineRef {
            words: &self.words[start * self.stride..end * self.stride],
            stride: self.stride,
            ring: true,
        }
    }

    fn dim(&self) -> Dimensions {
        if self.stride == 3 {
            Dimensions::Xyz
        } else {
            Dimensions::Xy
        }
    }
}

const UNCHECKED: &str =
    "geo-traits declares the accessor unsafe; this body indexes with bounds checks";

/// The [`GeometryTrait`] slots of the borrowed parts, which never hold a multi.
macro_rules! part_slots {
    () => {
        type T = i32;
        type PointType<'b>
            = PointRef
        where
            Self: 'b;
        type LineStringType<'b>
            = LineRef<'b>
        where
            Self: 'b;
        type PolygonType<'b>
            = PolygonRef<'b>
        where
            Self: 'b;
        type MultiPointType<'b>
            = UnimplementedMultiPoint<i32>
        where
            Self: 'b;
        type MultiLineStringType<'b>
            = UnimplementedMultiLineString<i32>
        where
            Self: 'b;
        type MultiPolygonType<'b>
            = UnimplementedMultiPolygon<i32>
        where
            Self: 'b;
        type GeometryCollectionType<'b>
            = UnimplementedGeometryCollection<i32>
        where
            Self: 'b;
        type RectType<'b>
            = UnimplementedRect<i32>
        where
            Self: 'b;
        type TriangleType<'b>
            = UnimplementedTriangle<i32>
        where
            Self: 'b;
        type LineType<'b>
            = UnimplementedLine<i32>
        where
            Self: 'b;
    };
}

type PartKind<'s> = GeoKind<
    's,
    PointRef,
    LineRef<'s>,
    PolygonRef<'s>,
    UnimplementedMultiPoint<i32>,
    UnimplementedMultiLineString<i32>,
    UnimplementedMultiPolygon<i32>,
    UnimplementedGeometryCollection<i32>,
    UnimplementedRect<i32>,
    UnimplementedTriangle<i32>,
    UnimplementedLine<i32>,
>;

impl GeometryTrait for PointRef {
    part_slots!();

    fn dim(&self) -> Dimensions {
        self.0.dim()
    }

    fn as_type(&self) -> PartKind<'_> {
        GeoKind::Point(self)
    }
}

impl PointTrait for PointRef {
    type CoordType<'b>
        = Vertex
    where
        Self: 'b;

    fn coord(&self) -> Option<Vertex> {
        Some(self.0)
    }
}

impl GeometryTrait for LineRef<'_> {
    part_slots!();

    fn dim(&self) -> Dimensions {
        LineRef::dim(self)
    }

    fn as_type(&self) -> PartKind<'_> {
        GeoKind::LineString(self)
    }
}

impl LineStringTrait for LineRef<'_> {
    type CoordType<'b>
        = Vertex
    where
        Self: 'b;

    fn num_coords(&self) -> usize {
        let stored = self.vertex_count();
        if self.ring && stored > 0 {
            stored + 1
        } else {
            stored
        }
    }

    #[expect(unsafe_code, reason = "see UNCHECKED")]
    unsafe fn coord_unchecked(&self, i: usize) -> Vertex {
        let _ = UNCHECKED;
        let i = if i == self.vertex_count() { 0 } else { i };
        self.vertex(i)
    }
}

impl GeometryTrait for PolygonRef<'_> {
    part_slots!();

    fn dim(&self) -> Dimensions {
        PolygonRef::dim(self)
    }

    fn as_type(&self) -> PartKind<'_> {
        GeoKind::Polygon(self)
    }
}

impl PolygonTrait for PolygonRef<'_> {
    type RingType<'b>
        = LineRef<'b>
    where
        Self: 'b;

    fn exterior(&self) -> Option<LineRef<'_>> {
        (self.ring_count() > 0).then(|| self.ring(0))
    }

    fn num_interiors(&self) -> usize {
        self.ring_count().saturating_sub(1)
    }

    #[expect(unsafe_code, reason = "see UNCHECKED")]
    unsafe fn interior_unchecked(&self, i: usize) -> LineRef<'_> {
        self.ring(i + 1)
    }
}

// ───────────────────────────── the geometry as every shape ─────────────────────────────
//
// `as_type` names the one shape the geometry is; the other shape traits are implemented
// on the same type to fill the trait's slots and answer "empty" for a geometry of another kind.

impl GeometryTrait for FeatureGeometry {
    type T = i32;
    type PointType<'b>
        = Self
    where
        Self: 'b;
    type LineStringType<'b>
        = Self
    where
        Self: 'b;
    type PolygonType<'b>
        = Self
    where
        Self: 'b;
    type MultiPointType<'b>
        = Self
    where
        Self: 'b;
    type MultiLineStringType<'b>
        = Self
    where
        Self: 'b;
    type MultiPolygonType<'b>
        = Self
    where
        Self: 'b;
    type GeometryCollectionType<'b>
        = UnimplementedGeometryCollection<i32>
    where
        Self: 'b;
    type RectType<'b>
        = UnimplementedRect<i32>
    where
        Self: 'b;
    type TriangleType<'b>
        = UnimplementedTriangle<i32>
    where
        Self: 'b;
    type LineType<'b>
        = UnimplementedLine<i32>
    where
        Self: 'b;

    fn dim(&self) -> Dimensions {
        self.dim
    }

    fn as_type(
        &self,
    ) -> GeoKind<
        '_,
        Self,
        Self,
        Self,
        Self,
        Self,
        Self,
        UnimplementedGeometryCollection<i32>,
        UnimplementedRect<i32>,
        UnimplementedTriangle<i32>,
        UnimplementedLine<i32>,
    > {
        match self.kind {
            GeometryType::Point => GeoKind::Point(self),
            GeometryType::LineString => GeoKind::LineString(self),
            GeometryType::Polygon => GeoKind::Polygon(self),
            GeometryType::MultiPoint => GeoKind::MultiPoint(self),
            GeometryType::MultiLineString => GeoKind::MultiLineString(self),
            GeometryType::MultiPolygon => GeoKind::MultiPolygon(self),
        }
    }
}

impl PointTrait for FeatureGeometry {
    type CoordType<'b>
        = Vertex
    where
        Self: 'b;

    fn coord(&self) -> Option<Vertex> {
        (self.kind == GeometryType::Point && self.vertex_count() > 0).then(|| self.vertex_at(0))
    }
}

impl LineStringTrait for FeatureGeometry {
    type CoordType<'b>
        = Vertex
    where
        Self: 'b;

    fn num_coords(&self) -> usize {
        if self.kind == GeometryType::LineString {
            self.vertex_count()
        } else {
            0
        }
    }

    #[expect(unsafe_code, reason = "see UNCHECKED")]
    unsafe fn coord_unchecked(&self, i: usize) -> Vertex {
        self.vertex_at(i)
    }
}

impl PolygonTrait for FeatureGeometry {
    type RingType<'b>
        = LineRef<'b>
    where
        Self: 'b;

    fn exterior(&self) -> Option<LineRef<'_>> {
        (self.kind == GeometryType::Polygon && !self.part_ends.is_empty())
            .then(|| self.part(0, true))
    }

    fn num_interiors(&self) -> usize {
        if self.kind == GeometryType::Polygon {
            self.part_ends.len().saturating_sub(1)
        } else {
            0
        }
    }

    #[expect(unsafe_code, reason = "see UNCHECKED")]
    unsafe fn interior_unchecked(&self, i: usize) -> LineRef<'_> {
        self.part(i + 1, true)
    }
}

impl MultiPointTrait for FeatureGeometry {
    type InnerPointType<'b>
        = PointRef
    where
        Self: 'b;

    fn num_points(&self) -> usize {
        if self.kind == GeometryType::MultiPoint {
            self.vertex_count()
        } else {
            0
        }
    }

    #[expect(unsafe_code, reason = "see UNCHECKED")]
    unsafe fn point_unchecked(&self, i: usize) -> PointRef {
        PointRef(self.vertex_at(i))
    }
}

impl MultiLineStringTrait for FeatureGeometry {
    type InnerLineStringType<'b>
        = LineRef<'b>
    where
        Self: 'b;

    fn num_line_strings(&self) -> usize {
        if self.kind == GeometryType::MultiLineString {
            self.part_ends.len()
        } else {
            0
        }
    }

    #[expect(unsafe_code, reason = "see UNCHECKED")]
    unsafe fn line_string_unchecked(&self, i: usize) -> LineRef<'_> {
        self.part(i, false)
    }
}

impl MultiPolygonTrait for FeatureGeometry {
    type InnerPolygonType<'b>
        = PolygonRef<'b>
    where
        Self: 'b;

    fn num_polygons(&self) -> usize {
        if self.kind == GeometryType::MultiPolygon {
            self.polygon_ends.len()
        } else {
            0
        }
    }

    #[expect(unsafe_code, reason = "see UNCHECKED")]
    unsafe fn polygon_unchecked(&self, j: usize) -> PolygonRef<'_> {
        self.polygon_ref(j)
    }
}

/// WKT in the form `geo_types` prints its geometries, so a snapshot of a flat feature reads
/// the same as before; a 3D geometry carries a `Z` tag and a third ordinate. Rings are
/// written closed, as the [`geo_traits`] impls read them.
impl std::fmt::Debug for FeatureGeometry {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let tag = match self.kind {
            GeometryType::Point => "POINT",
            GeometryType::LineString => "LINESTRING",
            GeometryType::Polygon => "POLYGON",
            GeometryType::MultiPoint => "MULTIPOINT",
            GeometryType::MultiLineString => "MULTILINESTRING",
            GeometryType::MultiPolygon => "MULTIPOLYGON",
        };
        f.write_str(tag)?;
        if self.dim == Dimensions::Xyz {
            f.write_str(" Z")?;
        }
        match self.kind {
            GeometryType::Point => wkt_coords(f, self.vertices()),
            GeometryType::LineString | GeometryType::MultiPoint => {
                if self.coords.is_empty() {
                    f.write_str(" ")?;
                }
                wkt_coords(f, self.vertices())
            }
            GeometryType::Polygon => {
                if PolygonTrait::exterior(self).is_none() {
                    f.write_str(" ")?;
                }
                wkt_polygon(f, self)
            }
            GeometryType::MultiLineString => {
                let mut lines = MultiLineStringTrait::line_strings(self);
                let Some(first) = lines.next() else {
                    return f.write_str(" EMPTY");
                };
                f.write_str("(")?;
                wkt_coords(f, first.coords())?;
                for line in lines {
                    f.write_str(",")?;
                    wkt_coords(f, line.coords())?;
                }
                f.write_str(")")
            }
            GeometryType::MultiPolygon => {
                let mut polygons = MultiPolygonTrait::polygons(self);
                let Some(first) = polygons.next() else {
                    return f.write_str(" EMPTY");
                };
                f.write_str("(")?;
                wkt_polygon(f, &first)?;
                for polygon in polygons {
                    f.write_str(",")?;
                    wkt_polygon(f, &polygon)?;
                }
                f.write_str(")")
            }
        }
    }
}

/// `(x y[ z],…)`, or `EMPTY` for no coordinates.
fn wkt_coords(
    f: &mut std::fmt::Formatter<'_>,
    coords: impl Iterator<Item = impl CoordTrait<T = i32>>,
) -> std::fmt::Result {
    let mut sep = "(";
    for c in coords {
        write!(f, "{sep}{} {}", c.x(), c.y())?;
        if let Some(z) = c.nth(2) {
            write!(f, " {z}")?;
        }
        sep = ",";
    }
    f.write_str(if sep == "(" { "EMPTY" } else { ")" })
}

/// `(exterior,hole,…)`, or `EMPTY` for a polygon with no rings.
fn wkt_polygon(
    f: &mut std::fmt::Formatter<'_>,
    polygon: &impl PolygonTrait<T = i32>,
) -> std::fmt::Result {
    let Some(exterior) = polygon.exterior() else {
        return f.write_str("EMPTY");
    };
    f.write_str("(")?;
    wkt_coords(f, exterior.coords())?;
    for hole in polygon.interiors() {
        f.write_str(",")?;
        wkt_coords(f, hole.coords())?;
    }
    f.write_str(")")
}
