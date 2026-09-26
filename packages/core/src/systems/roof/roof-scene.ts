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
  type RoofSeam,
  type RoofSeamHalf,
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
/** Sections keep their own heights (operator 2026-09-26: "all sections
 *  should be independent"). Only ridges already this close count as the
 *  same height: they are levelled exactly and fuse. The panel's Match
 *  height button puts a section's ridge exactly on a neighbour's. */
const LEVEL_SNAP_M = 0.02
/** Two footprint edges this close (and this near parallel) are one seam. */
const SEAM_GAP_M = 0.3
const SEAM_PARALLEL_COS = Math.cos((8 * Math.PI) / 180)
/** A ridge must cross a seam at least this steeply for it to be that
 *  roof's end (not an eave running alongside it). */
const SEAM_RIDGE_SIN = Math.sin((20 * Math.PI) / 180)

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

  // Pass 1a: seams. Two roofs drawn as sections that meet along a shared
  // edge, each ridge running into it (wings meeting at an angle, with no
  // overlap): both run on to the edge and stop dead there, so they fuse
  // into one roof with a valley and a hip on the seam (operator 2026-09-26).
  const seamNbrs = new Map<ResolvedSegment, ResolvedSegment[]>()
  const seamed = new Set<string>()
  for (let bi = 1; bi < ordered.length; bi++) {
    const B = ordered[bi]!
    for (let ai = 0; ai < bi; ai++) {
      const A = ordered[ai]!
      if (A.placement.levelId !== B.placement.levelId) continue
      if (!_seamPair(A, B, rebuild)) continue
      seamed.add(`${A.placement.seg.id}|${B.placement.seg.id}`)
      seamNbrs.set(A, [...(seamNbrs.get(A) ?? []), B])
      seamNbrs.set(B, [...(seamNbrs.get(B) ?? []), A])
    }
  }

  // Pass 1: junctions. Each later (secondary) segment joins at most one
  // earlier (primary) one per end.
  for (let bi = 1; bi < ordered.length; bi++) {
    const B = ordered[bi]!
    for (let ai = 0; ai < bi; ai++) {
      const A = ordered[ai]!
      if (A.placement.levelId !== B.placement.levelId) continue
      if (seamed.has(`${A.placement.seg.id}|${B.placement.seg.id}`)) continue
      const before = B.joinedTo
      _joinPair(A, B, rebuild)
      // Order is highest ridge first, so a wing a few cm taller than the
      // roof it runs into came first and never joined — Level then did
      // nothing (operator 2026-09-26: "I cannot make them even"). If the
      // earlier one is the one asking to match, join it the other way.
      if (B.joinedTo === before && _wantsMatch(A, B)) _joinPair(B, A, rebuild)
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

  // Seam step walls: each seam learns the neighbour's roof height along it
  // (shapes are final now), so a wall closes only where this roof is higher.
  for (const [r, nbrs] of seamNbrs) {
    const seams = r.opts.seams ?? []
    const next = seams.map((m, i) => {
      const o = nbrs[i]
      return o ? _seamProfiles(r, o, m) : m
    })
    r.opts = { ...r.opts, seams: next }
    rebuild(r)
  }

  // Pass 4: meeting roofs read as ONE roof. Each segment drops whatever of
  // it lies inside a neighbour on the same level (shapes are final now).
  for (const r of segs.values()) {
    const vols: ClipVolume[] = []
    for (const o of segs.values()) {
      if (o === r || o.placement.levelId !== r.placement.levelId) continue
      if (seamNbrs.get(r)?.includes(o)) continue
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
  // Auto: LEVEL only for ridges already at the same height (within
  // LEVEL_SNAP_M). Anything else is the operator's choice of heights:
  // forcing it made changing one roof's height drag its neighbours
  // (operator 2026-09-26). 'level' in the panel still forces it.
  const nearlyLevel =
    Math.abs(ridgeWorld(pb, B.shape).y - ra.y) <= LEVEL_SNAP_M &&
    spanOf(B.shape) >= LEVEL_MATCH_MIN_SPAN_RATIO * spanOf(A.shape)
  const mode: RidgeMatch =
    ((B.placement.seg as { ridgeMatch?: RidgeMatch }).ridgeMatch as RidgeMatch | undefined) ??
    (nearlyLevel ? 'level' : 'independent')
  if (mode === 'level') {
    // Rise is measured from the segment's wall top (baseZ), not its base.
    B.opts = { ...B.opts, ridgeRiseOverride: ra.y - pb.baseY - B.shape.baseZ }
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

/**
 * If A and B share a footprint edge that both ridges run into, and their
 * ridges are at the same height (or the panel asks for Level / Pitch),
 * fuse them there. On each side of the ridges the two slope planes meet
 * along a line (a hip on the outside of the bend, a valley on the inside);
 * each roof runs on to that line and stops, so the surface is continuous
 * even where the drawn edge isn't exactly where the slopes meet.
 * Returns whether a seam was made.
 */
function _seamPair(A: ResolvedSegment, B: ResolvedSegment, rebuild: (r: ResolvedSegment) => void): boolean {
  // The one with a Level / Pitch choice in its panel follows the other.
  if (!_ridgeMatchOf(B) && _ridgeMatchOf(A)) return _seamPair(B, A, rebuild)
  const ra = ridgeWorld(A.placement, A.shape)
  const rb = ridgeWorld(B.placement, B.shape)
  if (Math.abs(ra.dir[0] * rb.dir[1] - ra.dir[1] * rb.dir[0]) < PARALLEL_SIN) return false

  const unit = (p: V2, q: V2): V2 => {
    const L = Math.hypot(q[0] - p[0], q[1] - p[1]) || 1
    return [(q[0] - p[0]) / L, (q[1] - p[1]) / L]
  }
  const edges = (r: ResolvedSegment) => {
    const w = r.shape.footprint.map(([x, z]) => toWorld(r.placement, x, z))
    return w.map((p, i) => [p, w[(i + 1) % w.length]!] as [V2, V2])
  }
  // Does the ridge line cross edge p-q steeply, within the edge?
  const ridgeCrosses = (rd: { a: V2; dir: V2 }, p: V2, q: V2) => {
    const d = unit(p, q)
    const den = rd.dir[0] * d[1] - rd.dir[1] * d[0]
    if (Math.abs(den) < SEAM_RIDGE_SIN) return false
    const L = Math.hypot(q[0] - p[0], q[1] - p[1])
    // p + d*s = rd.a + rd.dir*t  ->  s
    const s = ((rd.a[0] - p[0]) * rd.dir[1] - (rd.a[1] - p[1]) * rd.dir[0]) / -den
    return s >= -0.05 * L && s <= 1.05 * L
  }

  let best: { ea: [V2, V2]; eb: [V2, V2]; overlap: number } | null = null
  for (const ea of edges(A)) {
    const dA = unit(ea[0], ea[1])
    const LA = Math.hypot(ea[1][0] - ea[0][0], ea[1][1] - ea[0][1])
    for (const eb of edges(B)) {
      const dB = unit(eb[0], eb[1])
      if (dA[0] * dB[0] + dA[1] * dB[1] > -SEAM_PARALLEL_COS) continue // both CCW: opposite
      const off = (q: V2) => (q[0] - ea[0][0]) * dA[1] - (q[1] - ea[0][1]) * dA[0]
      if (Math.abs(off(eb[0])) > SEAM_GAP_M || Math.abs(off(eb[1])) > SEAM_GAP_M) continue
      const along = (q: V2) => (q[0] - ea[0][0]) * dA[0] + (q[1] - ea[0][1]) * dA[1]
      const s0 = Math.max(0, Math.min(along(eb[0]), along(eb[1])))
      const s1 = Math.min(LA, Math.max(along(eb[0]), along(eb[1])))
      const LB = Math.hypot(eb[1][0] - eb[0][0], eb[1][1] - eb[0][1])
      const overlap = s1 - s0
      if (overlap < Math.max(1, 0.5 * Math.min(LA, LB))) continue
      if (!ridgeCrosses(ra, ea[0], ea[1]) || !ridgeCrosses(rb, eb[0], eb[1])) continue
      if (!best || overlap > best.overlap) best = { ea, eb, overlap }
    }
  }
  if (!best) return false

  // Same height only (or the panel's explicit choice): B follows A.
  const nearlyLevel = Math.abs(rb.y - ra.y) <= LEVEL_SNAP_M
  const mode: RidgeMatch =
    ((B.placement.seg as { ridgeMatch?: RidgeMatch }).ridgeMatch as RidgeMatch | undefined) ??
    (nearlyLevel ? 'level' : 'independent')
  if (mode === 'independent') return false

  // The drawn common line: through the middle of the two edges.
  const dA = unit(best.ea[0], best.ea[1])
  const dB = unit(best.eb[0], best.eb[1])
  const d = unit([0, 0], [dA[0] - dB[0], dA[1] - dB[1]])
  const mid: V2 = [
    (best.ea[0][0] + best.ea[1][0] + best.eb[0][0] + best.eb[1][0]) / 4,
    (best.ea[0][1] + best.ea[1][1] + best.eb[0][1] + best.eb[1][1]) / 4,
  ]
  const nA: V2 = [d[1], -d[0]] // outward from A (CCW)
  const tOn = (q: V2) => (q[0] - mid[0]) * d[0] + (q[1] - mid[1]) * d[1]
  const ptOn = (t: number): V2 => [mid[0] + d[0] * t, mid[1] + d[1] * t]
  const ts = [best.ea[0], best.ea[1], best.eb[0], best.eb[1]].map(tOn)
  const E: V2[] = [ptOn(Math.min(...ts)), ptOn(Math.max(...ts))]

  // Open the end each ridge runs into, match the ridge.
  const endOf = (r: ResolvedSegment, rd: { a: V2; dir: V2 }): 'Lo' | 'Hi' => {
    const den = rd.dir[0] * d[1] - rd.dir[1] * d[0]
    const t = ((mid[0] - rd.a[0]) * d[1] - (mid[1] - rd.a[1]) * d[0]) / den
    const u = localU(r.placement, r.shape, rd.a[0] + rd.dir[0] * t, rd.a[1] + rd.dir[1] * t)
    const f = r.shape.frame
    return Math.abs(u - f.uMax) < Math.abs(u - f.uMin) ? 'Hi' : 'Lo'
  }
  const endA = endOf(A, ra)
  const endB = endOf(B, rb)
  A.opts = { ...A.opts, [`end${endA}`]: 'junction' }
  B.opts = { ...B.opts, [`end${endB}`]: 'junction' }
  if (mode === 'level') {
    B.opts = { ...B.opts, ridgeRiseOverride: ra.y - B.placement.baseY - B.shape.baseZ }
  } else if (mode === 'pitch') {
    const f = A.shape.frame
    B.opts = { ...B.opts, uniformTanOverride: (f.tanOf[f.eSideLo]! + f.tanOf[f.eSideHi]!) / 2 }
  }
  rebuild(A)
  rebuild(B)
  const RA = ridgeWorld(A.placement, A.shape)
  const RB = ridgeWorld(B.placement, B.shape)

  // Where the ridges cross.
  const den = RA.dir[0] * RB.dir[1] - RA.dir[1] * RB.dir[0]
  const tR = ((RB.a[0] - RA.a[0]) * RB.dir[1] - (RB.a[1] - RA.a[1]) * RB.dir[0]) / den
  const R: V2 = [RA.a[0] + RA.dir[0] * tR, RA.a[1] + RA.dir[1] * tR]

  // A roof's slope plane on one side of its ridge, as S(q) = S0 + g·(q - R).
  const plane = (r: ResolvedSegment, lo: boolean) => {
    const f = r.shape.frame
    const S = (X: number, Z: number) => {
      const [x, z] = toLocal(r.placement, X, Z)
      const v = f.ridgeAlongX ? z : x
      return lo
        ? r.placement.baseY + f.eaveOf[f.eSideLo]! + f.tanOf[f.eSideLo]! * (v - f.vMin)
        : r.placement.baseY + f.eaveOf[f.eSideHi]! + f.tanOf[f.eSideHi]! * (f.vMax - v)
    }
    const S0 = S(R[0], R[1])
    return { S0, g: [S(R[0] + 1, R[1]) - S0, S(R[0], R[1] + 1) - S0] as V2 }
  }
  const vOf = (r: ResolvedSegment, q: V2) => {
    const [x, z] = toLocal(r.placement, q[0], q[1])
    return r.shape.frame.ridgeAlongX ? z : x
  }
  const farA: V2 = endA === 'Hi' ? RA.a : RA.b // A's other ridge end: deep in A
  const seamLen = Math.hypot(E[1]![0] - E[0]![0], E[1]![1] - E[0]![1])

  const halvesA: RoofSeamHalf[] = []
  const halvesB: RoofSeamHalf[] = []
  const reachA: V2[] = []
  const reachB: V2[] = []
  for (const e of E) {
    const loA = vOf(A, e) < A.shape.frame.vMid
    const loB = vOf(B, e) < B.shape.frame.vMid
    const pa = plane(A, loA)
    const pb = plane(B, loB)
    // Meeting line: (gA - gB)·(q - R) = S0B - S0A.
    const G: V2 = [pa.g[0] - pb.g[0], pa.g[1] - pb.g[1]]
    const GG = G[0] * G[0] + G[1] * G[1]
    let p0: V2 | null = null
    let ng: V2 = [0, 0]
    if (GG > 1e-9) {
      const k = (pb.S0 - pa.S0) / GG
      p0 = [R[0] + G[0] * k, R[1] + G[1] * k]
      const L = Math.sqrt(GG)
      ng = [G[0] / L, G[1] / L]
      // Sensible only if it runs near the ridge crossing and the drawn end.
      const dE = Math.abs(ng[0] * (e[0] - p0[0]) + ng[1] * (e[1] - p0[1]))
      if (Math.hypot(p0[0] - R[0], p0[1] - R[1]) > 0.3 || dE > Math.max(1, 0.3 * seamLen)) p0 = null
    }
    if (!p0) {
      // Fall back to the drawn edge (step walls close any mismatch).
      p0 = mid
      ng = nA
    }
    // Toward B: A's far ridge end must be on the negative side.
    if (ng[0] * (farA[0] - p0[0]) + ng[1] * (farA[1] - p0[1]) > 0) ng = [-ng[0], -ng[1]]
    const dl: V2 = [-ng[1], ng[0]]
    const foot = (q: V2): V2 => {
      const t = (q[0] - p0![0]) * dl[0] + (q[1] - p0![1]) * dl[1]
      return [p0![0] + dl[0] * t, p0![1] + dl[1] * t]
    }
    const from = foot(R)
    const to = foot(e)
    // Side of each ridge this half is on.
    const side = (rd: { dir: V2 }): V2 => {
      const n: V2 = [-rd.dir[1], rd.dir[0]]
      return n[0] * (e[0] - R[0]) + n[1] * (e[1] - R[1]) >= 0 ? n : [-n[0], -n[1]]
    }
    const sA = side(RA)
    const sB = side(RB)
    const local = (r: ResolvedSegment, q: V2) => toLocal(r.placement, q[0], q[1])
    const rot = (r: ResolvedSegment, n: V2): V2 => [
      r.placement.cos * n[0] - r.placement.sin * n[1],
      r.placement.sin * n[0] + r.placement.cos * n[1],
    ]
    halvesA.push({ p: local(A, p0), n: rot(A, ng), r: local(A, R), s: rot(A, sA), from: local(A, from), to: local(A, to) })
    halvesB.push({
      p: local(B, p0),
      n: rot(B, [-ng[0], -ng[1]]),
      r: local(B, R),
      s: rot(B, sB),
      from: local(B, from),
      to: local(B, to),
    })
    // How far each roof must reach along its ridge to meet this line: to
    // where the line crosses its eave (plus overhang) on this side.
    for (const [r, lo, reach] of [
      [A, loA, reachA],
      [B, loB, reachB],
    ] as const) {
      const f = r.shape.frame
      const oh = f.overhang
      const vEdge = lo ? f.vMin - oh : f.vMax + oh
      const [px, pz] = local(r, p0)
      const [dx, dz] = rot(r, dl)
      const pv = f.ridgeAlongX ? pz : px
      const dv = f.ridgeAlongX ? dz : dx
      if (Math.abs(dv) < 1e-6) continue
      const t = (vEdge - pv) / dv
      reach.push([px + dx * t, pz + dz * t])
    }
  }

  // Run each roof on far enough to meet the lines (its end there is open).
  const extend = (r: ResolvedSegment, end: 'Lo' | 'Hi', pts: V2[]) => {
    if (!pts.length) return
    const f = r.shape.frame
    const us = pts.map(([x, z]) => (f.ridgeAlongX ? x : z))
    if (end === 'Hi') {
      const u = Math.max(...us) + 0.05
      if (u > f.uMax) r.opts = { ...r.opts, truncateHi: u }
    } else {
      const u = Math.min(...us) - 0.05
      if (u < f.uMin) r.opts = { ...r.opts, truncateLo: u }
    }
  }
  extend(A, endA, reachA)
  extend(B, endB, reachB)

  const seamFor = (r: ResolvedSegment, e: [V2, V2], n: V2, halves: RoofSeamHalf[]): RoofSeam => {
    let p = ptOn(tOn(e[0]))
    let q = ptOn(tOn(e[1]))
    if ((q[1] - p[1]) * n[0] - (q[0] - p[0]) * n[1] < 0) [p, q] = [q, p]
    const pl = r.placement
    return {
      a: toLocal(pl, p[0], p[1]),
      b: toLocal(pl, q[0], q[1]),
      n: [pl.cos * n[0] - pl.sin * n[1], pl.sin * n[0] + pl.cos * n[1]],
      halves,
    }
  }
  A.opts = { ...A.opts, seams: [...(A.opts.seams ?? []), seamFor(A, best.ea, nA, halvesA)] }
  B.opts = { ...B.opts, seams: [...(B.opts.seams ?? []), seamFor(B, best.eb, [-nA[0], -nA[1]], halvesB)] }
  rebuild(A)
  rebuild(B)
  B.joinedTo = A.placement.seg.id
  B.ridgeMatchApplied = mode
  return true
}

function _ridgeMatchOf(r: ResolvedSegment): RidgeMatch | undefined {
  return (r.placement.seg as { ridgeMatch?: RidgeMatch }).ridgeMatch
}

/** Should P follow Q's ridge: P asks for Level / Pitch, or they are
 *  already at the same height. */
function _wantsMatch(P: ResolvedSegment, Q: ResolvedSegment): boolean {
  const m = _ridgeMatchOf(P)
  if (m === 'level' || m === 'pitch') return true
  if (m === 'independent') return false
  return Math.abs(ridgeWorld(P.placement, P.shape).y - ridgeWorld(Q.placement, Q.shape).y) <= LEVEL_SNAP_M
}

/**
 * Roof sections touching this one on the same level, with their ridge
 * heights (world, as built), for the panel's Match height buttons.
 */
export function touchingSegments(ctx: RoofContext, segId: string): { id: string; ridgeY: number }[] {
  const r = ctx.segments.get(segId)
  if (!r) return []
  const out: { id: string; ridgeY: number }[] = []
  for (const [id, o] of ctx.segments) {
    if (o === r || o.placement.levelId !== r.placement.levelId) continue
    if (!_footprintsOverlap(r, o)) continue
    out.push({ id, ridgeY: ridgeWorld(o.placement, o.shape).y })
  }
  return out
}

/** The roofHeight that puts this section's ridge at world height y. */
export function roofHeightForRidge(ctx: RoofContext, segId: string, y: number): number | null {
  const r = ctx.segments.get(segId)
  if (!r) return null
  return y - r.placement.baseY - r.shape.baseZ
}

/** The neighbour's roof height along each half of seam m of r (r's local Y). */
function _seamProfiles(r: ResolvedSegment, o: ResolvedSegment, m: RoofSeam): RoofSeam {
  return {
    ...m,
    halves: m.halves.map((h) => {
      const L = Math.hypot(h.to[0] - h.from[0], h.to[1] - h.from[1])
      const steps = Math.max(1, Math.ceil(L / 0.1))
      const profile: { t: number; y: number }[] = []
      for (let k = 0; k <= steps; k++) {
        const t = k / steps
        const [X, Z] = toWorld(r.placement, h.from[0] + (h.to[0] - h.from[0]) * t, h.from[1] + (h.to[1] - h.from[1]) * t)
        const hh = heightWorld(o.placement, o.shape, X, Z)
        profile.push({ t, y: hh == null ? -1e6 : hh - r.placement.baseY })
      }
      return { ...h, profile }
    }),
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
  /** Windows to list even if they stay below the roof (e.g. one a dormer
   *  already follows), so the picker never shows a blank. */
  keepIds: string[] = [],
): { id: string; label: string }[] {
  const r = ctx.segments.get(segId)
  if (!r) return []
  const p = r.placement
  const s = r.shape
  // Only windows that reach INTO the roof need a dormer: their head is above
  // the storey wall top the roof sits on (operator 2026-09-26 — a roof on L0
  // covers L1, so it's L1's windows; L0's are below it and already visible).
  const roofBase = p.baseY + p.floorY
  const levels = ctx.levels
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
    const lv = wall.parentId ? levels.get(wall.parentId) : undefined
    const w2 = win as unknown as { position?: number[]; height?: number }
    const head = (lv ? lv.elev : 0) + (w2.position?.[1] ?? 1) + (w2.height ?? 1.2) / 2
    const below = head <= roofBase + 0.05
    if (below && !keepIds.includes(win.id)) continue
    const lvl = wall.parentId ? (nodes[wall.parentId] as { level?: number } | undefined)?.level : undefined
    const [lx, lz] = toLocal(p, cx, cz)
    out.push({
      id: win.id,
      label: `${win.name ?? 'Window'}${lvl != null ? ` · L${lvl}` : ''} · ${Math.round(((win as { width?: number }).width ?? 0) * 100)} cm${below ? ' (below the roof)' : ''}`,
      key: s.frame.ridgeAlongX ? lx : lz,
    })
  }
  return out.sort((a, b) => a.key - b.key).map(({ id, label }) => ({ id, label }))
}
