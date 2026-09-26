/**
 * Scene-level roof resolution — everything about a roof that depends on
 * OTHER nodes, as pure functions of the node graph.
 *
 * shell-preview.ts builds one segment in isolation. This file decides, for
 * every segment, the options that make segments work together and with the
 * walls under them:
 *
 *   - JUNCTIONS. Where one roof's ridge runs into another roof (an L or T
 *     wing, a small bay, or two masses continuing one ridge) the secondary's
 *     buried end is moved — cut back or EXTENDED — to exactly where its ridge
 *     meets the primary roof, and made open. Continuation seams open both
 *     ends. Ridges of comparable wings are LEVEL-matched by default (the
 *     narrower wing gets steeper); a small wing keeps its own pitch and its
 *     ridge dies into the main slope. `ridgeMatch` on a segment overrides.
 *   - REAL WALLS AS PARAPET. A wall standing on (or just inside) an edge line
 *     is the parapet / gable there, so the shell only draws infill above its
 *     top — otherwise the generated band stands in front of the real wall and
 *     hides its windows.
 *   - DORMERS THAT FOLLOW A WINDOW. The dormer's front goes on the window's
 *     wall, centred on the window, sized to clear it.
 *   - A HEIGHT FIELD over the whole scene (highest roof above any world XZ),
 *     used to trim walls to the roof and hide windows the roof covers.
 *
 * Everything is pure over `nodes`, so it can be tested off-browser against a
 * real plan — see the check scripts described in the commit that added it.
 */
import type { AnyNode, RoofNode, RoofSegmentNode, WallNode } from '../../schema'
import {
  type DormerOverride,
  type RealWallSpan,
  type ClipVolume,
  shellVolumeLocal,
  ridgeAngleRad,
  resolveShellShape,
  type ShellBuildOptions,
  type ShellShape,
  shellEdgeLocal,
  shellHeightAtLocal,
  shellSlopedEdges,
} from './shell-preview'

type Nodes = Record<string, AnyNode | undefined>
type V2 = [number, number]

const DEFAULT_LEVEL_HEIGHT = 2.5
/** Wings narrower than this fraction of the roof they join keep their own
 *  pitch (dropped ridge) unless told otherwise. */
const LEVEL_MATCH_MIN_SPAN_RATIO = 0.6
/** Ridges this close to parallel, and this close laterally, are one ridge. */
const PARALLEL_SIN = Math.sin((10 * Math.PI) / 180)
const CONTINUATION_LATERAL = 0.5
/** A real wall within this distance of an edge line counts as standing on it. */
const WALL_ON_EDGE = 0.5
/** Continuation seams stay open only if both roofs' eaves agree this well;
 *  otherwise each side gets a closed step wall. */
const SEAM_PROFILE_TOL = 0.2
/** Auto ridge matching snaps ridges that are this close; further apart
 *  they keep their own heights. */
const LEVEL_SNAP_M = 0.15

export type RidgeMatch = 'level' | 'pitch' | 'independent'

export type SegmentPlacement = {
  seg: RoofSegmentNode
  roof: RoofNode
  levelId: string | null
  /** world(x, z) = T + R(theta) * local(x, z), three.js rotation.y convention. */
  cos: number
  sin: number
  tx: number
  tz: number
  /** World Y of the segment's local y = 0 (the storey wall top, plus any
   *  Y offset on the roof or segment). */
  baseY: number
  /** Local Y of the storey wall top (<= 0 when the segment is lifted). */
  floorY: number
}

export type ResolvedSegment = {
  placement: SegmentPlacement
  opts: ShellBuildOptions
  shape: ShellShape
  /** Which neighbour this wing was matched/joined to, for the panel. */
  joinedTo?: string
  ridgeMatchApplied?: RidgeMatch
}

export type RoofContext = {
  segments: Map<string, ResolvedSegment>
  levels: Map<string, { elev: number; height: number }>
  /** Highest roof surface above world (x, z), or null if nothing covers it. */
  heightAt: (x: number, z: number) => number | null
}

// ─── Levels ───────────────────────────────────────────────────────

/**
 * Elevation and height of each level. Height mirrors the viewer's
 * getLevelHeight (tallest wall or ceiling on the level) minus its slab-Y
 * term, which needs the live scene.
 */
export function levelStack(nodes: Nodes): Map<string, { elev: number; height: number }> {
  const levels = Object.values(nodes)
    .filter((n): n is AnyNode => !!n && n.type === 'level')
    .sort((a, b) => ((a as { level?: number }).level ?? 0) - ((b as { level?: number }).level ?? 0))
  const out = new Map<string, { elev: number; height: number }>()
  let elev = 0
  for (const lvl of levels) {
    let top = 0
    for (const cid of (lvl as { children?: string[] }).children ?? []) {
      const c = nodes[cid]
      if (!c) continue
      if (c.type === 'wall' || c.type === 'ceiling') {
        const h = (c as { height?: number }).height ?? DEFAULT_LEVEL_HEIGHT
        if (h > top) top = h
      }
    }
    const height = top > 0 ? top : DEFAULT_LEVEL_HEIGHT
    out.set(lvl.id, { elev, height })
    elev += height
  }
  return out
}

// ─── Transforms ───────────────────────────────────────────────────

function toWorld(p: SegmentPlacement, x: number, z: number): V2 {
  return [p.tx + p.cos * x + p.sin * z, p.tz - p.sin * x + p.cos * z]
}
function toLocal(p: SegmentPlacement, X: number, Z: number): V2 {
  const dx = X - p.tx
  const dz = Z - p.tz
  return [p.cos * dx - p.sin * dz, p.sin * dx + p.cos * dz]
}

export function collectPlacements(nodes: Nodes): SegmentPlacement[] {
  const levels = levelStack(nodes)
  const out: SegmentPlacement[] = []
  for (const n of Object.values(nodes)) {
    if (!n || n.type !== 'roof-segment') continue
    const seg = n as RoofSegmentNode
    const roof = seg.parentId ? (nodes[seg.parentId] as RoofNode | undefined) : undefined
    if (!roof || roof.type !== 'roof') continue
    const levelId = roof.parentId ?? null
    const lv = levelId ? levels.get(levelId) : undefined
    const rp = (roof.position ?? [0, 0, 0]) as number[]
    const sp = (seg.position ?? [0, 0, 0]) as number[]
    const ra = (roof as { rotation?: number }).rotation ?? 0
    const sa = seg.rotation ?? 0
    // The ridge angle turns the frame the roof is built in (shell-preview).
    const theta = ra + sa + ridgeAngleRad(seg)
    const rc = Math.cos(ra)
    const rs = Math.sin(ra)
    out.push({
      seg,
      roof,
      levelId,
      cos: Math.cos(theta),
      sin: Math.sin(theta),
      tx: (rp[0] ?? 0) + rc * (sp[0] ?? 0) + rs * (sp[2] ?? 0),
      tz: (rp[2] ?? 0) - rs * (sp[0] ?? 0) + rc * (sp[2] ?? 0),
      baseY: (lv ? lv.elev + lv.height : 0) + (rp[1] ?? 0) + (sp[1] ?? 0),
      floorY: Math.min(0, -((rp[1] ?? 0) + (sp[1] ?? 0))),
    })
  }
  return out
}

// ─── Shape queries in world space ─────────────────────────────────

function ridgeWorld(p: SegmentPlacement, s: ShellShape): { a: V2; b: V2; dir: V2; y: number } {
  const f = s.frame
  const lo = f.ridgeAlongX ? [f.uMin, f.vMid] : [f.vMid, f.uMin]
  const hi = f.ridgeAlongX ? [f.uMax, f.vMid] : [f.vMid, f.uMax]
  const a = toWorld(p, lo[0]!, lo[1]!)
  const b = toWorld(p, hi[0]!, hi[1]!)
  const L = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1
  return { a, b, dir: [(b[0] - a[0]) / L, (b[1] - a[1]) / L], y: p.baseY + f.ridgeZ }
}

function insideFootprint(p: SegmentPlacement, s: ShellShape, X: number, Z: number, tol: number): boolean {
  const [x, z] = toLocal(p, X, Z)
  const f = s.frame
  const u = f.ridgeAlongX ? x : z
  const v = f.ridgeAlongX ? z : x
  return u >= f.uMin - tol && u <= f.uMax + tol && v >= f.vMin - tol && v <= f.vMax + tol
}

function heightWorld(p: SegmentPlacement, s: ShellShape, X: number, Z: number): number | null {
  const [x, z] = toLocal(p, X, Z)
  const h = shellHeightAtLocal(s, x, z)
  return h == null ? null : p.baseY + h
}

/** Local u (ridge-axis coordinate) of a world point projected on the ridge. */
function localU(p: SegmentPlacement, s: ShellShape, X: number, Z: number): number {
  const [x, z] = toLocal(p, X, Z)
  return s.frame.ridgeAlongX ? x : z
}

function spanOf(s: ShellShape): number {
  return s.frame.vMax - s.frame.vMin
}

function areaOf(s: ShellShape): number {
  return (s.frame.uMax - s.frame.uMin) * spanOf(s)
}

// ─── Resolution ───────────────────────────────────────────────────

export function resolveRoofContext(nodes: Nodes): RoofContext {
  const levels = levelStack(nodes)
  const placements = collectPlacements(nodes)
  const segs = new Map<string, ResolvedSegment>()

  // Pass 0: each segment on its own.
  for (const p of placements) {
    const opts: ShellBuildOptions = p.floorY < 0 ? { infillFloor: p.floorY } : {}
    const shape = resolveShellShape(p.seg, opts)
    if (shape) segs.set(p.seg.id, { placement: p, opts, shape })
  }

  // Order: highest ridge first, then largest footprint, then id.
  const ordered = [...segs.values()].sort((A, B) => {
    const ya = A.placement.baseY + A.shape.frame.ridgeZ
    const yb = B.placement.baseY + B.shape.frame.ridgeZ
    if (Math.abs(ya - yb) > 1e-3) return yb - ya
    const da = areaOf(A.shape)
    const db = areaOf(B.shape)
    if (Math.abs(da - db) > 1e-3) return db - da
    return A.placement.seg.id < B.placement.seg.id ? -1 : 1
  })

  const rebuild = (r: ResolvedSegment) => {
    const s = resolveShellShape(r.placement.seg, r.opts)
    if (s) r.shape = s
  }

  // Pass 1: junctions. Each later (secondary) segment joins at most one
  // earlier (primary) one per end.
  for (let bi = 1; bi < ordered.length; bi++) {
    const B = ordered[bi]!
    for (let ai = 0; ai < bi; ai++) {
      const A = ordered[ai]!
      if (A.placement.levelId !== B.placement.levelId) continue
      _joinPair(A, B, rebuild)
    }
  }

  // Pass 2: real walls. Along each edge, where one stands the generated
  // infill steps aside for it; and if any wall stands under this roof on the
  // level above, drop the flat interior ceiling that would slice that floor.
  const walls = Object.values(nodes).filter((n): n is WallNode => !!n && n.type === 'wall')
  for (const r of segs.values()) {
    const spans = _realWallSpans(r, walls, levels)
    const upper = _hasUpperWalls(r, walls, levels)
    if (spans.length || upper) {
      r.opts = {
        ...r.opts,
        ...(spans.length ? { realWalls: spans } : {}),
        ...(upper ? { noInteriorCap: true } : {}),
      }
      rebuild(r)
    }
  }

  // Pass 3: dormers that follow a window.
  for (const r of segs.values()) {
    const ov = _dormerWindowOverrides(r, nodes, levels)
    if (ov) {
      r.opts = { ...r.opts, dormerOverrides: ov }
      rebuild(r)
    }
  }

  // Pass 4: meeting roofs read as ONE roof. Each segment drops whatever of
  // it lies inside a neighbour on the same level (shapes are final now).
  for (const r of segs.values()) {
    const vols: ClipVolume[] = []
    for (const o of segs.values()) {
      if (o === r || o.placement.levelId !== r.placement.levelId) continue
      if (!_footprintsOverlap(r, o)) continue
      vols.push(_volumeInto(o, r))
    }
    if (vols.length) {
      r.opts = { ...r.opts, clipVolumes: vols }
      rebuild(r)
    }
  }

  const all = [...segs.values()]
  const heightAt = (X: number, Z: number): number | null => {
    let best: number | null = null
    for (const r of all) {
      const h = heightWorld(r.placement, r.shape, X, Z)
      if (h != null && (best == null || h > best)) best = h
    }
    return best
  }
  return { segments: segs, levels, heightAt }
}

function _joinPair(A: ResolvedSegment, B: ResolvedSegment, rebuild: (r: ResolvedSegment) => void) {
  const pa = A.placement
  const pb = B.placement
  const ra = ridgeWorld(pa, A.shape)
  let rb = ridgeWorld(pb, B.shape)

  // Which of B's ends sits inside A? (Only ends not already joined.)
  const bInside = (w: V2) => insideFootprint(pa, A.shape, w[0], w[1], 0.3)
  const loIn = B.opts.truncateLo == null && !B.opts.endLo && bInside(rb.a)
  const hiIn = B.opts.truncateHi == null && !B.opts.endHi && bInside(rb.b)
  if (!loIn && !hiIn) return
  if (loIn && hiIn) return // B wholly inside A along its ridge: nothing sensible to join

  const buriedIsLo = loIn
  // Walk from B's OUTER end toward (and past) the buried end.

  const cross = Math.abs(ra.dir[0] * rb.dir[1] - ra.dir[1] * rb.dir[0])
  const parallel = cross < PARALLEL_SIN

  // Main roof wins at its ends. A crossing wing whose eave runs past A's
  // gable / hip end by up to END_TRIM_MAX is pulled back to that end line,
  // so A's rake and barge board run down clean over the corner (operator
  // 2026-09-26: the bay roof poked 0.12 m past the south gable, under its
  // rake). Done before the join walk: the wing's ridge re-centres.
  if (!parallel) {
    const trim = _endTrim(A, B)
    if (trim) {
      B.opts = { ...B.opts, ...trim }
      rebuild(B)
      rb = ridgeWorld(pb, B.shape)
    }
  }
  const outer = buriedIsLo ? rb.b : rb.a
  const walkDir: V2 = buriedIsLo ? [-rb.dir[0], -rb.dir[1]] : rb.dir

  // Ridge matching.
  // Auto: LEVEL only snaps ridges that are already (nearly) level — a
  // drawing slip, like the operator's 0.134 m step. Anything further apart
  // is the operator's choice of heights: forcing it made changing one
  // roof's height drag its neighbours (operator 2026-09-26). 'level' in
  // the panel still forces it.
  const nearlyLevel =
    Math.abs(ridgeWorld(pb, B.shape).y - ra.y) <= LEVEL_SNAP_M &&
    spanOf(B.shape) >= LEVEL_MATCH_MIN_SPAN_RATIO * spanOf(A.shape)
  const mode: RidgeMatch =
    ((B.placement.seg as { ridgeMatch?: RidgeMatch }).ridgeMatch as RidgeMatch | undefined) ??
    (nearlyLevel ? 'level' : 'independent')
  if (mode === 'level') {
    B.opts = { ...B.opts, ridgeRiseOverride: ra.y - pb.baseY }
  } else if (mode === 'pitch') {
    const f = A.shape.frame
    B.opts = { ...B.opts, uniformTanOverride: (f.tanOf[f.eSideLo]! + f.tanOf[f.eSideHi]!) / 2 }
  }
  if (mode !== 'independent') rebuild(B)
  const HB = ridgeWorld(pb, B.shape).y

  const len = Math.hypot(rb.b[0] - rb.a[0], rb.b[1] - rb.a[1])
  const STEP = 0.02
  const maxWalk = len + 25
  let hit: V2 | null = null

  if (parallel) {
    // Continuation: same ridge line (near enough). Meet at A's end wall.
    const lateral = Math.abs((rb.a[0] - ra.a[0]) * ra.dir[1] - (rb.a[1] - ra.a[1]) * ra.dir[0])
    if (lateral > CONTINUATION_LATERAL) return
    // Share A's side lines when they're close, so the two masses read as
    // one roof: no kink in the ridge or the eaves at the seam.
    const snap = _sideSnap(A, B)
    if (snap) {
      B.opts = { ...B.opts, sideLo: snap[0], sideHi: snap[1] }
      rebuild(B)
    }
    for (let t = 0; t <= maxWalk; t += STEP) {
      const w: V2 = [outer[0] + walkDir[0] * t, outer[1] + walkDir[1] * t]
      if (insideFootprint(pa, A.shape, w[0], w[1], 0)) {
        hit = w
        break
      }
    }
  } else {
    // L / T / bay: meet where A's roof reaches B's ridge height.
    for (let t = 0; t <= maxWalk; t += STEP) {
      const w: V2 = [outer[0] + walkDir[0] * t, outer[1] + walkDir[1] * t]
      if (!insideFootprint(pa, A.shape, w[0], w[1], 0)) continue
      const h = heightWorld(pa, A.shape, w[0], w[1])
      if (h != null && h >= HB - 0.02) {
        hit = w
        break
      }
    }
  }
  if (!hit) return

  const u = localU(pb, B.shape, hit[0], hit[1])
  B.opts = buriedIsLo ? { ...B.opts, truncateLo: u } : { ...B.opts, truncateHi: u }
  B.joinedTo = A.placement.seg.id
  B.ridgeMatchApplied = mode
  rebuild(B)

  if (parallel) {
    // Continuation seam. If both roofs have the same cross-section there,
    // open A's end too and one ridge runs straight through. If they don't
    // (the operator had raised one roof's eaves to 5.54 / 4.23 m while the
    // other's sat at 2.70), open ends leave a hole — so close BOTH sides
    // with a step wall instead.
    const fa = A.shape.frame
    const uA = localU(pa, A.shape, hit[0], hit[1])
    const nearLo = Math.abs(uA - fa.uMin) < Math.abs(uA - fa.uMax)
    const match = _seamProfilesMatch(A, B)
    const style = match ? 'junction' : 'abut'
    A.opts = nearLo ? { ...A.opts, endLo: style } : { ...A.opts, endHi: style }
    rebuild(A)
    if (!match) {
      B.opts = buriedIsLo ? { ...B.opts, endLo: 'abut' } : { ...B.opts, endHi: 'abut' }
      rebuild(B)
    }
  }
}

/** How far past a main roof's end a crossing wing's eave may run and still
 *  be pulled back to it. */
const END_TRIM_MAX = 0.5

/**
 * For a wing B crossing main roof A: if one of B's eave lines runs past
 * one of A's gable/hip end lines (outside A, by at most END_TRIM_MAX), the
 * side override that pulls it back onto that line. B's eaves are parallel
 * to A's ends when their ridges cross.
 */
function _endTrim(
  A: ResolvedSegment,
  B: ResolvedSegment,
): { sideLo?: number; sideHi?: number; sideLoFlush?: boolean; sideHiFlush?: boolean } | null {
  const fa = A.shape.frame
  const fb = B.shape.frame
  const vOf = (w: V2) => {
    const [x, z] = toLocal(B.placement, w[0], w[1])
    return fb.ridgeAlongX ? z : x
  }
  const at = (u: number) => (fa.ridgeAlongX ? toWorld(A.placement, u, fa.vMid) : toWorld(A.placement, fa.vMid, u))
  const vCentreA = vOf(at((fa.uMin + fa.uMax) / 2))
  // The pulled-back eave also loses its overhang: it stops dead on A's end
  // line, under A's rake, instead of hanging 0.3 m past it.
  const out: { sideLo?: number; sideHi?: number; sideLoFlush?: boolean; sideHiFlush?: boolean } = {}
  for (const [u, e] of [
    [fa.uMin, fa.eEndLo],
    [fa.uMax, fa.eEndHi],
  ] as const) {
    const st = A.shape.styles[e]
    if (st !== 'gable' && st !== 'hip') continue
    const vEnd = vOf(at(u))
    if (vEnd < vCentreA) {
      // A lies toward +v from this end: B's low eave may run past it.
      const over = vEnd - fb.vMin
      if (over > 1e-3 && over <= END_TRIM_MAX) {
        out.sideLo = vEnd
        out.sideLoFlush = true
      }
    } else {
      const over = fb.vMax - vEnd
      if (over > 1e-3 && over <= END_TRIM_MAX) {
        out.sideHi = vEnd
        out.sideHiFlush = true
      }
    }
  }
  return out.sideLo != null || out.sideHi != null ? out : null
}

/** A's side (eave) lines expressed in B's local across-ridge coordinate,
 *  if each is within CONTINUATION_LATERAL of B's own. */
function _sideSnap(A: ResolvedSegment, B: ResolvedSegment): [number, number] | null {
  const fa = A.shape.frame
  const fb = B.shape.frame
  const mid = (fa.uMin + fa.uMax) / 2
  const at = (v: number) => (fa.ridgeAlongX ? toWorld(A.placement, mid, v) : toWorld(A.placement, v, mid))
  const vb = (w: V2) => {
    const [x, z] = toLocal(B.placement, w[0], w[1])
    return fb.ridgeAlongX ? z : x
  }
  const s1 = vb(at(fa.vMin))
  const s2 = vb(at(fa.vMax))
  const lo = Math.min(s1, s2)
  const hi = Math.max(s1, s2)
  if (Math.abs(lo - fb.vMin) > CONTINUATION_LATERAL || Math.abs(hi - fb.vMax) > CONTINUATION_LATERAL) return null
  if (Math.abs(lo - fb.vMin) < 1e-4 && Math.abs(hi - fb.vMax) < 1e-4) return null
  return [lo, hi]
}

/** World XZ corners of a segment's wall-line footprint. */
function _cornersWorld(r: ResolvedSegment): V2[] {
  return r.shape.polygon.map(([x, z]) => toWorld(r.placement, x, z))
}

/** Separating-axis test on the two (rotated) rectangles, 5 cm margin. */
function _footprintsOverlap(a: ResolvedSegment, b: ResolvedSegment): boolean {
  const ca = _cornersWorld(a)
  const cb = _cornersWorld(b)
  for (const poly of [ca, cb]) {
    for (let i = 0; i < poly.length; i++) {
      const p = poly[i]!
      const q = poly[(i + 1) % poly.length]!
      const ax: V2 = [-(q[1] - p[1]), q[0] - p[0]]
      const proj = (c: V2[]) => c.map((v) => v[0] * ax[0] + v[1] * ax[1])
      const pa = proj(ca)
      const pb = proj(cb)
      const L = Math.hypot(ax[0], ax[1]) || 1
      if (Math.max(...pa) + 0.05 * L < Math.min(...pb) || Math.max(...pb) + 0.05 * L < Math.min(...pa)) return false
    }
  }
  return true
}

/** Neighbour `o`'s volume, re-expressed in `r`'s local frame. */
function _volumeInto(o: ResolvedSegment, r: ResolvedSegment): ClipVolume {
  const po = o.placement
  const pr = r.placement
  return shellVolumeLocal(o.shape, true).map((h) => {
    // point: o-local -> world -> r-local
    const [wx, wz] = toWorld(po, h.p[0], h.p[2])
    const [lx, lz] = toLocal(pr, wx, wz)
    const y = h.p[1] + po.baseY - pr.baseY
    // normal: rotate o-local -> world -> r-local (no translation)
    const nwx = po.cos * h.n[0] + po.sin * h.n[2]
    const nwz = -po.sin * h.n[0] + po.cos * h.n[2]
    const nlx = pr.cos * nwx - pr.sin * nwz
    const nlz = pr.sin * nwx + pr.cos * nwz
    return { n: [nlx, h.n[1], nlz], p: [lx, y, lz], eps: h.eps }
  })
}

/** Do two roofs meeting end to end have the same eave heights (world)? */
function _seamProfilesMatch(A: ResolvedSegment, B: ResolvedSegment): boolean {
  const eaves = (r: ResolvedSegment) => {
    const f = r.shape.frame
    const mid = (f.uMin + f.uMax) / 2
    const at = (v: number) => (f.ridgeAlongX ? toWorld(r.placement, mid, v) : toWorld(r.placement, v, mid))
    return [
      { p: at(f.vMin), y: r.placement.baseY + f.eaveOf[f.eSideLo]! },
      { p: at(f.vMax), y: r.placement.baseY + f.eaveOf[f.eSideHi]! },
    ]
  }
  const ea = eaves(A)
  const eb = eaves(B)
  if (Math.abs(ridgeWorld(A.placement, A.shape).y - ridgeWorld(B.placement, B.shape).y) > SEAM_PROFILE_TOL) {
    return false
  }
  for (const a of ea) {
    // Pair each of A's sides with B's side on the same side of the ridge.
    let best = eb[0]!
    let bestD = Number.POSITIVE_INFINITY
    const ra = ridgeWorld(A.placement, A.shape)
    const sideA = Math.sign((a.p[0] - ra.a[0]) * ra.dir[1] - (a.p[1] - ra.a[1]) * ra.dir[0])
    for (const b of eb) {
      const sideB = Math.sign((b.p[0] - ra.a[0]) * ra.dir[1] - (b.p[1] - ra.a[1]) * ra.dir[0])
      const d = sideA === sideB ? 0 : 1
      if (d < bestD) {
        bestD = d
        best = b
      }
    }
    if (Math.abs(a.y - best.y) > SEAM_PROFILE_TOL) return false
  }
  return true
}

/**
 * Real walls standing along each edge: parallel to it, within WALL_ON_EDGE
 * inside it, rising above the roof base. Each becomes a span [t0, t1] along
 * the edge with its top and how far in it stands.
 */
function _realWallSpans(
  r: ResolvedSegment,
  walls: WallNode[],
  levels: Map<string, { elev: number; height: number }>,
): RealWallSpan[] {
  const p = r.placement
  const s = r.shape
  const out: RealWallSpan[] = []
  for (let e = 0; e < 4; e++) {
    if (s.styles[e] === 'junction') continue
    const [l0, l1] = shellEdgeLocal(s, e)
    const a = toWorld(p, l0[0], l0[1])
    const b = toWorld(p, l1[0], l1[1])
    const L = Math.hypot(b[0] - a[0], b[1] - a[1])
    if (L < 1e-6) continue
    const d: V2 = [(b[0] - a[0]) / L, (b[1] - a[1]) / L]
    const inN: V2 = [-d[1], d[0]] // CCW polygon, proper rotation: left = inward
    for (const w of walls) {
      if ((w.bulge ?? 0) !== 0) continue
      const ws = w.start
      const we = w.end
      const wl = Math.hypot(we[0] - ws[0], we[1] - ws[1])
      if (wl < 1e-6) continue
      const wd: V2 = [(we[0] - ws[0]) / wl, (we[1] - ws[1]) / wl]
      if (Math.abs(d[0] * wd[1] - d[1] * wd[0]) > 0.09) continue // not parallel (~5 deg)
      const mx = (ws[0] + we[0]) / 2
      const mz = (ws[1] + we[1]) / 2
      const inset = (mx - a[0]) * inN[0] + (mz - a[1]) * inN[1]
      if (inset < -0.15 || inset > WALL_ON_EDGE) continue
      const lv = w.parentId ? levels.get(w.parentId) : undefined
      const topLocal = (lv ? lv.elev : 0) + (w.height ?? 2.7) - p.baseY
      if (topLocal <= 0.05) continue // below the roof base: not in the infill zone
      const t0 = ((ws[0] - a[0]) * d[0] + (ws[1] - a[1]) * d[1]) / L
      const t1 = ((we[0] - a[0]) * d[0] + (we[1] - a[1]) * d[1]) / L
      const lo = Math.max(0, Math.min(t0, t1))
      const hi = Math.min(1, Math.max(t0, t1))
      if (hi - lo < 0.02) continue
      out.push({ edge: e, t0: lo, t1: hi, top: topLocal, inset: Math.max(0, inset) })
    }
  }
  return out
}

/** Does any wall stand under this roof, rising above its base? */
function _hasUpperWalls(
  r: ResolvedSegment,
  walls: WallNode[],
  levels: Map<string, { elev: number; height: number }>,
): boolean {
  for (const w of walls) {
    const lv = w.parentId ? levels.get(w.parentId) : undefined
    const top = (lv ? lv.elev : 0) + (w.height ?? 2.7)
    if (top <= r.placement.baseY + 0.05) continue
    const mx = (w.start[0] + w.end[0]) / 2
    const mz = (w.start[1] + w.end[1]) / 2
    if (insideFootprint(r.placement, r.shape, mx, mz, 0)) return true
  }
  return false
}

function _dormerWindowOverrides(
  r: ResolvedSegment,
  nodes: Nodes,
  levels: Map<string, { elev: number; height: number }>,
): Record<string, DormerOverride> | null {
  const raw = (r.placement.seg as { dormers?: { id: string; windowId?: string; type?: string; cheekWidth?: number }[] })
    .dormers
  if (!Array.isArray(raw)) return null
  const out: Record<string, DormerOverride> = {}
  const p = r.placement
  const s = r.shape
  for (const d of raw) {
    if (!d?.windowId) continue
    const win = nodes[d.windowId] as
      | { type?: string; wallId?: string; parentId?: string; position?: number[]; width?: number; height?: number }
      | undefined
    if (!win || win.type !== 'window') continue
    const wall = nodes[win.wallId ?? win.parentId ?? ''] as WallNode | undefined
    if (!wall || wall.type !== 'wall') continue
    const wl = Math.hypot(wall.end[0] - wall.start[0], wall.end[1] - wall.start[1])
    if (wl < 1e-6) continue
    const wd: V2 = [(wall.end[0] - wall.start[0]) / wl, (wall.end[1] - wall.start[1]) / wl]
    const along = win.position?.[0] ?? 0
    const cx = wall.start[0] + wd[0] * along
    const cz = wall.start[1] + wd[1] * along
    const lv = wall.parentId ? levels.get(wall.parentId) : undefined
    const headWorld = (lv ? lv.elev : 0) + (win.position?.[1] ?? 1) + (win.height ?? 1.2) / 2
    const [lx, lz] = toLocal(p, cx, cz)

    // The sloped edge this wall runs along (parallel, nearest).
    let bestEdge = -1
    let bestDist = Number.POSITIVE_INFINITY
    let bestU = 0.5
    for (const e of shellSlopedEdges(s)) {
      const [q0, q1] = shellEdgeLocal(s, e)
      const ex = q1[0] - q0[0]
      const ez = q1[1] - q0[1]
      const el = Math.hypot(ex, ez)
      if (el < 1e-6) continue
      const eu: V2 = [ex / el, ez / el]
      // Wall direction in local space.
      const [w0x, w0z] = toLocal(p, wall.start[0], wall.start[1])
      const [w1x, w1z] = toLocal(p, wall.end[0], wall.end[1])
      const wlen = Math.hypot(w1x - w0x, w1z - w0z) || 1
      if (Math.abs(eu[0] * ((w1z - w0z) / wlen) - eu[1] * ((w1x - w0x) / wlen)) > 0.09) continue
      const inward = (lx - q0[0]) * -eu[1] + (lz - q0[1]) * eu[0]
      if (inward < -0.5) continue // window outside this edge
      if (inward < bestDist) {
        bestDist = inward
        bestEdge = e
        bestU = ((lx - q0[0]) * eu[0] + (lz - q0[1]) * eu[1]) / el
      }
    }
    // No eave parallel to the window's wall (a diagonal wall, a window on a
    // gable end): still follow it — nearest sloped edge, centred on the
    // window, front at the window's distance in from that eave (operator
    // 2026-09-26: "I select a window and it's not following it").
    const parallel = bestEdge >= 0
    if (!parallel) {
      for (const e of shellSlopedEdges(s)) {
        const [q0, q1] = shellEdgeLocal(s, e)
        const ex = q1[0] - q0[0]
        const ez = q1[1] - q0[1]
        const el = Math.hypot(ex, ez)
        if (el < 1e-6) continue
        const eu: V2 = [ex / el, ez / el]
        const inward = (lx - q0[0]) * -eu[1] + (lz - q0[1]) * eu[0]
        const dist = Math.abs(inward)
        if (dist < Math.abs(bestDist) || bestEdge < 0) {
          bestDist = inward
          bestEdge = e
          bestU = ((lx - q0[0]) * eu[0] + (lz - q0[1]) * eu[1]) / el
        }
      }
    }
    if (bestEdge < 0) continue

    // Front face on the wall's INNER face, so the real wall — with its window
    // opening — stands in front and forms the dormer's face.
    const inward = parallel
      ? Math.max(0, bestDist + (wall.thickness ?? 0.15) / 2 + 0.01)
      : Math.max(0, bestDist)
    const cheekWidth = (win.width ?? 1) + 0.5
    const halfW = cheekWidth / 2
    const f = s.frame
    const tanP = Math.max(0.01, f.tanOf[bestEdge]!)
    const zFront = f.eaveOf[bestEdge]! + tanP * inward
    const headLocal = headWorld - p.baseY
    const need = headLocal + 0.15 - zFront // cheek top must clear the window head
    let ridgeHeight: number
    if (d.type === 'shed') ridgeHeight = need
    else ridgeHeight = need >= halfW * tanP ? need + halfW * tanP : 2 * need
    ridgeHeight = Math.max(0.5, ridgeHeight)
    out[d.id] = { edgeIdx: bestEdge, uMid: Math.min(Math.max(bestU, 0), 1), inward, cheekWidth, ridgeHeight }
  }
  return Object.keys(out).length ? out : null
}

/** Convenience for callers holding a context: the options for one segment. */
export function buildOptionsFor(ctx: RoofContext, segId: string): ShellBuildOptions {
  return ctx.segments.get(segId)?.opts ?? {}
}

/**
 * Windows a dormer on this segment could follow: windows whose wall runs
 * along one of the segment's sloped edges, inside its footprint. Sorted by
 * where they sit along the roof so the panel list reads in order.
 */
export function windowsUnderSegment(
  nodes: Nodes,
  ctx: RoofContext,
  segId: string,
): { id: string; label: string }[] {
  const r = ctx.segments.get(segId)
  if (!r) return []
  const p = r.placement
  const s = r.shape
  const out: { id: string; label: string; key: number }[] = []
  for (const n of Object.values(nodes)) {
    if (!n || n.type !== 'window') continue
    const win = n as unknown as { id: string; name?: string; wallId?: string; parentId?: string; position?: number[] }
    const wall = nodes[win.wallId ?? win.parentId ?? ''] as WallNode | undefined
    if (!wall || wall.type !== 'wall') continue
    const wl = Math.hypot(wall.end[0] - wall.start[0], wall.end[1] - wall.start[1])
    if (wl < 1e-6) continue
    const along = win.position?.[0] ?? 0
    const cx = wall.start[0] + ((wall.end[0] - wall.start[0]) / wl) * along
    const cz = wall.start[1] + ((wall.end[1] - wall.start[1]) / wl) * along
    if (!insideFootprint(p, s, cx, cz, 0.5)) continue
    const lvl = wall.parentId ? (nodes[wall.parentId] as { level?: number } | undefined)?.level : undefined
    const [lx, lz] = toLocal(p, cx, cz)
    out.push({
      id: win.id,
      label: `${win.name ?? 'Window'}${lvl != null ? ` · L${lvl}` : ''} · ${Math.round(((win as { width?: number }).width ?? 0) * 100)} cm`,
      key: s.frame.ridgeAlongX ? lx : lz,
    })
  }
  return out.sort((a, b) => a.key - b.key).map(({ id, label }) => ({ id, label }))
}
