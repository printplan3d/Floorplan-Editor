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
import { ADDITION, Brush, Evaluator } from 'three-bvh-csg'
import type { RoofSegmentNode } from '../../schema'

// ─── Constants ────────────────────────────────────────────────────
const MIN_EDGE_WEIGHT = 0.01 // shell/skeleton/constants.py
const NEAR_VERTICAL_TAN = 100.0 // "vertical" gable edge

/** Fascia board depth — backend DEFAULT_FASCIA_THICKNESS_M (shell.py). */
const FASCIA_M = 0.18
/** How far past its footprint a roof still counts as covering a point, so
 *  walls standing ON the roof edge line are trimmed. Half a wall + margin. */
const COVER_BUFFER = 0.15

// three-bvh-csg needs materials to union brushes; dummies here, and
// roof-system's material mapper picks real ones by slot.
const dummyMats: [THREE.Material, THREE.Material, THREE.Material, THREE.Material] = [
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
  infillFloor: number
  clipVolumes: ClipVolume[]
  dormers: ResolvedDormer[]
}

// ─── Public entry points ──────────────────────────────────────────

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
  const raw = _resolvePolygon(node)
  if (raw.length !== 4) return null

  const xs = raw.map((p) => p[0])
  const zs = raw.map((p) => p[1])
  let xMin = Math.min(...xs)
  let xMax = Math.max(...xs)
  let zMin = Math.min(...zs)
  let zMax = Math.max(...zs)
  if (!(xMax > xMin && zMax > zMin)) return null

  const baseStyles = _resolveEdgeStyles(node, raw)
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
  // Continuation: share the neighbour's side lines.
  if (opts.sideLo != null && opts.sideHi != null && opts.sideHi - opts.sideLo > 0.4) {
    if (ridgeAlongX) {
      zMin = opts.sideLo
      zMax = opts.sideHi
    } else {
      xMin = opts.sideLo
      xMax = opts.sideHi
    }
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
    infillFloor: Math.min(0, Number.isFinite(opts.infillFloor) ? opts.infillFloor! : 0),
    clipVolumes: opts.clipVolumes ?? [],
    dormers: [],
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
export function shellVolumeLocal(shape: ShellShape): ClipVolume {
  const f = shape.frame
  const poly = shape.polygon
  const vol: ClipVolume = []
  for (let i = 0; i < 4; i++) {
    const a = poly[i]!
    const b = poly[(i + 1) % 4]!
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1
    const m: V2 = [-(b[1] - a[1]) / L, (b[0] - a[0]) / L] // inward (CCW in x/z as used by the infill)
    vol.push({ n: [m[0], 0, m[1]], p: [a[0], 0, a[1]], eps: 0.01 })
    const sloped = i === f.eSideLo || i === f.eSideHi || shape.styles[i] === 'hip'
    if (sloped) {
      // y <= eave_i + tan_i * d  ->  tan_i*d - y + eave_i >= 0
      const t = f.tanOf[i]!
      const e = f.eaveOf[i]!
      const k = Math.hypot(t, 1)
      vol.push({ n: [(t * m[0]) / k, -1 / k, (t * m[1]) / k], p: [a[0], e, a[1]], eps: -0.005 })
    }
  }
  vol.push({ n: [0, 1, 0], p: [0, shape.infillFloor, 0], eps: 0.01 })
  return vol
}

/**
 * Roof surface height (local Y) above local point (x, z), or null when this
 * segment doesn't cover it. Dormers count: the result is the higher of the
 * main slope and any dormer standing there.
 */
export function shellHeightAtLocal(shape: ShellShape, x: number, z: number): number | null {
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
    best = h
  }
  for (const d of shape.dormers) {
    const dh = _dormerHeightAt(d, x, z)
    if (dh != null && (best == null || dh > best)) best = dh
  }
  return best
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
  const axis = node.ridgeAxis
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
  const eLoO = eLo - tanOf[f.eSideLo]! * oh
  const eHiO = eHi - tanOf[f.eSideHi]! * oh
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
  const vLoO = vMin - oh
  const vHiO = vMax + oh
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
    add([P(uLoO, eLoO - F, vMin), P(uHiO, eLoO - F, vMin), down(E_hl), down(E_ll)], SLOT_SOFFIT)
    add([P(uHiO, eHiO - F, vMax), P(uLoO, eHiO - F, vMax), down(E_lh), down(E_hh)], SLOT_SOFFIT)
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
  const rh = Math.max(0.2, ov ? ov.ridgeHeight : spec.ridgeHeight)
  const halfW = cheekWidth / 2

  const tanParent = Math.max(MIN_EDGE_WEIGHT, f.tanOf[idx]!)
  const eaveParent = f.eaveOf[idx]!
  const tanShed = tanParent / 3
  // Run over which the main roof climbs back up to meet the dormer's roof.
  const runToBury = spec.type === 'shed' ? rh / (tanParent + tanShed) : rh / tanParent

  // Run from this edge in to the ridge: the half-span for a side edge, the
  // hip inset for a hip end.
  const run =
    idx === f.eSideLo || idx === f.eSideHi
      ? f.halfSpan
      : idx === f.eEndLo
        ? f.rLoU - f.uMin
        : f.uMax - f.rHiU
  // Free dormers: V maps across the usable run so the ridge stays under the
  // main ridge. Window-following dormers: the window's wall decides.
  const maxInward = Math.max(0, run - runToBury)
  const inward = ov ? Math.max(0, ov.inward) : Math.min(Math.max(vMid, 0), 1) * maxInward

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
    forwardCover: ov ? inward + 0.05 : 0.05,
  }
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
  if (d.type === 'shed') return d.rZ - d.tanShed * Math.max(0, dep)
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
  const out = acc.geometry
  out.computeVertexNormals()
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
    // Front wall up to rZ, single shallow slope running back into the roof.
    const zBack = rZ - d.tanShed * cheekD
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
const MAX_SLOT = 3

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
