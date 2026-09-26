/**
 * Client-side shell-roof geometry — port of blender_pipeline_dev/roof/shell.
 *
 * Produces THREE.BufferGeometry for a RoofSegmentNode, plus the matching
 * analytic roof HEIGHT at any point (used to trim walls to the roof and to
 * hide windows the roof covers — see roof-scene.ts and
 * roof-wall-clip-system.tsx). Geometry and height are derived from one shared
 * ShellShape so they cannot disagree.
 *
 * Model (agreed with the operator 2026-09-25):
 *   - Segment local frame: y = 0 at the storey wall top; the roof group is
 *     lifted there by RoofRenderer. wallHeight is a PARAPET on top of that.
 *   - The ridge is CENTRED across the span and PINNED at baseZ + roofHeight.
 *     Each sloped edge drops from it at its OWN pitch over the half-span,
 *         eave_i = ridgeZ - tan_i * halfSpan
 *     so changing one pitch moves only that eave.
 *   - Gable ends are vertical walls with the roof overhanging them (rake);
 *     hip ends slope; JUNCTION ends are open — they sit inside a neighbouring
 *     roof (L/T wings, or two masses continuing one ridge) and get no end
 *     face, no overhang and no boards.
 *   - Real walls standing on an edge line ARE the parapet / gable: the shell
 *     only draws wall infill above their tops.
 *   - Dormers are gable/shed/hip prisms that start below the slope and run
 *     into it, CSG-unioned so the slope cuts them. A dormer can FOLLOW a
 *     window: its front then sits on that window's wall.
 *
 * Not handled here: non-rectangular polygons, gambrel/dutch/mansard (the
 * backend refuses those too) — callers fall back to roof-system's legacy path.
 */
import * as THREE from 'three'
import { ADDITION, Brush, Evaluator, SUBTRACTION } from 'three-bvh-csg'
import type { RoofSegmentNode } from '../../schema'

// ─── Constants ────────────────────────────────────────────────────
const MIN_EDGE_WEIGHT = 0.01 // shell/skeleton/constants.py
const NEAR_VERTICAL_TAN = 100.0 // "vertical" gable edge

/** Fascia board depth — backend DEFAULT_FASCIA_THICKNESS_M (shell.py). */
const FASCIA_M = 0.18
/** Roof build-up: the down-facing underside sits this far below the slates. */
const ROOF_UNDERSIDE_M = 0.08
/** Dormer roof trim: slab thickness, side-eave and front overhangs, and how
 *  far the slab's top sits above the dormer body's own roof planes (so the
 *  union never meets coplanar faces). */
const DORMER_ROOF_T = 0.12
const DORMER_EAVE_OH = 0.1
const DORMER_FRONT_OH = 0.15
const DORMER_ROOF_LIFT = 0.03
/** How far past its footprint a roof still counts as covering a point, so
 *  walls standing ON the roof edge line are trimmed. Half a wall + margin. */
const COVER_BUFFER = 0.15

// three-bvh-csg needs materials to union brushes; dummies here, and
// roof-system's material mapper picks real ones by slot.
const dummyMats: THREE.Material[] = [
  new THREE.MeshBasicMaterial(),
  new THREE.MeshBasicMaterial(),
  new THREE.MeshBasicMaterial(),
  new THREE.MeshBasicMaterial(),
  new THREE.MeshBasicMaterial(),
]

const _csg = new Evaluator()
_csg.useGroups = true
_csg.attributes = ['position', 'normal']
// consolidateGroups OFF, with the material remap done by _remapToSlots.
// three-bvh-csg 0.0.18 sizes GeometryBuilder.groupIndices lazily (up to the
// highest group that received a triangle) but consolidation SORTS groups by
// material first, so a wholly-culled group can land at a loop index that was
// never allocated -> "Cannot destructure property 'count' of
// 'groupIndices[index]'". Reproduced on the operator's roof (fixed 5f4fd47).
// Present at runtime but missing from 0.0.18's .d.ts.
;(_csg as unknown as { consolidateGroups: boolean }).consolidateGroups = false

/** Map every group back onto the fixed 4-slot layout by material identity. */
function _remapToSlots(brush: Brush): void {
  const mats = (Array.isArray(brush.material) ? brush.material : [brush.material]) as THREE.Material[]
  for (const g of brush.geometry.groups) {
    const slot = dummyMats.indexOf(mats[g.materialIndex ?? 0] as THREE.MeshBasicMaterial)
    g.materialIndex = slot >= 0 ? slot : 0
  }
  brush.material = dummyMats
}

// Material slots — line up with roof-system.tsx's 4-slot layout.
const SLOT_WALL_EXTERIOR = 0
const SLOT_SLATE_TOP = 1
const SLOT_SOFFIT = 2
const SLOT_FASCIA = 3
/** Dormer window glass. The render pipeline puts these faces in a glass
 *  object (roof/mesh.py); the preview gives them a glass material. */
export const SLOT_GLASS = 4

// ─── Public types ─────────────────────────────────────────────────

/** hip: slopes to an eave. gable: vertical wall, roof overhangs it (rake).
 *  junction: open, lives inside a neighbouring roof. abut: vertical closing
 *  wall with NO overhang, a step where two roofs of different profile meet. */
type EdgeStyle = 'hip' | 'gable' | 'junction' | 'abut'

/** A real wall standing along part of an edge (resolved by roof-scene). */
export type RealWallSpan = {
  edge: number
  /** Fractions along the edge (0 = its start corner). */
  t0: number
  t1: number
  /** Top of the wall in segment-local Y. */
  top: number
  /** How far inside the edge line the wall stands, metres. */
  inset: number
}
type V3 = [number, number, number]
type V2 = [number, number]

/** Where a dormer must sit when it follows a window (resolved by roof-scene). */
export type DormerOverride = {
  /** Polygon edge the dormer's front faces. Must be a sloped (side) edge. */
  edgeIdx: number
  /** Fraction along that edge (0 = its start corner) of the dormer's centre. */
  uMid: number
  /** Distance in from the edge line to the dormer's FRONT face, metres. */
  inward: number
  cheekWidth: number
  ridgeHeight: number
  /** The dormer's window (defaults from the followed window). */
  win?: { w?: number; h?: number; sill?: number }
}

export type ShellBuildOptions = {
  /** Move an end along the ridge axis to this local coordinate — shortening
   *  (an L wing cut back to where its ridge meets the main roof) or
   *  EXTENDING (a small wing lengthened until its ridge runs into the main
   *  slope). That end becomes a JUNCTION (open, no overhang). */
  truncateLo?: number
  truncateHi?: number
  /** Style for an end: 'junction' (open) or 'abut' (closed step wall, no
   *  overhang). A moved end defaults to 'junction'. */
  endLo?: 'junction' | 'abut'
  endHi?: 'junction' | 'abut'
  /** Ridge rise above baseZ that replaces roofHeight (level-matched ridges).
   *  The default pitch is re-derived from it, so eaves stay put. */
  ridgeRiseOverride?: number
  /** One pitch for every sloped edge (pitch-matched / dropped ridges). */
  uniformTanOverride?: number
  /** Real walls standing along the edges. Generated infill is drawn only
   *  where they aren't (and above their tops where they are). */
  realWalls?: RealWallSpan[]
  /** Omit the flat interior ceiling. Set when walls stand under this roof
   *  on the level above: the cap would slice straight through that floor. */
  noInteriorCap?: boolean
  /** No overhang on that side's eave: it stops dead on its line (a wing
   *  pulled back to a main roof's gable end). */
  sideLoFlush?: boolean
  sideHiFlush?: boolean
  dormerOverrides?: Record<string, DormerOverride>
  /** Local Y the wall infill starts from (the storey wall top). 0 unless the
   *  segment is lifted above the storey by its own Y offset — then negative,
   *  so the infill still reaches down to the walls below. */
  infillFloor?: number
  /** Override the side (eave) lines, in local coordinates across the ridge.
   *  Set on a continuation so both masses share one cross-section. */
  sideLo?: number
  sideHi?: number
  /** Neighbouring roofs' volumes (local frame). Every face of this roof
   *  that falls inside one is cut away, so meeting roofs read as ONE roof:
   *  no slope, gable, infill or board inside another roof. */
  clipVolumes?: ClipVolume[]
  /** Footprint edges shared with a neighbouring roof (see RoofSeam). */
  seams?: RoofSeam[]
}

/**
 * A seam: a footprint edge this roof shares with a neighbouring roof whose
 * ridge also runs into it, at the same height (two wings meeting at an
 * angle, drawn as two sections). The two roofs fuse there: each runs on
 * past the drawn edge and stops dead where its slope meets the
 * neighbour's, a valley on one side of the ridge and a hip on the other.
 * No overhang, fascia or closing wall there. Local frame.
 */
export type RoofSeam = {
  /** The drawn (shared) edge, a -> b, outward normal n toward the
   *  neighbour: replaces the footprint cut along it, and bounds the
   *  roof's volume for other neighbours. */
  a: V2
  b: V2
  n: V2
  /** One per side of this roof's ridge (see RoofSeamHalf). */
  halves: RoofSeamHalf[]
}

/**
 * One side of a seam: the roof is removed where it is past the meeting
 * line (n·(q - p) > 0) AND on this side of its own ridge (s·(q - r) > 0).
 */
export type RoofSeamHalf = {
  p: V2
  n: V2
  r: V2
  s: V2
  /** The meeting line's run under the roof, for step walls. */
  from: V2
  to: V2
  /** The neighbour's roof height (this roof's local Y) along from -> to at
   *  parameter t. Where this roof stands higher, a step wall closes the
   *  gap down to it. */
  profile?: { t: number; y: number }[]
}

/** A convex volume as half-spaces: inside where n·(q - p) + eps >= 0 for all. */
export type ClipVolume = { n: V3; p: V3; eps: number }[]

type DormerSpec = {
  id: string
  parentFaceId: number
  footOnParent: [[number, number], [number, number]]
  type: 'gable' | 'shed' | 'hip'
  ridgeHeight: number
  cheekWidth: number
  windowId?: string
  /** Shed only: the dormer roof's pitch in degrees (unset = main / 3). */
  pitchDeg?: number
  /** The dormer's own window (free dormers): width, height, and sill above
   *  where the front meets the main slope. Absent = defaults. */
  window?: { w?: number; h?: number; sill?: number }
}

type ResolvedDormer = {
  id: string
  type: 'gable' | 'shed' | 'hip'
  edgeIdx: number
  anchor: V2
  eaveUnit: V2
  inwardUnit: V2
  halfW: number
  cheekD: number
  rZ: number
  zEaveD: number
  zBase: number
  tanParent: number
  tanShed: number
  /** Distance ahead of the front face still covered by this dormer in the
   *  height field (a followed window's wall stands there). */
  forwardCover: number
  /** Height of the main slope where the front meets it (local Y). */
  zFront: number
  /** Built over a real window: that window is its front, so no own glass. */
  followsWindow: boolean
  /** Requested window size for a free dormer (clamped to fit when built). */
  win?: { w?: number; h?: number; sill?: number }
}

type RoofFrame = {
  ridgeAlongX: boolean
  uMin: number
  uMax: number
  vMin: number
  vMax: number
  vMid: number
  halfSpan: number
  ridgeZ: number
  /** Eave height at the WALL line per EDGE index. */
  eaveOf: number[]
  /** Clamped tan per EDGE index. */
  tanOf: number[]
  /** Eave height per polygon CORNER index. */
  cornerY: number[]
  /** tan of the side edge each CORNER belongs to. */
  cornerTan: number[]
  eSideLo: number
  eSideHi: number
  eEndLo: number
  eEndHi: number
  /** Ridge u-extent at the wall line (gable/junction: to the end; hip: inset). */
  rLoU: number
  rHiU: number
  meanEave: number
  overhang: number
}

export type ShellShape = {
  node: RoofSegmentNode
  polygon: V2[]
  styles: EdgeStyle[]
  tans: number[]
  baseZ: number
  frame: RoofFrame
  realWalls: RealWallSpan[]
  noInteriorCap: boolean
  /** Slanted edges of a 4-point footprint (ridge frame, CCW, outward unit
   *  normal). The roof is built on the footprint's rectangle and cut back
   *  to these. Empty when the footprint IS its rectangle. */
  footprintCuts: { a: V2; b: V2; n: V2 }[]
  /** The drawn footprint, ridge frame, CCW (x, z). */
  footprint: V2[]
  /** Edges shared with a neighbouring roof (see RoofSeam). */
  seams: RoofSeam[]
  /** Sides whose eave has no overhang (see ShellBuildOptions.sideLoFlush). */
  flushLo: boolean
  flushHi: boolean
  /** Down-facing ceiling polygons under the slopes (set by the builder). */
  undersides?: V3[][]
  infillFloor: number
  clipVolumes: ClipVolume[]
  dormers: ResolvedDormer[]
}

// ─── Public entry points ──────────────────────────────────────────

/**
 * The segment's ridge angle (radians, three.js rotation-y sense), or 0.
 * Non-zero means the roof is built in a frame turned by this angle — the
 * ridge along that frame's x — with the footprint left where it was drawn.
 * roof-scene adds it to the placement rotation and roof-system to the
 * segment's, so every consumer sees one consistent frame.
 */
export function ridgeAngleRad(node: RoofSegmentNode): number {
  const d = (node as unknown as { ridgeAngleDeg?: number }).ridgeAngleDeg
  return typeof d === 'number' && Number.isFinite(d) && Math.abs(d) > 1e-6 ? (d * Math.PI) / 180 : 0
}

/**
 * Resolve everything about a segment's roof once. Both the geometry and the
 * height field read this, so they can never disagree.
 */
export function resolveShellShape(
  node: RoofSegmentNode,
  opts: ShellBuildOptions = {},
): ShellShape | null {
  const kind = node.roofType
  if (kind === 'gambrel' || kind === 'dutch' || kind === 'mansard') return null
  let raw = _resolvePolygon(node)
  if (raw.length !== 4) return null
  // Into the ridge's frame (inverse of three's rotation-y by the angle).
  const ra = ridgeAngleRad(node)
  if (ra) {
    const c = Math.cos(ra)
    const s = Math.sin(ra)
    raw = raw.map(([x, z]) => [x * c - z * s, x * s + z * c] as V2)
  }

  const xs = raw.map((p) => p[0])
  const zs = raw.map((p) => p[1])
  let xMin = Math.min(...xs)
  let xMax = Math.max(...xs)
  let zMin = Math.min(...zs)
  let zMax = Math.max(...zs)
  if (!(xMax > xMin && zMax > zMin)) return null

  const seams = (opts.seams ?? []).filter(
    (m) => Math.hypot(m.b[0] - m.a[0], m.b[1] - m.a[1]) > 1e-3 && m.halves.length > 0,
  )
  // A seam replaces the footprint cut along the same line: no overhang,
  // fascia or closing wall there.
  const footprintCuts = _footprintCuts(raw, xMin, xMax, zMin, zMax).filter(
    (c) =>
      !seams.some((m) => {
        const par = Math.abs(c.n[0] * m.n[1] - c.n[1] * m.n[0]) < 0.14 && c.n[0] * m.n[0] + c.n[1] * m.n[1] > 0
        const mid: V2 = [(c.a[0] + c.b[0]) / 2, (c.a[1] + c.b[1]) / 2]
        const d = Math.abs(m.n[0] * (mid[0] - m.a[0]) + m.n[1] * (mid[1] - m.a[1]))
        return par && d < 0.4
      }),
  )
  const footprint = _ccw(raw)
  // A shed (mono-pitch) is built as HALF a gable: the footprint is doubled
  // past its high side, built as a gable with the ridge on the high wall
  // line, and cut back there (a footprint cut: the high wall, fascia and
  // overhang come with it). Its low side is edge 0. Before 2026-09-26 it
  // was built as a gable with a near-vertical "slope" on the high side,
  // which ran 150 m into the ground.
  const explicitEdges = (node as unknown as { edges?: unknown[] }).edges
  const shed = kind === 'shed' && !(Array.isArray(explicitEdges) && explicitEdges.length === raw.length)
  const baseStyles: ('hip' | 'gable')[] = shed ? ['hip', 'gable', 'hip', 'gable'] : _resolveEdgeStyles(node, raw)
  // Fix the ridge orientation from the UNtruncated footprint — truncating a
  // hip along its ridge must not be able to flip it.
  const gX = baseStyles[1] === 'gable' || baseStyles[3] === 'gable'
  const gZ = baseStyles[0] === 'gable' || baseStyles[2] === 'gable'
  const ridgeAlongX = gX ? true : gZ ? false : xMax - xMin >= zMax - zMin

  // Move junction ends along the ridge axis (shorten OR extend).
  const clampLo = (v: number, hi: number) => Math.min(v, hi - 0.2)
  const clampHi = (v: number, lo: number) => Math.max(v, lo + 0.2)
  if (ridgeAlongX) {
    if (opts.truncateLo != null) xMin = clampLo(opts.truncateLo, xMax)
    if (opts.truncateHi != null) xMax = clampHi(opts.truncateHi, xMin)
  } else {
    if (opts.truncateLo != null) zMin = clampLo(opts.truncateLo, zMax)
    if (opts.truncateHi != null) zMax = clampHi(opts.truncateHi, zMin)
  }
  // Side (eave) lines moved by a neighbour: both on a continuation (share
  // its cross-section), one where a wing's eave is pulled back to a main
  // roof's end. Never narrower than 0.4 m.
  {
    const lo = opts.sideLo ?? (ridgeAlongX ? zMin : xMin)
    const hi = opts.sideHi ?? (ridgeAlongX ? zMax : xMax)
    if (hi - lo > 0.4) {
      if (ridgeAlongX) {
        zMin = lo
        zMax = hi
      } else {
        xMin = lo
        xMax = hi
      }
    }
  }
  if (shed && ridgeAlongX) {
    const high = zMax
    zMax = high + (high - zMin)
    footprintCuts.push({ a: [xMax, high], b: [xMin, high], n: [0, 1] })
  }
  const polygon: V2[] = [
    [xMin, zMin],
    [xMax, zMin],
    [xMax, zMax],
    [xMin, zMax],
  ]

  const eEndLo = ridgeAlongX ? 3 : 0
  const eEndHi = ridgeAlongX ? 1 : 2
  const styles: EdgeStyle[] = [...baseStyles]
  if (opts.endLo) styles[eEndLo] = opts.endLo
  else if (opts.truncateLo != null) styles[eEndLo] = 'junction'
  if (opts.endHi) styles[eEndHi] = opts.endHi
  else if (opts.truncateHi != null) styles[eEndHi] = 'junction'

  const halfSpan = (ridgeAlongX ? zMax - zMin : xMax - xMin) / 2
  let rise = Math.max(0.01, opts.ridgeRiseOverride ?? node.roofHeight ?? 2.5)
  if (opts.uniformTanOverride != null) rise = Math.max(0.01, opts.uniformTanOverride * halfSpan)
  const tans = _resolveEdgeTans(node, styles, rise / Math.max(0.1, halfSpan), opts.uniformTanOverride)

  const baseZ = Math.max(0, node.wallHeight ?? 0)
  const overhang = Math.max(0, Number((node as { overhang?: number }).overhang ?? 0.3))
  const frame = _roofFrame(polygon, styles, tans, baseZ, rise, overhang, ridgeAlongX)

  const realWalls = (opts.realWalls ?? []).filter(
    (w) => Number.isFinite(w.t0) && Number.isFinite(w.t1) && Number.isFinite(w.top) && w.t1 > w.t0,
  )

  const shape: ShellShape = {
    node,
    polygon,
    styles,
    tans,
    baseZ,
    frame,
    realWalls,
    noInteriorCap: !!opts.noInteriorCap,
    flushLo: !!opts.sideLoFlush,
    flushHi: !!opts.sideHiFlush,
    infillFloor: Math.min(0, Number.isFinite(opts.infillFloor) ? opts.infillFloor! : 0),
    clipVolumes: opts.clipVolumes ?? [],
    dormers: [],
    footprintCuts,
    footprint,
    seams,
  }
  shape.dormers = _resolveDormers(node)
    .map((d) => _resolveDormer(d, shape, opts.dormerOverrides?.[d.id]))
    .filter((d): d is ResolvedDormer => d !== null)
  return shape
}

/**
 * Geometry for one segment, in its local frame. Returns null when the shape
 * isn't handled here — roof-system then uses its legacy path.
 */
export function generateShellSegmentGeometry(
  node: RoofSegmentNode,
  opts: ShellBuildOptions = {},
): THREE.BufferGeometry | null {
  const shape = resolveShellShape(node, opts)
  if (!shape) return null
  const base = _buildRectangleShell(shape)
  if (!base) return new THREE.BufferGeometry()
  let geom = ensureGroupCoverage(base)
  if (shape.dormers.length > 0) geom = _unionDormers(geom, shape)
  if (shape.undersides?.length) {
    const vols = shape.dormers.map(_dormerCeilingVolume)
    const faces: { verts: V3[]; slot: number }[] = []
    for (const u of shape.undersides) {
      let pieces: V3[][] = [u]
      for (const v of vols) pieces = pieces.flatMap((pc) => _minusConvex(pc, v))
      for (const pc of pieces) {
        const clean = _dedupe(pc)
        if (clean.length >= 3 && _area(clean) > 1e-6) faces.push({ verts: clean, slot: SLOT_SOFFIT })
      }
    }
    if (faces.length) {
      const merged = _appendGeometry(ensureGroupCoverage(geom), _facesToGeometry(faces))
      geom.dispose()
      geom = ensureGroupCoverage(merged)
    }
  }
  if (shape.footprintCuts.length > 0 || shape.seams.length > 0) {
    // A 4-point footprint that isn't a rectangle (operator 2026-09-26: "some
    // four-point roofs are still shown as a rectangle"): cut the rectangle
    // roof back to each slanted edge (plus the overhang), then close it — a
    // wall on the edge line up to the roof, a fascia along the cut.
    const oh = shape.frame.overhang
    const vols: ClipVolume[] = shape.footprintCuts.map((c) => [
      { n: [c.n[0], 0, c.n[1]], p: [c.a[0] + c.n[0] * oh, 0, c.a[1] + c.n[1] * oh], eps: 0 },
    ])
    // Seams: cut dead where the neighbour takes over (it carries on from there).
    const seamVols = _seamVolumes(shape)
    vols.push(...seamVols)
    const cut = _subtractVolumes(geom, vols)
    geom.dispose()
    // Closing walls / fascias of the other cut edges stop at the seam too.
    let closingGeom = _facesToGeometry(_footprintClosing(shape))
    if (seamVols.length && closingGeom.getAttribute('position').count > 0) {
      const c = _subtractVolumes(closingGeom, seamVols)
      closingGeom.dispose()
      closingGeom = c
    }
    const steps = _seamSteps(shape)
    if (steps.length) {
      const both = _appendGeometry(ensureGroupCoverage(closingGeom), _facesToGeometry(steps))
      closingGeom.dispose()
      closingGeom = both
    }
    geom = (closingGeom.getAttribute('position')?.count ?? 0) > 0
      ? ensureGroupCoverage(_appendGeometry(ensureGroupCoverage(cut), ensureGroupCoverage(closingGeom)))
      : ensureGroupCoverage(cut)
    closingGeom.dispose()
    cut.dispose()
  }
  if (shape.clipVolumes.length > 0) {
    const cut = _subtractVolumes(geom, shape.clipVolumes)
    geom.dispose()
    geom = ensureGroupCoverage(cut)
  }
  geom.computeVertexNormals()
  return geom
}

/**
 * Remove every part of the geometry lying inside any of the volumes: the
 * surface of the UNION of this roof with its neighbours, as far as this roof
 * contributes to it. Works per triangle, so it applies after the dormer CSG.
 */
function _subtractVolumes(geom: THREE.BufferGeometry, volumes: ClipVolume[]): THREE.BufferGeometry {
  const pos = geom.getAttribute('position') as THREE.BufferAttribute
  const idx = geom.getIndex()
  const vert = (i: number): V3 => [pos.getX(i), pos.getY(i), pos.getZ(i)]
  const faces: { verts: V3[]; slot: number }[] = []
  const groups = geom.groups.length
    ? geom.groups
    : [{ start: 0, count: idx ? idx.count : pos.count, materialIndex: 0 }]
  for (const g of groups) {
    for (let k = g.start; k < g.start + g.count; k += 3) {
      const tri: V3[] = [0, 1, 2].map((o) => vert(idx ? idx.getX(k + o) : k + o))
      let pieces: V3[][] = [tri]
      for (const vol of volumes) {
        const next: V3[][] = []
        for (const pc of pieces) next.push(..._minusConvex(pc, vol))
        pieces = next
        if (!pieces.length) break
      }
      // _facesToGeometry reverses once; hand it the reversed walk so the
      // original winding (and facing) survives.
      for (const pc of pieces) {
        const clean = _dedupe(pc)
        if (clean.length >= 3 && _area(clean) > 1e-6) faces.push({ verts: clean.reverse(), slot: g.materialIndex ?? 0 })
      }
    }
  }
  return _facesToGeometry(faces)
}

/** Planar convex polygon minus a convex volume -> the pieces outside it. */
function _minusConvex(poly: V3[], vol: ClipVolume): V3[][] {
  const out: V3[][] = []
  let rest = poly
  for (const h of vol) {
    const f = (q: V3) => h.n[0] * (q[0] - h.p[0]) + h.n[1] * (q[1] - h.p[1]) + h.n[2] * (q[2] - h.p[2]) + h.eps
    const outside = _clipHalf(rest, (q) => -f(q))
    if (outside.length >= 3 && _area(outside) > 1e-8) out.push(outside)
    rest = _clipHalf(rest, f)
    if (rest.length < 3 || _area(rest) <= 1e-8) return out
  }
  return out // what's left of `rest` is inside the volume: dropped
}

/** Drop consecutive points closer than 0.01 mm (float noise from clipping). */
function _dedupe(poly: V3[]): V3[] {
  const out: V3[] = []
  for (const q of poly) {
    const last = out[out.length - 1]
    if (!last || Math.hypot(q[0] - last[0], q[1] - last[1], q[2] - last[2]) > 1e-5) out.push(q)
  }
  while (out.length > 1) {
    const a = out[0]!
    const b = out[out.length - 1]!
    if (Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) > 1e-5) break
    out.pop()
  }
  return out
}

function _area(poly: V3[]): number {
  let x = 0
  let y = 0
  let z = 0
  for (let i = 1; i < poly.length - 1; i++) {
    const a = poly[0]!
    const b = poly[i]!
    const c = poly[i + 1]!
    const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]]
    const v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]]
    x += u[1]! * v[2]! - u[2]! * v[1]!
    y += u[2]! * v[0]! - u[0]! * v[2]!
    z += u[0]! * v[1]! - u[1]! * v[0]!
  }
  return Math.hypot(x, y, z) / 2
}

/**
 * This roof's volume as half-spaces in ITS local frame: inside the wall-line
 * footprint, under every slope, above the infill floor. Vertical sides are
 * inclusive (a neighbour's face lying on this roof's wall line counts as
 * inside, so a shared seam wall drops out of both roofs); the slopes are
 * strict, so a coplanar slope never cancels itself out.
 */
export function shellVolumeLocal(shape: ShellShape, withOverhang = false): ClipVolume {
  const f = shape.frame
  const poly = shape.polygon
  const vol: ClipVolume = []
  // withOverhang: the volume reaches out to the fascia on every edge that
  // overhangs (hip / gable), under the slopes carried on out there. Used
  // when clipping NEIGHBOURS: another roof's rake or eave must stop at this
  // roof, not run on through its overhang (operator 2026-09-26: the south
  // gable's barge board ran straight down through the bay roof). Seams
  // (junction / abut) have no overhang and stay put.
  const oh = withOverhang ? f.overhang : 0
  for (let i = 0; i < 4; i++) {
    const a = poly[i]!
    const b = poly[(i + 1) % 4]!
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1
    const m: V2 = [-(b[1] - a[1]) / L, (b[0] - a[0]) / L] // inward (CCW in x/z as used by the infill)
    const flush = (i === f.eSideLo && shape.flushLo) || (i === f.eSideHi && shape.flushHi)
    const out = !flush && (shape.styles[i] === 'hip' || shape.styles[i] === 'gable') ? oh : 0
    vol.push({ n: [m[0], 0, m[1]], p: [a[0] - m[0] * out, 0, a[1] - m[1] * out], eps: 0.01 })
    const sloped = i === f.eSideLo || i === f.eSideHi || shape.styles[i] === 'hip'
    if (sloped) {
      // y <= eave_i + tan_i * d  ->  tan_i*d - y + eave_i >= 0
      const t = f.tanOf[i]!
      const e = f.eaveOf[i]!
      const k = Math.hypot(t, 1)
      vol.push({ n: [(t * m[0]) / k, -1 / k, (t * m[1]) / k], p: [a[0], e, a[1]], eps: -0.005 })
    }
  }
  for (const c of shape.footprintCuts) {
    vol.push({ n: [-c.n[0], 0, -c.n[1]], p: [c.a[0] + c.n[0] * oh, 0, c.a[1] + c.n[1] * oh], eps: 0.01 })
  }
  // A seam never overhangs: the neighbour's own roof starts right there.
  for (const m of shape.seams) {
    vol.push({ n: [-m.n[0], 0, -m.n[1]], p: [m.a[0], 0, m.a[1]], eps: 0.01 })
  }
  vol.push({ n: [0, 1, 0], p: [0, shape.infillFloor, 0], eps: 0.01 })
  return vol
}

/**
 * Roof surface height (local Y) above local point (x, z), or null when this
 * segment doesn't cover it. Dormers count: the result is the higher of the
 * main slope and any dormer standing there.
 */
export function shellHeightAtLocal(
  shape: ShellShape,
  x: number,
  z: number,
  /** false: the main roof only (walls stop there; a dormer is a closed box
   *  on top with its own front and window). */
  withDormers = true,
): number | null {
  const f = shape.frame
  const u = f.ridgeAlongX ? x : z
  const v = f.ridgeAlongX ? z : x
  // A junction/abut end hands over exactly at its wall; don't reach past it.
  const tight = (st: EdgeStyle | undefined) => st === 'junction' || st === 'abut'
  const bLo = tight(shape.styles[f.eEndLo]) ? 0.02 : COVER_BUFFER
  const bHi = tight(shape.styles[f.eEndHi]) ? 0.02 : COVER_BUFFER
  let best: number | null = null
  if (
    u >= f.uMin - bLo &&
    u <= f.uMax + bHi &&
    v >= f.vMin - COVER_BUFFER &&
    v <= f.vMax + COVER_BUFFER
  ) {
    let h = Math.min(
      f.eaveOf[f.eSideLo]! + f.tanOf[f.eSideLo]! * (v - f.vMin),
      f.eaveOf[f.eSideHi]! + f.tanOf[f.eSideHi]! * (f.vMax - v),
    )
    if (shape.styles[f.eEndLo] === 'hip') h = Math.min(h, f.meanEave + f.tanOf[f.eEndLo]! * (u - f.uMin))
    if (shape.styles[f.eEndHi] === 'hip') h = Math.min(h, f.meanEave + f.tanOf[f.eEndHi]! * (f.uMax - u))
    const outside =
      shape.footprintCuts.some((c) => c.n[0] * (x - c.a[0]) + c.n[1] * (z - c.a[1]) > COVER_BUFFER) ||
      shape.seams.some((m) =>
        m.halves.some(
          (h) =>
            h.n[0] * (x - h.p[0]) + h.n[1] * (z - h.p[1]) > 0.02 && h.s[0] * (x - h.r[0]) + h.s[1] * (z - h.r[1]) > 0,
        ),
      )
    if (!outside) best = h
  }
  for (const d of withDormers ? shape.dormers : []) {
    const dh = _dormerHeightAt(d, x, z)
    if (dh != null && (best == null || dh > best)) best = dh
  }
  return best
}

/**
 * The slanted edges of a 4-point footprint, in the ridge frame: every edge
 * that doesn't lie on its bounding rectangle. Empty for a rectangle, and
 * for a concave quad (cut half-spaces are only valid on convex ones).
 */
function _footprintCuts(raw: V2[], xMin: number, xMax: number, zMin: number, zMax: number): { a: V2; b: V2; n: V2 }[] {
  if (raw.length !== 4) return []
  let area = 0
  for (let i = 0; i < 4; i++) {
    const p = raw[i]!
    const q = raw[(i + 1) % 4]!
    area += p[0] * q[1] - q[0] * p[1]
  }
  const poly = area > 0 ? raw : [...raw].reverse()
  // Convex?
  let sign = 0
  for (let i = 0; i < 4; i++) {
    const a = poly[i]!
    const b = poly[(i + 1) % 4]!
    const c = poly[(i + 2) % 4]!
    const cr = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0])
    if (Math.abs(cr) < 1e-9) continue
    if (sign === 0) sign = Math.sign(cr)
    else if (Math.sign(cr) !== sign) return []
  }
  const T = 0.01
  const onSide = (a: V2, b: V2) =>
    (Math.abs(a[0] - xMin) < T && Math.abs(b[0] - xMin) < T) ||
    (Math.abs(a[0] - xMax) < T && Math.abs(b[0] - xMax) < T) ||
    (Math.abs(a[1] - zMin) < T && Math.abs(b[1] - zMin) < T) ||
    (Math.abs(a[1] - zMax) < T && Math.abs(b[1] - zMax) < T)
  const out: { a: V2; b: V2; n: V2 }[] = []
  for (let i = 0; i < 4; i++) {
    const a = poly[i]!
    const b = poly[(i + 1) % 4]!
    if (onSide(a, b)) continue
    const L = Math.hypot(b[0] - a[0], b[1] - a[1])
    if (L < 1e-6) continue
    // CCW polygon in (x, z): the inward normal is (-dz, dx); outward is its negation.
    const n: V2 = [(b[1] - a[1]) / L, -(b[0] - a[0]) / L]
    out.push({ a, b, n })
  }
  return out
}

/** The polygon wound counter-clockwise in (x, z). */
function _ccw(poly: V2[]): V2[] {
  let area = 0
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i]!
    const q = poly[(i + 1) % poly.length]!
    area += p[0] * q[1] - q[0] * p[1]
  }
  return area > 0 ? [...poly] : [...poly].reverse()
}

/**
 * Step walls on the seams: where this roof stands higher than the
 * neighbour at the seam line (ridges or eaves at different heights), a wall
 * on the line from the neighbour's roof up to this one. Nothing where the
 * two meet flush.
 */
function _seamSteps(shape: ShellShape): { verts: V3[]; slot: number }[] {
  const faces: { verts: V3[]; slot: number }[] = []
  const y0 = shape.infillFloor
  for (const m of shape.seams) {
    for (const h of m.halves) {
      // Walk so that the wall faces the neighbour (outward = h.n).
      let [p, q] = [h.from, h.to]
      let prof = h.profile ?? []
      if ((q[1] - p[1]) * h.n[0] - (q[0] - p[0]) * h.n[1] < 0) {
        ;[p, q] = [q, p]
        prof = prof.map((e) => ({ t: 1 - e.t, y: e.y })).reverse()
      }
      const L = Math.hypot(q[0] - p[0], q[1] - p[1])
      if (L < 1e-3) continue
      const ts = new Set<number>([0, 1])
      const steps = Math.max(1, Math.ceil(L / 0.1))
      for (let k = 1; k < steps; k++) ts.add(k / steps)
      for (const e of prof) if (e.t > 0 && e.t < 1) ts.add(e.t)
      const t = [...ts].sort((i, j) => i - j)
      const nbrY = (tt: number): number => {
        if (!prof.length) return y0
        if (tt <= prof[0]!.t) return prof[0]!.y
        for (let k = 0; k < prof.length - 1; k++) {
          const e = prof[k]!
          const g = prof[k + 1]!
          if (tt <= g.t) return e.y + ((g.y - e.y) * (tt - e.t)) / Math.max(1e-9, g.t - e.t)
        }
        return prof[prof.length - 1]!.y
      }
      const at = (tt: number): [number, number] => [p[0] + (q[0] - p[0]) * tt, p[1] + (q[1] - p[1]) * tt]
      for (let k = 0; k < t.length - 1; k++) {
        const [x0, z0] = at(t[k]!)
        const [x1, z1] = at(t[k + 1]!)
        const top0 = Math.max(y0, _slopeY(shape, x0, z0))
        const top1 = Math.max(y0, _slopeY(shape, x1, z1))
        const bot0 = Math.min(top0, Math.max(y0, nbrY(t[k]!)))
        const bot1 = Math.min(top1, Math.max(y0, nbrY(t[k + 1]!)))
        if (top0 - bot0 < 0.01 && top1 - bot1 < 0.01) continue
        faces.push({
          verts: [
            [x0, bot0, z0],
            [x1, bot1, z1],
            [x1, top1, z1],
            [x0, top0, z0],
          ],
          slot: SLOT_WALL_EXTERIOR,
        })
      }
    }
  }
  return faces
}

/** Where the seams remove this roof: one convex volume per seam half. */
function _seamVolumes(shape: ShellShape): ClipVolume[] {
  return shape.seams.flatMap((m) =>
    m.halves.map(
      (h): ClipVolume => [
        { n: [h.n[0], 0, h.n[1]], p: [h.p[0], 0, h.p[1]], eps: 0 },
        { n: [h.s[0], 0, h.s[1]], p: [h.r[0], 0, h.r[1]], eps: 0 },
      ],
    ),
  )
}

/** The main slope surface (no dormers), local Y, at any local point. */
function _slopeY(shape: ShellShape, x: number, z: number): number {
  const f = shape.frame
  const u = f.ridgeAlongX ? x : z
  const v = f.ridgeAlongX ? z : x
  let h = Math.min(
    f.eaveOf[f.eSideLo]! + f.tanOf[f.eSideLo]! * (v - f.vMin),
    f.eaveOf[f.eSideHi]! + f.tanOf[f.eSideHi]! * (f.vMax - v),
  )
  if (shape.styles[f.eEndLo] === 'hip') h = Math.min(h, f.meanEave + f.tanOf[f.eEndLo]! * (u - f.uMin))
  if (shape.styles[f.eEndHi] === 'hip') h = Math.min(h, f.meanEave + f.tanOf[f.eEndHi]! * (f.uMax - u))
  return h
}

/**
 * Faces that close a roof cut back to a slanted footprint edge: the wall on
 * the edge line from the storey wall top up to the roof (the region under a
 * concave roof line is convex, so one polygon), and a fascia band along the
 * cut line an overhang further out.
 */
function _footprintClosing(shape: ShellShape): { verts: V3[]; slot: number }[] {
  const faces: { verts: V3[]; slot: number }[] = []
  const y0 = shape.infillFloor
  const oh = shape.frame.overhang
  const F = oh > 1e-3 ? FASCIA_M : 0
  const f = shape.frame
  for (const c of shape.footprintCuts) {
    // Sample the roof line along the edge, exact at the ridge crossing.
    const ts = new Set<number>([0, 1])
    const L = Math.hypot(c.b[0] - c.a[0], c.b[1] - c.a[1])
    const steps = Math.max(1, Math.ceil(L / 0.1))
    for (let k = 1; k < steps; k++) ts.add(k / steps)
    const va = f.ridgeAlongX ? c.a[1] : c.a[0]
    const vb = f.ridgeAlongX ? c.b[1] : c.b[0]
    if ((va - f.vMid) * (vb - f.vMid) < 0) ts.add((f.vMid - va) / (vb - va))
    const t = [...ts].sort((p, q) => p - q)
    const at = (tt: number, off: number): [number, number] => [
      c.a[0] + (c.b[0] - c.a[0]) * tt + c.n[0] * off,
      c.a[1] + (c.b[1] - c.a[1]) * tt + c.n[1] * off,
    ]
    // Wall: bottom a -> b, then the roof line back b -> a.
    const wall: V3[] = [
      [c.a[0], y0, c.a[1]],
      [c.b[0], y0, c.b[1]],
    ]
    for (let k = t.length - 1; k >= 0; k--) {
      const [x, z] = at(t[k]!, 0)
      wall.push([x, Math.max(y0, _slopeY(shape, x, z)), z])
    }
    faces.push({ verts: wall, slot: SLOT_WALL_EXTERIOR })
    // Fascia along the cut line.
    if (F > 0) {
      for (let k = 0; k < t.length - 1; k++) {
        const [x0, z0] = at(t[k]!, oh)
        const [x1, z1] = at(t[k + 1]!, oh)
        const y0t = _slopeY(shape, x0, z0)
        const y1t = _slopeY(shape, x1, z1)
        faces.push({
          verts: [
            [x0, y0t - F, z0],
            [x1, y1t - F, z1],
            [x1, y1t, z1],
            [x0, y0t, z0],
          ],
          slot: SLOT_FASCIA,
        })
      }
    }
  }
  return faces
}

/** Start/end corners of a polygon edge in local XZ. */
export function shellEdgeLocal(shape: ShellShape, edgeIdx: number): [V2, V2] {
  const p = shape.polygon
  return [p[edgeIdx % 4]!, p[(edgeIdx + 1) % 4]!]
}

/** Edge indices that slope down to an eave (the only ones a dormer can sit on). */
export function shellSlopedEdges(shape: ShellShape): number[] {
  const f = shape.frame
  const out = [f.eSideLo, f.eSideHi]
  if (shape.styles[f.eEndLo] === 'hip') out.push(f.eEndLo)
  if (shape.styles[f.eEndHi] === 'hip') out.push(f.eEndHi)
  // ASCENDING edge index. A dormer's saved parentFaceId indexes into this
  // list, and the original code built it in index order — any other order
  // silently moves existing dormers to a different slope.
  return out.sort((a, b) => a - b)
}

// ─── Resolution helpers ───────────────────────────────────────────

function _resolvePolygon(node: RoofSegmentNode): V2[] {
  // Local corners in the SEGMENT frame; +X east, +Z south, Y up.
  const poly = (node as unknown as { polygon?: V2[] }).polygon
  if (Array.isArray(poly) && poly.length === 4) {
    return poly.map(([x, z]) => [Number(x), Number(z)] as V2)
  }
  const w = node.width
  const d = node.depth
  return [
    [-w / 2, -d / 2],
    [w / 2, -d / 2],
    [w / 2, d / 2],
    [-w / 2, d / 2],
  ]
}

function _resolveEdgeStyles(node: RoofSegmentNode, polygon: V2[]): ('hip' | 'gable')[] {
  const explicit = (node as unknown as { edges?: { style: string }[] }).edges
  if (Array.isArray(explicit) && explicit.length === polygon.length) {
    return explicit.map((e) => (String(e?.style).toLowerCase() === 'gable' ? 'gable' : 'hip'))
  }
  if (node.roofType === 'hip' || node.roofType === 'flat') return ['hip', 'hip', 'hip', 'hip']
  if (node.roofType === 'shed') return ['hip', 'gable', 'gable', 'gable']
  // Gable. Edges: 0 = min-Z (along X), 1 = max-X, 2 = max-Z, 3 = min-X.
  // Ridge east-west -> gable ends on E and W (1, 3); north-south -> on 0, 2.
  // With a ridge angle the frame is turned so the ridge runs along its x.
  const axis = ridgeAngleRad(node) ? 'east-west' : node.ridgeAxis
  const ew = axis === 'east-west' || (axis !== 'north-south' && node.width >= node.depth)
  return ew ? ['hip', 'gable', 'hip', 'gable'] : ['gable', 'hip', 'gable', 'hip']
}

function _resolveEdgeTans(
  node: RoofSegmentNode,
  styles: EdgeStyle[],
  uniformTan: number,
  forced?: number,
): number[] {
  const authored = (node as unknown as { edgeWeights?: number[] }).edgeWeights
  const out: number[] = new Array(styles.length).fill(forced ?? uniformTan)
  if (forced == null && Array.isArray(authored) && authored.length === styles.length) {
    for (let i = 0; i < styles.length; i++) {
      const w = Number(authored[i])
      if (w > 0 && Number.isFinite(w)) out[i] = w
    }
  }
  // Gable and junction ends have no slope of their own.
  for (let i = 0; i < styles.length; i++) {
    if (styles[i] !== 'hip') out[i] = NEAR_VERTICAL_TAN
  }
  return out
}

function _roofFrame(
  polygon: V2[],
  styles: EdgeStyle[],
  tans: number[],
  baseZ: number,
  rise: number,
  overhang: number,
  ridgeAlongX: boolean,
): RoofFrame {
  const xMin = polygon[0]![0]
  const xMax = polygon[1]![0]
  const zMin = polygon[0]![1]
  const zMax = polygon[2]![1]
  const uMin = ridgeAlongX ? xMin : zMin
  const uMax = ridgeAlongX ? xMax : zMax
  const vMin = ridgeAlongX ? zMin : xMin
  const vMax = ridgeAlongX ? zMax : xMax
  const halfSpan = (vMax - vMin) / 2
  const ridgeZ = baseZ + rise

  const eSideLo = ridgeAlongX ? 0 : 3
  const eSideHi = ridgeAlongX ? 2 : 1
  const eEndLo = ridgeAlongX ? 3 : 0
  const eEndHi = ridgeAlongX ? 1 : 2

  const tanOf = tans.map((t) => Math.max(MIN_EDGE_WEIGHT, t))
  // RIDGE CENTRED AND PINNED; each sloped edge's eave from its own pitch.
  const eLo = ridgeZ - tanOf[eSideLo]! * halfSpan
  const eHi = ridgeZ - tanOf[eSideHi]! * halfSpan
  const meanEave = (eLo + eHi) / 2
  const eaveOf = [meanEave, meanEave, meanEave, meanEave]
  eaveOf[eSideLo] = eLo
  eaveOf[eSideHi] = eHi

  // Corners take the eave of the SIDE edge they belong to (keeps the shell
  // closed when the two pitches differ).
  const cornerY = ridgeAlongX ? [eLo, eLo, eHi, eHi] : [eLo, eHi, eHi, eLo]
  const tLo = tanOf[eSideLo]!
  const tHi = tanOf[eSideHi]!
  const cornerTan = ridgeAlongX ? [tLo, tLo, tHi, tHi] : [tLo, tHi, tHi, tLo]

  const axisLen = uMax - uMin
  const insetFor = (e: number) => {
    if (styles[e] !== 'hip') return 0
    return Math.min(Math.max((ridgeZ - meanEave) / tanOf[e]!, 0), axisLen / 2)
  }
  return {
    ridgeAlongX,
    uMin,
    uMax,
    vMin,
    vMax,
    vMid: (vMin + vMax) / 2,
    halfSpan,
    ridgeZ,
    eaveOf,
    tanOf,
    cornerY,
    cornerTan,
    eSideLo,
    eSideHi,
    eEndLo,
    eEndHi,
    rLoU: uMin + insetFor(eEndLo),
    rHiU: uMax - insetFor(eEndHi),
    meanEave,
    overhang: Math.max(0, overhang),
  }
}

// ─── Main shell ───────────────────────────────────────────────────

/** Keep the part of a planar polygon where f(p) >= 0 (Sutherland–Hodgman). */
function _clipHalf(verts: V3[], f: (p: V3) => number): V3[] {
  const out: V3[] = []
  for (let i = 0; i < verts.length; i++) {
    const a = verts[i]!
    const b = verts[(i + 1) % verts.length]!
    const fa = f(a)
    const fb = f(b)
    const ain = fa >= -1e-7
    const bin = fb >= -1e-7
    if (ain) out.push(a)
    if (ain !== bin) {
      const t = fa / (fa - fb)
      out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t])
    }
  }
  // Drop consecutive duplicates (degenerate corners where an eave sits at 0).
  return out.filter((p, i) => {
    const q = out[(i + out.length - 1) % out.length]!
    return Math.abs(p[0] - q[0]) + Math.abs(p[1] - q[1]) + Math.abs(p[2] - q[2]) > 1e-7
  })
}

/** Normal _facesToGeometry will give this vertex list (it reverses first). */
function _faceNormal(verts: V3[]): V3 {
  const r = [...verts].reverse()
  const a = r[0]!
  const b = r[1]!
  const c = r[2]!
  const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]]
  const v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]]
  return [u[1]! * v[2]! - u[2]! * v[1]!, u[2]! * v[0]! - u[0]! * v[2]!, u[0]! * v[1]! - u[1]! * v[0]!]
}

type EdgeRun = { t0: number; t1: number; top: number; inset: number }

/** Split an edge into runs by which real wall (if any) stands along it. A
 *  run with no wall has top = -Infinity. */
function _edgeRuns(spans: RealWallSpan[]): EdgeRun[] {
  const pts = new Set<number>([0, 1])
  for (const s of spans) {
    pts.add(Math.min(1, Math.max(0, s.t0)))
    pts.add(Math.min(1, Math.max(0, s.t1)))
  }
  const cuts = [...pts].sort((a, b) => a - b)
  const runs: EdgeRun[] = []
  for (let i = 0; i < cuts.length - 1; i++) {
    const t0 = cuts[i]!
    const t1 = cuts[i + 1]!
    if (t1 - t0 < 1e-6) continue
    const mid = (t0 + t1) / 2
    let top = Number.NEGATIVE_INFINITY
    let inset = 0
    for (const s of spans) {
      if (s.t0 <= mid && s.t1 >= mid && s.top > top) {
        top = s.top
        inset = s.inset
      }
    }
    const prev = runs[runs.length - 1]
    if (prev && prev.top === top && prev.inset === inset) prev.t1 = t1
    else runs.push({ t0, t1, top, inset })
  }
  return runs
}

function _buildRectangleShell(shape: ShellShape): THREE.BufferGeometry | null {
  const f = shape.frame
  const { ridgeAlongX, uMin, uMax, vMin, vMax, vMid, ridgeZ, eaveOf, tanOf, cornerY } = f
  const oh = f.overhang
  const P = (u: number, y: number, v: number): V3 => (ridgeAlongX ? [u, y, v] : [v, y, u])
  const styleLo = shape.styles[f.eEndLo]!
  const styleHi = shape.styles[f.eEndHi]!
  const noOverhangEnd = (st: EdgeStyle) => st === 'junction' || st === 'abut'

  const eLo = eaveOf[f.eSideLo]!
  const eHi = eaveOf[f.eSideHi]!
  const ohLo = shape.flushLo ? 0 : oh
  const ohHi = shape.flushHi ? 0 : oh
  const eLoO = eLo - tanOf[f.eSideLo]! * ohLo
  const eHiO = eHi - tanOf[f.eSideHi]! * ohHi
  const F = oh > 1e-3 ? FASCIA_M : 0

  // Ridge u-extent. Gable ends run the ridge PAST the wall by the overhang
  // (the rake); junction/abut ends stop exactly at the wall; hips keep
  // their inset.
  const rLoU = f.rLoU - (styleLo === 'gable' ? oh : 0)
  const rHiU = f.rHiU + (styleHi === 'gable' ? oh : 0)
  const R_lo = P(rLoU, ridgeZ, vMid)
  const R_hi = P(rHiU, ridgeZ, vMid)

  // Eave-line extent: outset everywhere except at a junction/abut end, which
  // must stop dead so nothing pokes into or out of the neighbouring roof.
  const uLoO = noOverhangEnd(styleLo) ? uMin : uMin - oh
  const uHiO = noOverhangEnd(styleHi) ? uMax : uMax + oh
  const vLoO = vMin - ohLo
  const vHiO = vMax + ohHi
  const E_ll = P(uLoO, eLoO, vLoO)
  const E_hl = P(uHiO, eLoO, vLoO)
  const E_hh = P(uHiO, eHiO, vHiO)
  const E_lh = P(uLoO, eHiO, vHiO)
  const down = (p: V3): V3 => [p[0], p[1] - F, p[2]]

  const faces: { verts: V3[]; slot: number }[] = []
  const add = (verts: V3[], slot: number) => {
    if (verts.length >= 3) faces.push({ verts, slot })
  }

  // Slopes.
  add([E_ll, E_hl, R_hi, R_lo], SLOT_SLATE_TOP)
  add([E_hh, E_lh, R_lo, R_hi], SLOT_SLATE_TOP)

  // Eave fascia + boxed soffit on both long sides.
  if (F > 0) {
    add([down(E_ll), down(E_hl), E_hl, E_ll], SLOT_FASCIA)
    add([down(E_hh), down(E_lh), E_lh, E_hh], SLOT_FASCIA)
    if (ohLo > 1e-3) add([P(uLoO, eLoO - F, vMin), P(uHiO, eLoO - F, vMin), down(E_hl), down(E_ll)], SLOT_SOFFIT)
    if (ohHi > 1e-3) add([P(uHiO, eHiO - F, vMax), P(uLoO, eHiO - F, vMax), down(E_lh), down(E_hh)], SLOT_SOFFIT)
  }

  // Overhang dressing at the ends. The vertical end walls themselves are
  // part of the wall-line infill below.
  const end = (atHi: boolean) => {
    const style = atHi ? styleHi : styleLo
    if (style === 'junction' || style === 'abut') return
    const uWall = atHi ? uMax : uMin
    const uOut = atHi ? uHiO : uLoO
    const R = atHi ? R_hi : R_lo
    const orient = (vs: V3[]) => (atHi ? vs : [...vs].reverse())
    if (style === 'gable') {
      if (F > 0) {
        const A = P(uOut, eLoO, vLoO)
        const B = P(uOut, ridgeZ, vMid)
        const C = P(uOut, eHiO, vHiO)
        add(orient([down(A), down(B), B, A]), SLOT_FASCIA)
        add(orient([down(B), down(C), C, B]), SLOT_FASCIA)
        add(orient([P(uWall, eLoO - F, vLoO), P(uWall, ridgeZ - F, vMid), down(B), down(A)]), SLOT_SOFFIT)
        add(orient([P(uWall, ridgeZ - F, vMid), P(uWall, eHiO - F, vHiO), down(C), down(B)]), SLOT_SOFFIT)
      }
    } else {
      const EL = P(uOut, eLoO, vLoO)
      const EH = P(uOut, eHiO, vHiO)
      add(orient([EL, EH, R]), SLOT_SLATE_TOP)
      if (F > 0) {
        add(orient([down(EL), down(EH), EH, EL]), SLOT_FASCIA)
        add(orient([P(uWall, eLoO - F, vLoO), P(uWall, eHiO - F, vHiO), down(EH), down(EL)]), SLOT_SOFFIT)
      }
    }
  }
  end(true)
  end(false)

  // Mirror correction for the ridge-along-Z orientation (x <-> z swap).
  if (!ridgeAlongX) for (const fc of faces) fc.verts.reverse()

  // Undersides. Slates are single-sided, so from inside the house the roof
  // was invisible and windows showed open sky (operator, 2026-09-26) once
  // the flat interior cap went. Every slope gets a down-facing twin
  // ROOF_UNDERSIDE_M below it: the ceiling seen from inside. They are added
  // AFTER the dormer union (see _undersides) — inside the union a dormer
  // body would swallow the ceiling behind its valley line.
  shape.undersides = []
  for (const fc of faces) {
    if (fc.slot !== SLOT_SLATE_TOP) continue
    const n = _faceNormal(fc.verts)
    const L = Math.hypot(n[0], n[1], n[2])
    if (L < 1e-12) continue
    const k = ROOF_UNDERSIDE_M / L
    shape.undersides.push(fc.verts.map((p) => [p[0] - n[0] * k, p[1] - n[1] * k, p[2] - n[2] * k] as V3).reverse())
  }

  // ── Wall-line infill ──────────────────────────────────────────────
  // Along every edge line, the wall between the storey wall top (y = 0) and
  // the roof: a strip under an eave, strip + gable on a gable/abut end.
  // Where a REAL wall stands along part of the edge, only the part ABOVE its
  // top is generated there (the real wall, windows and all, is the
  // parapet), and a return face closes the slot between the edge line and
  // the inset real wall at each end of that stretch.
  const poly = shape.polygon
  const y0 = shape.infillFloor
  for (let i = 0; i < 4; i++) {
    const st = shape.styles[i]!
    if (st === 'junction') continue
    const j = (i + 1) % 4
    const pi = poly[i]!
    const pj = poly[j]!
    const ex = pj[0] - pi[0]
    const ez = pj[1] - pi[1]
    const L = Math.hypot(ex, ez)
    if (L < 1e-6) continue
    const dir: V2 = [ex / L, ez / L]
    const inward: V2 = [-dir[1], dir[0]]
    const yi = cornerY[i]!
    const yj = cornerY[j]!
    // Outline in edge order (outward-facing; checked by the facing audit).
    const outline: V3[] =
      st === 'gable' || st === 'abut'
        ? [
            [pi[0], y0, pi[1]],
            [pj[0], y0, pj[1]],
            [pj[0], yj, pj[1]],
            [(pi[0] + pj[0]) / 2, ridgeZ, (pi[1] + pj[1]) / 2],
            [pi[0], yi, pi[1]],
          ]
        : [
            [pi[0], y0, pi[1]],
            [pj[0], y0, pj[1]],
            [pj[0], yj, pj[1]],
            [pi[0], yi, pi[1]],
          ]
    const along = (p: V3) => (p[0] - pi[0]) * dir[0] + (p[2] - pi[1]) * dir[1]
    const eaveAt = (t: number) => yi + (yj - yi) * t
    const runs = _edgeRuns(shape.realWalls.filter((w) => w.edge === i))
    for (let k = 0; k < runs.length; k++) {
      const r = runs[k]!
      const covered = Number.isFinite(r.top)
      const floor = covered ? Math.max(y0, r.top) : y0
      let piece = _clipHalf(outline, (p) => along(p) - r.t0 * L)
      piece = _clipHalf(piece, (p) => r.t1 * L - along(p))
      piece = _clipHalf(piece, (p) => p[1] - floor)
      add(piece, SLOT_WALL_EXTERIOR)

      // Return faces where a covered stretch meets an uncovered one.
      if (!covered || r.inset <= 0.02) continue
      const bounds: [number, EdgeRun | undefined, number][] = [
        [r.t0, runs[k - 1], 1],
        [r.t1, runs[k + 1], -1],
      ]
      for (const [tb, neighbour, towardCovered] of bounds) {
        if (tb <= 1e-6 || tb >= 1 - 1e-6) continue // corner: the next edge closes it
        if (neighbour && Number.isFinite(neighbour.top) && neighbour.top >= r.top) continue
        const ax = pi[0] + dir[0] * tb * L
        const az = pi[1] + dir[1] * tb * L
        const bx = ax + inward[0] * r.inset
        const bz = az + inward[1] * r.inset
        const h = Math.max(eaveAt(tb), y0)
        if (h - y0 <= 1e-3) continue
        let quad: V3[] = [
          [ax, y0, az],
          [bx, y0, bz],
          [bx, h, bz],
          [ax, h, az],
        ]
        // Face INTO the covered stretch's slot (along +/- the edge).
        const n = _faceNormal(quad)
        if ((n[0] * dir[0] + n[2] * dir[1]) * towardCovered < 0) quad = quad.reverse()
        add(quad, SLOT_WALL_EXTERIOR)
      }
    }
  }

  // Interior cap so walk-mode doesn't see sky from below. Not when walls
  // stand under this roof on the level above: then it sits in the middle of
  // that floor and shows through its windows as a flat plane.
  if (!shape.noInteriorCap) {
    const capY = Math.min(...cornerY)
    add(poly.map(([x, z]) => [x, capY, z] as V3), SLOT_SOFFIT)
  }

  return _facesToGeometry(faces)
}

// ─── Dormers ──────────────────────────────────────────────────────

function _resolveDormers(node: RoofSegmentNode): DormerSpec[] {
  const raw = (node as unknown as { dormers?: DormerSpec[] }).dormers
  if (!Array.isArray(raw)) return []
  return raw.filter(
    (d) =>
      d &&
      Array.isArray(d.footOnParent) &&
      d.footOnParent.length === 2 &&
      typeof d.ridgeHeight === 'number' &&
      typeof d.cheekWidth === 'number',
  )
}

function _resolveDormer(
  spec: DormerSpec,
  shape: ShellShape,
  ov: DormerOverride | undefined,
): ResolvedDormer | null {
  const f = shape.frame
  const sloped = shellSlopedEdges(shape)
  let idx: number
  if (ov && sloped.includes(ov.edgeIdx)) idx = ov.edgeIdx
  else idx = sloped[Math.min(Math.max(0, spec.parentFaceId | 0), sloped.length - 1)]!
  if (idx == null) return null

  const [p0, p1] = shellEdgeLocal(shape, idx)
  const ex = p1[0] - p0[0]
  const ez = p1[1] - p0[1]
  const eaveLen = Math.hypot(ex, ez)
  if (eaveLen < 1e-6) return null
  const eaveUnit: V2 = [ex / eaveLen, ez / eaveLen]
  // Polygon is CCW (shoelace > 0), so the left normal points inward.
  const inwardUnit: V2 = [-eaveUnit[1], eaveUnit[0]]

  const uMid = ov ? ov.uMid : 0.5 * (spec.footOnParent[0][0] + spec.footOnParent[1][0])
  const vMid = 0.5 * (spec.footOnParent[0][1] + spec.footOnParent[1][1])
  const cheekWidth = Math.max(0.3, ov ? ov.cheekWidth : spec.cheekWidth)
  let rh = Math.max(0.2, ov ? ov.ridgeHeight : spec.ridgeHeight)
  const rhAsked = rh
  const halfW = cheekWidth / 2

  const tanParent = Math.max(MIN_EDGE_WEIGHT, f.tanOf[idx]!)
  const eaveParent = f.eaveOf[idx]!
  // Shed roof pitch: the operator's, or a third of the main slope's. It
  // must stay shallower than the main slope (3 degrees at least), or the
  // main roof never climbs back over it.
  const mainDeg = (Math.atan(tanParent) * 180) / Math.PI
  const shedDeg =
    typeof spec.pitchDeg === 'number' && Number.isFinite(spec.pitchDeg)
      ? Math.min(Math.max(spec.pitchDeg, 1), mainDeg - 3)
      : null
  const tanShed = Math.min(
    tanParent * 0.9,
    shedDeg != null && shedDeg > 0 ? Math.tan((shedDeg * Math.PI) / 180) : tanParent / 3,
  )

  // Run from this edge in to the ridge: the half-span for a side edge, the
  // hip inset for a hip end.
  const run =
    idx === f.eSideLo || idx === f.eSideHi
      ? f.halfSpan
      : idx === f.eEndLo
        ? f.rLoU - f.uMin
        : f.uMax - f.rHiU
  // Run over which the main roof climbs back up to meet the dormer's roof.
  // A shed roof rises inward too (at tanShed, shallower), so the main slope
  // only gains tanParent - tanShed per metre on it. The dormer must be
  // swallowed at least 0.3 m short of the main ridge, or it pokes over onto
  // the far slope (a 1.5 m shed on a 30 degree, 4 m half-span did): cap its
  // height so it is.
  const gain = spec.type === 'shed' ? tanParent - tanShed : tanParent
  // Free dormers: V maps across a range set by the slope and the asked
  // height only (the gable rule) — NOT the type or the shed pitch, so
  // switching type or dragging the shed's pitch never slides the dormer
  // along the roof (operator 2026-09-26). Window-following dormers: the
  // window's wall decides.
  const refBury = Math.min(rhAsked, Math.max(0.2, (run - 0.3) * tanParent)) / tanParent
  const refRun = Math.max(0, run - refBury)
  const inward = ov ? Math.max(0, ov.inward) : Math.min(Math.max(vMid, 0), 1) * refRun
  // Then keep it clear of the ridge FROM WHERE IT STANDS: a steep shed pitch
  // lowers the front instead of moving the dormer.
  let runToBury: number
  if (spec.type === 'shed') {
    // A shed pivots about its BACK line (operator 2026-09-26: "the end
    // on the roof stays fixed, the other end moves up and down as I change
    // the pitch"). Its depth is set once — by the asked height at the
    // default pitch (main / 3), so an unchanged shed looks as before — and
    // kept clear of the ridge. The pitch then sets how far the front eave
    // drops from that fixed back line: rh = depth * (tanParent - tanShed).
    const depth = Math.min(rhAsked / (tanParent - tanParent / 3), Math.max(0.3, run - 0.3 - inward))
    rh = Math.max(0.05, depth * gain)
    runToBury = depth
  } else {
    rh = Math.min(rh, Math.max(0.2, (run - 0.3 - inward) * gain))
    runToBury = rh / gain
  }

  const anchor: V2 = [
    p0[0] + uMid * ex + inwardUnit[0] * inward,
    p0[1] + uMid * ez + inwardUnit[1] * inward,
  ]
  const zFront = eaveParent + tanParent * inward
  const rZ = zFront + rh
  const gableRise = Math.min(rh * 0.5, halfW * tanParent)
  return {
    id: spec.id,
    type: spec.type,
    edgeIdx: idx,
    anchor,
    eaveUnit,
    inwardUnit,
    halfW,
    cheekD: runToBury + 0.15,
    rZ,
    zEaveD: rZ - gableRise,
    zBase: zFront - Math.max(0.6, rh),
    tanParent,
    tanShed,
    forwardCover: 0.05,
    zFront,
    followsWindow: !!ov,
    // Its own window, like a free dormer: sized from the followed window
    // unless the panel set it.
    win: { ...(ov?.win ?? {}), ..._definedOnly(spec.window) },
  }
}

function _definedOnly<T extends object>(o: T | undefined): Partial<T> {
  const out: Partial<T> = {}
  for (const [k, v] of Object.entries(o ?? {})) if (typeof v === 'number' && Number.isFinite(v)) (out as any)[k] = v
  return out
}

/** Dormer roof height at local (x, z), or null outside it. */
function _dormerHeightAt(d: ResolvedDormer, x: number, z: number): number | null {
  const rx = x - d.anchor[0]
  const rz = z - d.anchor[1]
  const s = rx * d.eaveUnit[0] + rz * d.eaveUnit[1]
  const dep = rx * d.inwardUnit[0] + rz * d.inwardUnit[1]
  if (Math.abs(s) > d.halfW + 0.05) return null
  if (dep < -d.forwardCover || dep > d.cheekD) return null
  const lat = Math.min(1, Math.abs(s) / Math.max(1e-6, d.halfW))
  if (d.type === 'shed') return d.rZ + d.tanShed * Math.max(0, dep)
  const gable = d.rZ - (d.rZ - d.zEaveD) * lat
  if (d.type === 'hip') {
    const d0 = (d.rZ - d.zEaveD) / d.tanParent
    const front = d.zEaveD + (d.rZ - d.zEaveD) * Math.min(Math.max(dep / Math.max(1e-6, d0), 0), 1)
    return Math.min(gable, front)
  }
  return gable
}

function _unionDormers(base: THREE.BufferGeometry, shape: ShellShape): THREE.BufferGeometry {
  let acc: Brush = new Brush(base, dummyMats)
  acc.updateMatrixWorld()
  for (const d of shape.dormers) {
    const dgeo = _buildDormerGeometry(d)
    if (!dgeo) continue
    const dbrush = new Brush(dgeo, dummyMats)
    dbrush.updateMatrixWorld()
    try {
      const next = _csg.evaluate(acc, dbrush, ADDITION) as Brush
      _remapToSlots(next)
      acc.geometry.dispose()
      dbrush.geometry.dispose()
      acc = next
    } catch (e) {
      // Skip a failing dormer; the rest of the roof still shows, and the
      // missing dormer tells the operator which one is broken.
      console.warn('shell-preview: dormer union failed', e)
      dbrush.geometry.dispose()
    }
  }
  // Trim: a thick roof slab with overhangs on every dormer, so its edges
  // read as fascia and barge boards, not bare sheets (operator, 2026-09-26).
  for (const d of shape.dormers) {
    for (const top of _dormerRoofTop(d)) {
      const slab = _dormerRoofSlab(d, top)
      if (!slab) continue
      const b = new Brush(slab, dummyMats)
      b.updateMatrixWorld()
      try {
        const next = _csg.evaluate(acc, b, ADDITION) as Brush
        _remapToSlots(next)
        acc.geometry.dispose()
        acc = next
      } catch (e) {
        console.warn('shell-preview: dormer trim union failed', e)
      }
      b.geometry.dispose()
    }
  }

  // A dormer always has a window (operator, 2026-09-26). One built over a
  // real window uses that; every other one gets its own: a recess cut
  // into the front with a glass pane at the back of it.
  // Plain faces appended after the CSG: dormer glass and dormer ceilings.
  const glass: { verts: V3[]; slot: number }[] = []
  for (const d of shape.dormers) {
    const w = _dormerWindow(d)
    if (!w) continue
    const cut = new Brush(w.recess, dummyMats)
    cut.updateMatrixWorld()
    try {
      const next = _csg.evaluate(acc, cut, SUBTRACTION) as Brush
      _remapToSlots(next)
      acc.geometry.dispose()
      acc = next
      glass.push({ verts: w.glass, slot: SLOT_GLASS })
    } catch (e) {
      console.warn('shell-preview: dormer window cut failed', e)
    }
    cut.geometry.dispose()
  }
  // The dormer body's bottom plate sits inside the house below the slope;
  // from a room it read as a floating ceiling. Drop it (the body only needed
  // it closed for the union).
  let out = _dropFaces(acc.geometry, (a, b, c) =>
    shape.dormers.some(
      (d) =>
        Math.abs(a[1] - d.zBase) < 1e-4 && Math.abs(b[1] - d.zBase) < 1e-4 && Math.abs(c[1] - d.zBase) < 1e-4,
    ),
  )
  if (out !== acc.geometry) acc.geometry.dispose()
  _normaliseFacing(out)
  // Ceiling inside each dormer. The union swallows the trim slab's bottom
  // and the body's own roof (both inside one another), leaving only slates
  // seen from behind — sky from the room. Add each roof plane's underside,
  // ROOF_UNDERSIDE_M down, where the dormer roof stands above the main
  // slope (behind that it's buried in the main roof).
  for (const d of shape.dormers) {
    const rel = (p: V3) => {
      const rx = p[0] - d.anchor[0]
      const rz = p[2] - d.anchor[1]
      return rx * d.inwardUnit[0] + rz * d.inwardUnit[1]
    }
    for (const top of _dormerRoofTop(d)) {
      const kept = _clipHalf(top, (p) => p[1] - (d.zFront + d.tanParent * rel(p)))
      if (kept.length < 3) continue
      glass.push({
        verts: kept.map((p) => [p[0], p[1] - ROOF_UNDERSIDE_M, p[2]] as V3).reverse(),
        slot: SLOT_SOFFIT,
      })
    }
  }
  if (glass.length) {
    const merged = _appendGeometry(ensureGroupCoverage(out), _facesToGeometry(glass))
    out.dispose()
    out = merged
  }
  out.computeVertexNormals()
  return out
}

/**
 * Where a dormer has its own ceiling (between its cheeks, from its front
 * back to where its roof dips under the main slope), as a vertical convex
 * volume. The main roof's underside is cut away there; everywhere else —
 * behind the valley line too — it stays.
 */
function _dormerCeilingVolume(d: ResolvedDormer): ClipVolume {
  const e = d.eaveUnit
  const i = d.inwardUnit
  const a = d.anchor
  const vol: ClipVolume = [
    // |w| <= halfW
    { n: [e[0], 0, e[1]], p: [a[0] - e[0] * d.halfW, 0, a[1] - e[1] * d.halfW], eps: 0.001 },
    { n: [-e[0], 0, -e[1]], p: [a[0] + e[0] * d.halfW, 0, a[1] + e[1] * d.halfW], eps: 0.001 },
    // dd >= 0 (behind the front face)
    { n: [i[0], 0, i[1]], p: [a[0], 0, a[1]], eps: 0.001 },
  ]
  // Each dormer roof plane above the parent slope: yP(x,z) - parent(x,z) >= 0,
  // a vertical plane in plan.
  for (const top of _dormerRoofTop(d)) {
    const n = _faceNormal(top)
    if (Math.abs(n[1]) < 1e-9) continue
    const p0 = top[0]!
    // yP = p0y - (nx (x-x0) + nz (z-z0)) / ny ; parent = zFront + tanParent * dd
    const gx = -n[0] / n[1] - d.tanParent * i[0]
    const gz = -n[2] / n[1] - d.tanParent * i[1]
    const c0 = p0[1] + (n[0] * p0[0] + n[2] * p0[2]) / n[1] - d.zFront + d.tanParent * (i[0] * a[0] + i[1] * a[1])
    // f(x,z) = gx x + gz z + c0 >= 0  ->  plane through any point with f = 0
    const L = Math.hypot(gx, gz)
    if (L < 1e-9) continue
    const px = (-c0 * gx) / (L * L)
    const pz = (-c0 * gz) / (L * L)
    vol.push({ n: [gx / L, 0, gz / L], p: [px, 0, pz], eps: 0.001 })
  }
  return vol
}

/** The dormer's roof planes (outward-facing polygons, local frame) — the
 *  same points _buildDormerGeometry uses. */
function _dormerRoofTop(d: ResolvedDormer): V3[][] {
  const { anchor, eaveUnit, inwardUnit, halfW, cheekD, rZ, zEaveD } = d
  const at = (offW: number, offD: number, y: number): V3 => [
    anchor[0] + offW * eaveUnit[0] + offD * inwardUnit[0],
    y,
    anchor[1] + offW * eaveUnit[1] + offD * inwardUnit[1],
  ]
  if (d.type === 'shed') {
    const zBack = rZ + d.tanShed * cheekD
    return [[at(-halfW, 0, rZ), at(halfW, 0, rZ), at(halfW, cheekD, zBack), at(-halfW, cheekD, zBack)]]
  }
  const TLf = at(-halfW, 0, zEaveD)
  const TRf = at(halfW, 0, zEaveD)
  const TLb = at(-halfW, cheekD, zEaveD)
  const TRb = at(halfW, cheekD, zEaveD)
  const APb = at(0, cheekD, rZ)
  if (d.type === 'hip') {
    const d0 = Math.min(cheekD * 0.9, (rZ - zEaveD) / d.tanParent)
    const APf = at(0, d0, rZ)
    return [
      [TRf, APf, TLf],
      [TLf, APf, APb, TLb],
      [TRf, TRb, APb, APf],
    ]
  }
  const APf = at(0, 0, rZ)
  return [
    [TLf, APf, APb, TLb],
    [TRf, TRb, APb, APf],
  ]
}

/**
 * One roof plane of a dormer as a closed trim slab: the plane stretched
 * DORMER_EAVE_OH past the cheeks and DORMER_FRONT_OH past the front (along
 * the plane itself), lifted DORMER_ROOF_LIFT, DORMER_ROOF_T thick. Top =
 * slate, bottom = soffit, edges = fascia / barge boards.
 */
function _dormerRoofSlab(d: ResolvedDormer, top: V3[]): THREE.BufferGeometry | null {
  const n = _faceNormal(top)
  if (Math.abs(n[1]) < 1e-6) return null
  const p0 = top[0]!
  const yOn = (x: number, z: number) => p0[1] - (n[0] * (x - p0[0]) + n[2] * (z - p0[2])) / n[1]
  // A hip's front corner belongs to the front plane AND a side plane. Push
  // the front out by the run that drops the same height as the side eave's
  // overhang, so the corner lands on both planes and the slabs meet along
  // the hip line (independent offsets left a step: "weird shape",
  // operator 2026-09-26). Gable/shed fronts carry no second plane there.
  let frontOH = DORMER_FRONT_OH
  if (d.type === 'hip') {
    const rise = d.rZ - d.zEaveD
    const d0 = Math.min(d.cheekD * 0.9, rise / d.tanParent)
    const tanSide = rise / Math.max(1e-6, d.halfW)
    const tanFront = rise / Math.max(1e-6, d0)
    frontOH = (DORMER_EAVE_OH * tanSide) / Math.max(1e-6, tanFront)
  }
  const moved: V3[] = top.map((p) => {
    const rx = p[0] - d.anchor[0]
    const rz = p[2] - d.anchor[1]
    let w = rx * d.eaveUnit[0] + rz * d.eaveUnit[1]
    let dd = rx * d.inwardUnit[0] + rz * d.inwardUnit[1]
    if (Math.abs(Math.abs(w) - d.halfW) < 1e-6) w += Math.sign(w) * DORMER_EAVE_OH
    if (Math.abs(dd) < 1e-6) dd = -frontOH
    const x = d.anchor[0] + w * d.eaveUnit[0] + dd * d.inwardUnit[0]
    const z = d.anchor[1] + w * d.eaveUnit[1] + dd * d.inwardUnit[1]
    return [x, yOn(x, z), z]
  })
  const up = moved.map((p) => [p[0], p[1] + DORMER_ROOF_LIFT, p[2]] as V3)
  const dn = moved.map((p) => [p[0], p[1] + DORMER_ROOF_LIFT - DORMER_ROOF_T, p[2]] as V3)
  const faces: { verts: V3[]; slot: number }[] = [
    { verts: up, slot: 0 },
    { verts: [...dn].reverse(), slot: 0 },
  ]
  for (let i = 0; i < up.length; i++) {
    const j = (i + 1) % up.length
    faces.push({ verts: [dn[i]!, dn[j]!, up[j]!, up[i]!], slot: 0 })
  }
  const g = _closedOutward(faces)
  // Slot by facing, now that every face points out.
  g.clearGroups()
  let k = 0
  for (const f of faces) {
    const fn = _faceNormal(f.verts)
    const L = Math.hypot(fn[0], fn[1], fn[2]) || 1
    const ny = fn[1] / L
    const slot = ny > 0.3 ? SLOT_SLATE_TOP : ny < -0.3 ? SLOT_SOFFIT : SLOT_FASCIA
    const tris = (f.verts.length - 2) * 3
    g.addGroup(k, tris, slot)
    k += tris
  }
  return g
}

/**
 * Slates face up and sloped soffits face down, by definition. The CSG
 * occasionally hands back a triangle wound the other way where coplanar
 * pieces meet (seen at a dormer's front, under the barge board); the
 * render sorts faces by facing, so a flipped soffit would come out slated.
 * Swap the winding of any such triangle in place. The flat interior cap
 * (a soffit facing up, hidden) is left alone.
 */
function _normaliseFacing(geom: THREE.BufferGeometry): void {
  const pos = geom.getAttribute('position') as THREE.BufferAttribute
  const idx = geom.getIndex()
  if (!pos || !idx) return
  const v = (i: number): V3 => [pos.getX(i), pos.getY(i), pos.getZ(i)]
  for (const g of geom.groups) {
    const slot = g.materialIndex ?? 0
    if (slot !== SLOT_SLATE_TOP && slot !== SLOT_SOFFIT) continue
    for (let k = g.start; k < g.start + g.count; k += 3) {
      const a = v(idx.getX(k))
      const b = v(idx.getX(k + 1))
      const c = v(idx.getX(k + 2))
      const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2]
      const wx = c[0] - a[0], wy = c[1] - a[1], wz = c[2] - a[2]
      const nx = uy * wz - uz * wy
      const ny = uz * wx - ux * wz
      const nz = ux * wy - uy * wx
      const L = Math.hypot(nx, ny, nz)
      if (L < 1e-12) continue
      const t = ny / L
      const wrong = slot === SLOT_SLATE_TOP ? t < -0.05 : t > 0.05 && t < 0.99
      if (!wrong) continue
      const i1 = idx.getX(k + 1)
      idx.setX(k + 1, idx.getX(k + 2))
      idx.setX(k + 2, i1)
    }
  }
  idx.needsUpdate = true
}

/** Copy of geom without the triangles pred() matches (returns geom itself
 *  when nothing matched). */
function _dropFaces(geom: THREE.BufferGeometry, pred: (a: V3, b: V3, c: V3) => boolean): THREE.BufferGeometry {
  const pos = geom.getAttribute('position') as THREE.BufferAttribute
  const idx = geom.getIndex()
  const vert = (i: number): V3 => [pos.getX(i), pos.getY(i), pos.getZ(i)]
  const faces: { verts: V3[]; slot: number }[] = []
  let dropped = 0
  const groups = geom.groups.length ? geom.groups : [{ start: 0, count: idx ? idx.count : pos.count, materialIndex: 0 }]
  for (const g of groups) {
    for (let k = g.start; k < g.start + g.count; k += 3) {
      const t = [0, 1, 2].map((o) => vert(idx ? idx.getX(k + o) : k + o))
      if (pred(t[0]!, t[1]!, t[2]!)) {
        dropped++
        continue
      }
      faces.push({ verts: [...t].reverse(), slot: g.materialIndex ?? 0 })
    }
  }
  if (!dropped) return geom
  return ensureGroupCoverage(_facesToGeometry(faces))
}

/** Recess reveal depth and the wall kept around a dormer window. */
const DORMER_WIN_DEPTH = 0.08
const DORMER_WIN_SIDE = 0.15
const DORMER_WIN_SILL = 0.15
/** Below the dormer roof plane: the trim slab's underside (0.09) + margin. */
const DORMER_WIN_HEAD = 0.15
/** Default window when the operator hasn't sized it (clamped to fit). */
const DORMER_WIN_W = 1.2
const DORMER_WIN_H = 1.0
const DORMER_WIN_MIN = 0.3

/**
 * The window of a free dormer: the part of its front face that stands
 * clear of the main slope (from zFront up to the dormer eave, or the
 * shed roof edge), less a margin of wall all round. Returns the recess
 * solid to subtract and the glass quad (outward-facing) at its back, or
 * null when the front is too small for a window.
 */
function _dormerWindow(d: ResolvedDormer): { recess: THREE.BufferGeometry; glass: V3[] } | null {
  const req = d.win ?? {}
  // Width: requested (default DORMER_WIN_W), keeping DORMER_WIN_SIDE of wall
  // each side.
  const maxHalf = d.halfW - DORMER_WIN_SIDE
  const halfW = Math.min(maxHalf, Math.max(DORMER_WIN_MIN, req.w ?? DORMER_WIN_W) / 2)
  // Top of the front at the window's side edges, less a margin that clears
  // the trim slab's underside. A gable front rises into its triangle.
  const rise = d.rZ - d.zEaveD
  const topAtEdge =
    d.type === 'shed'
      ? d.rZ
      : d.type === 'gable'
        ? d.zEaveD + rise * Math.max(0, 1 - halfW / d.halfW)
        : d.zEaveD
  const head0 = topAtEdge - DORMER_WIN_HEAD
  const sill = d.zFront + Math.max(0.05, req.sill ?? DORMER_WIN_SILL)
  const head = Math.min(head0, sill + Math.max(DORMER_WIN_MIN, req.h ?? DORMER_WIN_H))
  if (head - sill < DORMER_WIN_MIN || halfW * 2 < DORMER_WIN_MIN) return null
  const at = (offW: number, offD: number, y: number): V3 => [
    d.anchor[0] + offW * d.eaveUnit[0] + offD * d.inwardUnit[0],
    y,
    d.anchor[1] + offW * d.eaveUnit[1] + offD * d.inwardUnit[1],
  ]
  // Box from 0.1 m in front of the face to DORMER_WIN_DEPTH behind it.
  const f0 = -0.1
  const f1 = DORMER_WIN_DEPTH
  const c = (w: number, dd: number, y: number) => at(w, dd, y)
  const L0 = c(-halfW, f0, sill), R0 = c(halfW, f0, sill), R0t = c(halfW, f0, head), L0t = c(-halfW, f0, head)
  const L1 = c(-halfW, f1, sill), R1 = c(halfW, f1, sill), R1t = c(halfW, f1, head), L1t = c(-halfW, f1, head)
  const faces: { verts: V3[]; slot: number }[] = [
    { verts: [L0, R0, R0t, L0t], slot: SLOT_WALL_EXTERIOR },
    { verts: [R1, L1, L1t, R1t], slot: SLOT_WALL_EXTERIOR },
    { verts: [L1, L0, L0t, L1t], slot: SLOT_WALL_EXTERIOR },
    { verts: [R0, R1, R1t, R0t], slot: SLOT_WALL_EXTERIOR },
    { verts: [L0t, R0t, R1t, L1t], slot: SLOT_WALL_EXTERIOR },
    { verts: [L1, R1, R0, L0], slot: SLOT_WALL_EXTERIOR },
  ]
  const recess = _closedOutward(faces)
  // Glass at the back of the recess, facing out of the dormer front.
  const gd = DORMER_WIN_DEPTH - 0.01
  let pane: V3[] = [c(-halfW, gd, sill), c(halfW, gd, sill), c(halfW, gd, head), c(-halfW, gd, head)]
  const n = _faceNormal(pane)
  if (n[0] * -d.inwardUnit[0] + n[2] * -d.inwardUnit[1] < 0) pane = pane.reverse()
  return { recess, glass: pane }
}

/** Faces of a convex closed solid -> geometry with every face turned to
 *  point away from the centroid (orientation-proof for CSG). */
function _closedOutward(faces: { verts: V3[]; slot: number }[]): THREE.BufferGeometry {
  let cx = 0
  let cy = 0
  let cz = 0
  let k = 0
  for (const f of faces) for (const p of f.verts) {
    cx += p[0]
    cy += p[1]
    cz += p[2]
    k++
  }
  cx /= k
  cy /= k
  cz /= k
  for (const f of faces) {
    const n = _faceNormal(f.verts)
    const p = f.verts[0]!
    if (n[0] * (p[0] - cx) + n[1] * (p[1] - cy) + n[2] * (p[2] - cz) < 0) f.verts.reverse()
  }
  return _facesToGeometry(faces)
}

/** a + b as one indexed geometry, groups carried over. */
function _appendGeometry(a: THREE.BufferGeometry, b: THREE.BufferGeometry): THREE.BufferGeometry {
  const pos: number[] = []
  const idx: number[] = []
  const groups: { start: number; count: number; slot: number }[] = []
  let base = 0
  for (const g of [a, b]) {
    const p = g.getAttribute('position') as THREE.BufferAttribute
    const ix = g.getIndex()
    if (!p) continue
    for (let i = 0; i < p.count; i++) pos.push(p.getX(i), p.getY(i), p.getZ(i))
    const n = ix ? ix.count : p.count
    const start = idx.length
    for (let i = 0; i < n; i++) idx.push((ix ? ix.getX(i) : i) + base)
    const gs = g.groups.length ? g.groups : [{ start: 0, count: n, materialIndex: 0 }]
    for (const gr of gs) groups.push({ start: start + gr.start, count: gr.count, slot: gr.materialIndex ?? 0 })
    base += p.count
  }
  const out = new THREE.BufferGeometry()
  out.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
  out.setIndex(idx)
  for (const g of groups) out.addGroup(g.start, g.count, g.slot)
  return out
}

/**
 * Dormer solid in the segment's local frame. Every type stands on VERTICAL
 * cheek walls that start below the main slope and run inward until the main
 * roof swallows them, so the union cuts a real dormer out of the slope.
 */
function _buildDormerGeometry(d: ResolvedDormer): THREE.BufferGeometry | null {
  const { anchor, eaveUnit, inwardUnit, halfW, cheekD, rZ, zEaveD, zBase } = d
  const at = (offW: number, offD: number, y: number): V3 => [
    anchor[0] + offW * eaveUnit[0] + offD * inwardUnit[0],
    y,
    anchor[1] + offW * eaveUnit[1] + offD * inwardUnit[1],
  ]
  const BLf = at(-halfW, 0, zBase)
  const BRf = at(halfW, 0, zBase)
  const BLb = at(-halfW, cheekD, zBase)
  const BRb = at(halfW, cheekD, zBase)

  if (d.type === 'shed') {
    // Front wall up to the shed's eave (rZ); the roof then RISES inward at a
    // third of the main pitch until the main slope overtakes it — low at the
    // front, so it drains forward. (Until 2026-09-26 it fell backward into
    // the main roof: a wedge that read as a chimney, draining into the house.)
    const zBack = rZ + d.tanShed * cheekD
    const TLf = at(-halfW, 0, rZ)
    const TRf = at(halfW, 0, rZ)
    const TLb = at(-halfW, cheekD, zBack)
    const TRb = at(halfW, cheekD, zBack)
    return _facesToGeometry([
      { verts: [BLf, BRf, TRf, TLf], slot: SLOT_WALL_EXTERIOR }, // front
      { verts: [BLb, TLb, TRb, BRb], slot: SLOT_WALL_EXTERIOR }, // back (buried)
      { verts: [BLf, TLf, TLb, BLb], slot: SLOT_WALL_EXTERIOR }, // left cheek
      { verts: [BRf, BRb, TRb, TRf], slot: SLOT_WALL_EXTERIOR }, // right cheek
      { verts: [TLf, TRf, TRb, TLb], slot: SLOT_SLATE_TOP }, // roof
      { verts: [BLf, BLb, BRb, BRf], slot: SLOT_SOFFIT }, // bottom
    ])
  }

  const TLf = at(-halfW, 0, zEaveD)
  const TRf = at(halfW, 0, zEaveD)
  const TLb = at(-halfW, cheekD, zEaveD)
  const TRb = at(halfW, cheekD, zEaveD)
  const APb = at(0, cheekD, rZ)

  if (d.type === 'hip') {
    // Cheeks and a front wall up to the dormer eave; the roof hips back at
    // the parent pitch to a ridge that runs into the main roof.
    const d0 = Math.min(cheekD * 0.9, (rZ - zEaveD) / d.tanParent)
    const APf = at(0, d0, rZ)
    return _facesToGeometry([
      { verts: [BLf, BRf, TRf, TLf], slot: SLOT_WALL_EXTERIOR }, // front wall
      { verts: [TRf, APf, TLf], slot: SLOT_SLATE_TOP }, // front hip
      { verts: [BLb, TLb, APb, TRb, BRb], slot: SLOT_WALL_EXTERIOR }, // back (buried)
      { verts: [BLf, TLf, TLb, BLb], slot: SLOT_WALL_EXTERIOR }, // left cheek
      { verts: [BRf, BRb, TRb, TRf], slot: SLOT_WALL_EXTERIOR }, // right cheek
      { verts: [TLf, APf, APb, TLb], slot: SLOT_SLATE_TOP }, // left roof
      { verts: [TRf, TRb, APb, APf], slot: SLOT_SLATE_TOP }, // right roof
      { verts: [BLf, BLb, BRb, BRf], slot: SLOT_SOFFIT }, // bottom
    ])
  }

  // Gable: house-shaped profile — vertical cheeks, gable on top.
  const APf = at(0, 0, rZ)
  return _facesToGeometry([
    { verts: [BLf, BRf, TRf, APf, TLf], slot: SLOT_WALL_EXTERIOR }, // front
    { verts: [BLb, TLb, APb, TRb, BRb], slot: SLOT_WALL_EXTERIOR }, // back (buried)
    { verts: [BLf, TLf, TLb, BLb], slot: SLOT_WALL_EXTERIOR }, // left cheek
    { verts: [BRf, BRb, TRb, TRf], slot: SLOT_WALL_EXTERIOR }, // right cheek
    { verts: [TLf, APf, APb, TLb], slot: SLOT_SLATE_TOP }, // left roof
    { verts: [TRf, TRb, APb, APf], slot: SLOT_SLATE_TOP }, // right roof
    { verts: [BLf, BLb, BRb, BRf], slot: SLOT_SOFFIT }, // bottom
  ])
}

// ─── Common geometry helpers ─────────────────────────────────────

function _facesToGeometry(faces: { verts: V3[]; slot: number }[]): THREE.BufferGeometry {
  const positions: number[] = []
  const normals: number[] = []
  const indices: number[] = []
  const groups: { start: number; count: number; slot: number }[] = []
  let vertCount = 0
  for (const face of faces) {
    if (face.verts.length < 3) continue
    // Reverse winding once so faces written in their natural walk order
    // come out with OUTWARD normals (verified by triangle-facing audit).
    const verts = [...face.verts].reverse()
    const p0 = new THREE.Vector3(...verts[0]!)
    const p1 = new THREE.Vector3(...verts[1]!)
    const p2 = new THREE.Vector3(...verts[2]!)
    const n = new THREE.Vector3()
      .subVectors(p1, p0)
      .cross(new THREE.Vector3().subVectors(p2, p0))
      .normalize()
    const start = vertCount
    let count = 0
    for (let i = 1; i < verts.length - 1; i++) {
      const a = verts[0]!
      const b = verts[i]!
      const c = verts[i + 1]!
      positions.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2])
      normals.push(n.x, n.y, n.z, n.x, n.y, n.z, n.x, n.y, n.z)
      indices.push(vertCount, vertCount + 1, vertCount + 2)
      vertCount += 3
      count += 3
    }
    groups.push({ start, count, slot: face.slot })
  }
  const geom = new THREE.BufferGeometry()
  geom.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  geom.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3))
  geom.setIndex(indices)
  for (const g of groups) geom.addGroup(g.start, g.count, g.slot)
  return geom
}

// roofMaterials has four entries; a group past that makes material[idx]
// undefined and both stock and BVH raycast throw. Clamp every slot.
const MAX_SLOT = 4

/**
 * Ensure a geometry's groups tile its ENTIRE index buffer with in-range
 * materialIndex values. three-mesh-bvh resolves a hit's material through the
 * group containing its face; a triangle in no group throws on every pointer
 * move. CSG results can come back with no groups at all.
 */
export function ensureGroupCoverage(geom: THREE.BufferGeometry): THREE.BufferGeometry {
  const idx = geom.getIndex()
  const total = idx ? idx.count : (geom.getAttribute('position')?.count ?? 0)
  if (total === 0) {
    geom.clearGroups()
    return geom
  }
  const src = (geom.groups ?? [])
    .filter((g) => g.count > 0)
    .map((g) => ({
      start: g.start,
      count: g.count,
      slot: Math.min(MAX_SLOT, Math.max(0, g.materialIndex ?? 0)),
    }))
    .sort((a, b) => a.start - b.start)
  const patched: typeof src = []
  let cursor = 0
  for (const g of src) {
    if (g.start > cursor) patched.push({ start: cursor, count: g.start - cursor, slot: 0 })
    patched.push(g)
    cursor = Math.max(cursor, g.start + g.count)
  }
  if (cursor < total) patched.push({ start: cursor, count: total - cursor, slot: 0 })
  geom.clearGroups()
  for (const g of patched) geom.addGroup(g.start, g.count, g.slot)
  return geom
}
