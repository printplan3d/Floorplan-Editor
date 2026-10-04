import { useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import { Brush, Evaluator, INTERSECTION } from 'three-bvh-csg'
import { sceneRegistry } from '../../hooks/scene-registry/scene-registry'
import {
  arcLength,
  arcParamsFromBulge,
  isStraight,
  pointAndTangentAtT,
  tangentAtEnd,
  tangentAtStart,
  tessellateArc,
} from '../../lib/arc-math'
import type { AnyNode, WallNode } from '../../schema'
import useScene from '../../store/use-scene'
import type { RoofContext } from './roof-scene'
import { getRoofContext } from './roof-system'

/**
 * Trims walls to the roof over them, and hides windows/doors the roof covers.
 *
 * The operator's rule: "whatever wall comes out of the roof needs to be
 * clipped as per the roof contour — clipped visually, not delete the wall".
 * The backend does this in blender_pipeline_dev/roof/wall_clip.py; the
 * preview never did, so level-1 walls (and their windows) poked straight up
 * through the roof slope.
 *
 * Each wall is intersected with a prism whose top follows the roof height
 * along the wall's line, sampled from the same analytic height field the
 * roof itself is built from (roof-scene.ts). Real geometry, not a shader
 * trick: exact, and still hit-testable. Dormers are part of the height
 * field, so a wall under a dormer rises into it — that is how a window gets
 * its dormer. The node data is never touched.
 *
 * Runs after WallSystem (4) and RoofSystem (5). Re-trims a wall when either
 * WallSystem hands it a new geometry or the roof context changes.
 */
const clipEvaluator = new Evaluator()
clipEvaluator.useGroups = false
clipEvaluator.attributes = ['position', 'normal']

const SAMPLE_STEP = 0.05
/** Walls the roof dips below by less than this are left alone: a sub-2 cm
 *  trim is invisible, and it makes near-coplanar faces for the CSG (a
 *  ground-floor wall under an eave at the same height is exactly that). */
const TRIM_MIN_M = 0.02
/** Walls stop this far under the roof surface: trimmed exactly to it,
 *  their top face lay IN the slates and flickered through them (operator
 *  2026-09-27: a speckled strip on the main roof beside the shed). The roof
 *  slab is thicker than this, so the top stays hidden inside it. */
const TOP_SINK = 0.03
/** How far past each wall face the roof is sampled. */
const SIDE_MARGIN = 0.05
/** Steepest slope (rise over run) the exported top follows across a wall's
 *  thickness. A side sample lower than this allows is a DIFFERENT, lower
 *  roof butting against the wall's face, not the slope over it. */
const MAX_CROSS_SLOPE = 2.4

/** One cross-section of a trimming prism, wall-local: points left of, on,
 *  and right of the centreline with the roof height (wall-local y) at each. */
type Section = { l: [number, number]; c: [number, number]; r: [number, number]; yl: number; yc: number; yr: number }
const MAX_SAMPLES = 800
/** Taller than any building; stands in for "no roof over this point". */
const OPEN_SKY = 100

type ClipState = {
  src?: THREE.BufferGeometry
  out?: THREE.BufferGeometry
  ctx?: RoofContext
}

export const RoofWallClipSystem = () => {
  useFrame(() => {
    const nodes = useScene.getState().nodes as Record<string, AnyNode>
    const ctx = getRoofContext(nodes)

    for (const wallId of sceneRegistry.byType.wall) {
      const mesh = sceneRegistry.nodes.get(wallId) as THREE.Mesh | undefined
      const node = nodes[wallId] as WallNode | undefined
      if (!mesh || !node || node.type !== 'wall') continue
      const st = (mesh.userData.__roofClip ??= {}) as ClipState

      // WallSystem replaced the geometry since we last trimmed: new source.
      if (mesh.geometry !== st.out) {
        if (st.out && st.out !== st.src) st.out.dispose()
        st.src = mesh.geometry
        st.out = mesh.geometry
        st.ctx = undefined
      }
      if (st.ctx === ctx) continue
      st.ctx = ctx

      const clipped = clipWallGeometry(st.src!, node, mesh.position.y, ctx)
      const next = clipped ?? st.src!
      if (st.out && st.out !== st.src && st.out !== next) st.out.dispose()
      mesh.geometry = next
      st.out = next
    }

    for (const type of ['window', 'door'] as const) {
      for (const id of sceneRegistry.byType[type]) {
        const obj = sceneRegistry.nodes.get(id)
        const node = nodes[id] as
          | { wallId?: string; parentId?: string; position?: number[]; height?: number }
          | undefined
        if (!obj || !node) continue
        const covered = openingCoveredByRoof(node, nodes, ctx)
        const ud = obj.userData as { __roofHidden?: boolean }
        if (covered && obj.visible) {
          obj.visible = false
          ud.__roofHidden = true
        } else if (!covered && ud.__roofHidden) {
          obj.visible = true
          ud.__roofHidden = false
        }
      }
    }
  }, 6)
  return null
}

/**
 * Wall geometry (wall-local: x along the wall from its start, y up from the
 * slab) cut down to the roof over it, or null when the roof never dips below
 * the wall top. `slabY` is the wall mesh's own y (its slab elevation).
 */
export function clipWallGeometry(
  src: THREE.BufferGeometry,
  node: WallNode,
  slabY: number,
  ctx: RoofContext,
): THREE.BufferGeometry | null {
  if (!isStraight(node.bulge ?? 0)) return _clipArcWall(src, node, slabY, ctx)
  const f = wallTrimSections(node, slabY, ctx)
  return f ? _clipToHeightField(src, f.sections, f.top) : null
}

/**
 * The trimming height field over a straight wall: cross-sections along it
 * (wall-local x from the start; heights above the wall's base at the left
 * face side z=+W, the centreline and the right z=-W), steps sharpened. Shared
 * by the preview trim (clipWallGeometry) and the render (wallRoofCap), so the
 * two cut the same wall. Null when the roof never dips below the wall top.
 */
export function wallTrimSections(
  node: WallNode,
  slabY: number,
  ctx: RoofContext,
): { sections: Section[]; W: number; top: number; baseY: number; len: number } | null {
  if (!isStraight(node.bulge ?? 0)) return null
  const [sx, sz] = node.start
  const [ex, ez] = node.end
  const len = Math.hypot(ex - sx, ez - sz)
  if (len < 1e-3) return null
  const dx = (ex - sx) / len
  const dz = (ez - sz) / len
  const lv = node.parentId ? ctx.levels.get(node.parentId) : undefined
  const baseY = (lv ? lv.elev : 0) + slabY
  const top = node.height ?? 2.7

  // Sample the roof along the wall, at its centreline AND just outside both
  // faces: on a slope the roof differs across the thickness, and a top that
  // is flat across it pokes the downhill face through the slates.
  const halfT = (node.thickness ?? 0.15) / 2
  const W = halfT + SIDE_MARGIN
  const x0 = -0.5
  const x1 = len + 0.5
  const n = Math.min(MAX_SAMPLES, Math.max(2, Math.ceil((x1 - x0) / SAMPLE_STEP) + 1))
  const at = (x: number, z: number) => {
    // wall-local (x, z) -> world, then the roof there
    const h = ctx.wallHeightAt(sx + dx * x - dz * z, sz + dz * x + dx * z, [dx, dz])
    // Capped just above the wall: the prism never needs to reach higher, and
    // a 97 m spike beside a near-zero section (no roof just past a wall's
    // end) tripped the CSG into dropping most of the wall.
    return h == null ? top + 1 : Math.min(top + 1, h - baseY - TOP_SINK)
  }
  // A face rises above the centre only as a slope across the wall does: by
  // what the other face drops, and never more than the steepest roof over W.
  // Otherwise the face sample has landed on a DIFFERENT, higher roof just
  // outside the wall -- the wall runs along the eave of the roof over it --
  // and that face stood up through the eave as a sliver (operator
  // 2026-10-03: beside the dormer, at Roof 9's east gable).
  const maxRise = W * MAX_CROSS_SLOPE
  const cross = (x: number) => {
    const c = at(x, 0)
    const l = at(x, W)
    const r = at(x, -W)
    const rise = (other: number) => Math.min(maxRise, Math.max(0, c - other)) + TRIM_MIN_M
    return { l: Math.min(l, c + rise(r)), c, r: Math.min(r, c + rise(l)) }
  }
  const sections: Section[] = []
  let needs = false
  for (let i = 0; i < n; i++) {
    const x = x0 + ((x1 - x0) * i) / (n - 1)
    const h = cross(x)
    const sec: Section = { l: [x, W], c: [x, 0], r: [x, -W], yl: h.l, yc: h.c, yr: h.r }
    if (x >= 0 && x <= len && Math.min(sec.yl, sec.yc, sec.yr) + TOP_SINK < top - TRIM_MIN_M) needs = true
    sections.push(sec)
  }
  if (!needs) return null
  // Cut directly against the roof's height field, no CSG: the CSG
  // misclassified long thin walls and dropped most of them (operator
  // 2026-10-02: whole L0 walls missing, an L1 wall kept at 4% of what the
  // roof allows; nudging the prism didn't make it reliable).
  return { sections: _sharpenSteps(sections, cross, W), W, top, baseY, len }
}

/** A rise between two 5 cm samples bigger than any roof slope makes. */
const STEP_JUMP_M = 0.3
/** A step is moved this far into the higher roof, so the wall's step face
 *  stands behind that roof's end wall instead of in its plane. The roof's
 *  body reaches 2 cm past its drawn edge, so 2 cm left the step right in the
 *  gable's plane, and the lower roof's slates run a few cm in under it
 *  (operator 2026-10-03: walls still showing at Roof 9's gable). */
const STEP_INSET_M = 0.06

/**
 * Where the roof height jumps between two samples -- one roof ends and a
 * lower one takes over -- the straight line between the samples sloped the
 * wall's top across the gap, and that sliver stood above the lower roof,
 * under the higher one's overhang (operator 2026-10-02: the L1 wall with two
 * windows showing at Roof 9's end). Find the jump and make it a clean step.
 */
function _sharpenSteps(
  sections: Section[],
  heightsAt: (x: number) => { l: number; c: number; r: number },
  W: number,
): Section[] {
  const make = (x: number, h: { l: number; c: number; r: number }): Section => ({
    l: [x, W],
    c: [x, 0],
    r: [x, -W],
    yl: h.l,
    yc: h.c,
    yr: h.r,
  })
  const added: Section[] = []
  // Samples on the higher roof that now fall on the step's low side.
  const dropped = new Set<Section>()
  for (let i = 0; i + 1 < sections.length; i++) {
    const A = sections[i]!
    const B = sections[i + 1]!
    if (Math.abs(B.yc - A.yc) <= STEP_JUMP_M) continue
    // Bisect for the jump.
    let lo = A.c[0]
    let hi = B.c[0]
    const mid = (A.yc + B.yc) / 2
    const aHigh = A.yc > B.yc
    for (let k = 0; k < 12; k++) {
      const m = (lo + hi) / 2
      const above = heightsAt(m).c > mid
      if (above === aHigh) lo = m
      else hi = m
    }
    // lo is on A's side, hi on B's. Step STEP_INSET_M into the higher side
    // -- past the next sample or two if need be, which then take the low
    // roof's height (straight on from the step to the next low sample).
    const xs = aHigh ? lo - STEP_INSET_M : hi + STEP_INSET_M
    const highH = heightsAt(aHigh ? lo : hi)
    const lowH = heightsAt(aHigh ? hi : lo)
    // A face sample can still be on the higher roof's overhang there (the
    // two roofs' drawn edges a few cm apart): the low side is low right
    // across the wall, or that face stood up through the lower roof
    // (operator 2026-10-03, the L1 wall at Roof 9's west gable).
    lowH.l = Math.min(lowH.l, lowH.c + STEP_JUMP_M)
    lowH.r = Math.min(lowH.r, lowH.c + STEP_JUMP_M)
    for (const s of sections) {
      if (aHigh ? s.c[0] > xs - 2e-4 && s.c[0] < hi : s.c[0] > lo && s.c[0] < xs + 2e-4) dropped.add(s)
    }
    if (aHigh) added.push(make(xs - 1e-4, highH), make(xs + 1e-4, lowH))
    else added.push(make(xs - 1e-4, lowH), make(xs + 1e-4, highH))
  }
  if (!added.length) return sections
  return [...sections.filter((s) => !dropped.has(s)), ...added].sort((p, q) => p.c[0] - q.c[0])
}

type P3 = [number, number, number]

/** Keep the part of a convex planar polygon where f(p) >= 0 (Sutherland–Hodgman). */
function _keep(poly: P3[], f: (p: P3) => number): P3[] {
  const out: P3[] = []
  const n = poly.length
  for (let i = 0; i < n; i++) {
    const a = poly[i]!
    const b = poly[(i + 1) % n]!
    const fa = f(a)
    const fb = f(b)
    if (fa >= 0) out.push(a)
    if ((fa >= 0) !== (fb >= 0)) {
      const t = Math.min(1, Math.max(0, fa / (fa - fb)))
      out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t])
    }
  }
  return out
}

function _polyArea(poly: P3[]): number {
  let x = 0
  let y = 0
  let z = 0
  for (let i = 1; i < poly.length - 1; i++) {
    const a = poly[0]!
    const b = poly[i]!
    const c = poly[i + 1]!
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2]
    const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2]
    x += uy * vz - uz * vy
    y += uz * vx - ux * vz
    z += ux * vy - uy * vx
  }
  return Math.hypot(x, y, z) / 2
}

/** One planar piece of the roof height field over the wall (wall-local). */
type Cell = {
  xMin: number
  xMax: number
  tri: [[number, number], [number, number], [number, number]]
  a: number
  b: number
  d: number
}

/**
 * The trimming prism's top as planar triangles in plan (x, z), each with its
 * height plane y = a x + b z + d -- the same triangulation the old CSG prism
 * used, so the trim is unchanged where the CSG got it right.
 */
function _heightCells(sections: Section[]): Cell[] {
  const cells: Cell[] = []
  const add = (p: [number, number, number], q: [number, number, number], r: [number, number, number]) => {
    // Points are (x, z, y). Solve y = a x + b z + d through the three.
    const det = (q[0] - p[0]) * (r[1] - p[1]) - (r[0] - p[0]) * (q[1] - p[1])
    if (Math.abs(det) < 1e-12) return
    const a = ((q[2] - p[2]) * (r[1] - p[1]) - (r[2] - p[2]) * (q[1] - p[1])) / det
    const b = ((r[2] - p[2]) * (q[0] - p[0]) - (q[2] - p[2]) * (r[0] - p[0])) / det
    const d = p[2] - a * p[0] - b * p[1]
    cells.push({
      xMin: Math.min(p[0], q[0], r[0]),
      xMax: Math.max(p[0], q[0], r[0]),
      tri: [
        [p[0], p[1]],
        [q[0], q[1]],
        [r[0], r[1]],
      ],
      a,
      b,
      d,
    })
  }
  for (let i = 0; i < sections.length - 1; i++) {
    const A = sections[i]!
    const C = sections[i + 1]!
    const Ac: [number, number, number] = [A.c[0], A.c[1], A.yc]
    const Cc: [number, number, number] = [C.c[0], C.c[1], C.yc]
    const Al: [number, number, number] = [A.l[0], A.l[1], A.yl]
    const Cl: [number, number, number] = [C.l[0], C.l[1], C.yl]
    const Ar: [number, number, number] = [A.r[0], A.r[1], A.yr]
    const Cr: [number, number, number] = [C.r[0], C.r[1], C.yr]
    add(Ac, Cc, Cl)
    add(Ac, Cl, Al)
    add(Ar, Cr, Cc)
    add(Ar, Cc, Ac)
  }
  return cells
}

/** 2D convex hull (x, z) of a point set, counter-clockwise. */
function _hull2(pts: [number, number][]): [number, number][] {
  const p = [...pts].sort((u, v) => u[0] - v[0] || u[1] - v[1])
  if (p.length < 3) return p
  const cross = (o: [number, number], a: [number, number], b: [number, number]) =>
    (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])
  const lo: [number, number][] = []
  for (const q of p) {
    while (lo.length >= 2 && cross(lo[lo.length - 2]!, lo[lo.length - 1]!, q) <= 1e-12) lo.pop()
    lo.push(q)
  }
  const hi: [number, number][] = []
  for (let i = p.length - 1; i >= 0; i--) {
    const q = p[i]!
    while (hi.length >= 2 && cross(hi[hi.length - 2]!, hi[hi.length - 1]!, q) <= 1e-12) hi.pop()
    hi.push(q)
  }
  return lo.slice(0, -1).concat(hi.slice(0, -1))
}

/**
 * The wall below the roof's height field, as plain geometry: every face
 * clipped to the field (cell by cell), plus a cap on the field wherever it
 * cuts through the wall. Wall-local; `top` is the wall's own height.
 */
function _clipToHeightField(src: THREE.BufferGeometry, sections: Section[], top: number): THREE.BufferGeometry {
  const cells = _heightCells(sections)
  const pos = src.getAttribute('position') as THREE.BufferAttribute
  const idx = src.getIndex()
  const n = idx ? idx.count : pos.count
  const V = (i: number): P3 => [pos.getX(i), pos.getY(i), pos.getZ(i)]
  const out: number[] = []
  const emit = (poly: P3[]) => {
    if (poly.length < 3 || _polyArea(poly) < 1e-8) return
    for (let i = 1; i < poly.length - 1; i++) out.push(...poly[0]!, ...poly[i]!, ...poly[i + 1]!)
  }
  // Inside-the-cell test in plan, oriented so the triangle's inside is >= 0.
  const inCell = (c: Cell, poly: P3[]): P3[] => {
    const [p, q, r] = c.tri
    const s = Math.sign((q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0])) || 1
    let out2 = poly
    for (const [a, b] of [
      [p, q],
      [q, r],
      [r, p],
    ] as const) {
      out2 = _keep(out2, (v) => s * ((b[0] - a[0]) * (v[2] - a[1]) - (b[1] - a[1]) * (v[0] - a[0])) + 1e-9)
      if (out2.length < 3) return out2
    }
    return out2
  }
  const below = (c: Cell) => (v: P3) => c.a * v[0] + c.b * v[2] + c.d - v[1]
  for (let k = 0; k + 2 < n; k += 3) {
    const tri: P3[] = [V(idx ? idx.getX(k) : k), V(idx ? idx.getX(k + 1) : k + 1), V(idx ? idx.getX(k + 2) : k + 2)]
    const tx0 = Math.min(tri[0]![0], tri[1]![0], tri[2]![0])
    const tx1 = Math.max(tri[0]![0], tri[1]![0], tri[2]![0])
    for (const c of cells) {
      if (c.xMax < tx0 - 1e-9 || c.xMin > tx1 + 1e-9) continue
      const piece = inCell(c, tri)
      if (piece.length < 3) continue
      emit(_keep(piece, below(c)))
    }
  }
  // Caps: the field's surface inside the wall's plan outline, between the
  // wall's base and its top, facing up.
  const plan: [number, number][] = []
  for (let i = 0; i < pos.count; i++) plan.push([pos.getX(i), pos.getZ(i)])
  const hull = _hull2(plan)
  if (hull.length >= 3) {
    for (const c of cells) {
      let cap: P3[] = hull.map(([x, z]): P3 => [x, c.a * x + c.b * z + c.d, z])
      cap = inCell(c, cap)
      if (cap.length < 3) continue
      cap = _keep(cap, (v) => top - 1e-6 - v[1])
      cap = _keep(cap, (v) => v[1] - 1e-6)
      if (cap.length < 3) continue
      // Facing up.
      const [p0, p1, p2] = cap as [P3, P3, P3]
      const ny = (p1[2] - p0[2]) * (p2[0] - p0[0]) - (p1[0] - p0[0]) * (p2[2] - p0[2])
      emit(ny >= 0 ? cap : [...cap].reverse())
    }
  }
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.Float32BufferAttribute(out, 3))
  g.computeVertexNormals()
  return g
}

/**
 * The wall's top, as trimmed here, for the render pipeline: points
 * { s, y } with s metres along the wall from its start and y the top's
 * height above the wall's base (the lowest across the thickness), or null
 * when the roof never trims it. Straight walls only.
 *
 * The render trimmed walls on its own, to the HIGHEST roof over each top
 * corner, so the end of a wall under a higher roof's overhang stood up as a
 * post through the lower roof (operator 2026-09-27: "a small wall coming out
 * of the shed" in the render; the preview had it right). Sending the
 * preview's own trim makes the two agree.
 */
export function wallTopProfile(
  node: WallNode,
  slabY: number,
  ctx: RoofContext,
): { s: number; y: number }[] | null {
  if (!isStraight(node.bulge ?? 0)) return null
  const [sx, sz] = node.start
  const [ex, ez] = node.end
  const len = Math.hypot(ex - sx, ez - sz)
  if (len < 1e-3) return null
  const dx = (ex - sx) / len
  const dz = (ez - sz) / len
  const lv = node.parentId ? ctx.levels.get(node.parentId) : undefined
  const baseY = (lv ? lv.elev : 0) + slabY
  const top = node.height ?? 2.7
  const W = (node.thickness ?? 0.15) / 2 + SIDE_MARGIN
  const at = (x: number, z: number) => {
    const h = ctx.wallHeightAt(sx + dx * x - dz * z, sz + dz * x + dx * z, [dx, dz])
    return h == null ? OPEN_SKY : h - baseY - TOP_SINK
  }
  // Sampled a little PAST both ends: the render's wall mesh runs on into
  // the corner by about half a thickness, and the pipeline holds the end
  // height flat beyond the profile, so the top's last stretch came out
  // shallower than the roof and stood up to 5 cm above the slates -- a white
  // stripe down the slope (operator 2026-10-03).
  const ext = W + 0.05
  const n = Math.min(MAX_SAMPLES, Math.max(2, Math.ceil((len + 2 * ext) / SAMPLE_STEP) + 1))
  const pts: { s: number; y: number }[] = []
  let needs = false
  // The render cuts a wall flat across its thickness, so the lowest of the
  // three samples wins -- but only while a side sample is the SAME slope as
  // over the wall: no steeper than a roof gets over W, and already dipping
  // at the wall's own face on the way out. Otherwise it has landed on a
  // lower roof abutting the wall (its eave at the wall's foot, outside the
  // face): taking it dropped a whole L1 wall to 15 cm in the render while
  // the preview, which only shaves the outer face, showed it standing
  // (operator 2026-09-29).
  const maxDrop = W * MAX_CROSS_SLOPE
  const faceAt = (node.thickness ?? 0.15) / 2 / W
  const yAt = (s: number) => {
    const c = at(s, 0)
    const side = (z: number) => {
      const v = at(s, z)
      const drop = c - v
      if (drop <= 0.01) return v
      const atFace = c - at(s, z * faceAt)
      return drop <= maxDrop && atFace >= drop * faceAt * 0.5 ? v : c
    }
    return Math.max(0.02, Math.min(top, Math.min(side(W), c, side(-W))))
  }
  for (let i = 0; i < n; i++) {
    const s = -ext + ((len + 2 * ext) * i) / (n - 1)
    const y = yAt(s)
    if (s >= 0 && s <= len && y + TOP_SINK < top - TRIM_MIN_M) needs = true
    pts.push({ s, y })
  }
  if (!needs) return null
  // Where one roof ends and a lower one takes over, a clean step a little
  // inside the higher roof, as the preview does (see _sharpenSteps): joined
  // straight between two samples, the top sloped across the gap and a
  // wedge of wall stood in front of the higher roof's gable in the render
  // (operator 2026-10-03).
  const added: { s: number; y: number }[] = []
  const dropped = new Set<{ s: number; y: number }>()
  for (let i = 0; i + 1 < pts.length; i++) {
    const A = pts[i]!
    const B = pts[i + 1]!
    if (Math.abs(B.y - A.y) <= STEP_JUMP_M) continue
    let lo = A.s
    let hi = B.s
    const mid = (A.y + B.y) / 2
    const aHigh = A.y > B.y
    for (let k = 0; k < 12; k++) {
      const m = (lo + hi) / 2
      if (yAt(m) > mid === aHigh) lo = m
      else hi = m
    }
    const xs = aHigh ? lo - STEP_INSET_M : hi + STEP_INSET_M
    const yHigh = yAt(aHigh ? lo : hi)
    const yLow = yAt(aHigh ? hi : lo)
    for (const p of pts) {
      if (aHigh ? p.s > xs - 2e-4 && p.s < hi : p.s > lo && p.s < xs + 2e-4) dropped.add(p)
    }
    // 2 mm apart: distinct after the export's 1 mm rounding, so the
    // pipeline cuts the wall twice and the step stands vertical.
    if (aHigh) added.push({ s: xs - 1e-3, y: yHigh }, { s: xs + 1e-3, y: yLow })
    else added.push({ s: xs - 1e-3, y: yLow }, { s: xs + 1e-3, y: yHigh })
  }
  if (added.length) {
    const kept = [...pts.filter((p) => !dropped.has(p)), ...added].sort((p, q) => p.s - q.s)
    pts.length = 0
    pts.push(...kept)
  }
  // Past either end the top never rises above its height AT that end. The
  // pipeline cuts the wall only at profile points between its ends, so a
  // higher roof (or a step) just past an end was joined straight to the
  // next cut inside -- a wedge sloping up across the wall, metres high
  // (operator 2026-10-04: L1 walls sticking out of the render).
  // Heights at the ends as profiled -- after the steps, which may have been
  // moved past an end.
  const yOn = (s: number) => {
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1]!
      const b = pts[i]!
      if (s <= b.s) return a.y + ((b.y - a.y) * (s - a.s)) / (b.s - a.s || 1)
    }
    return pts[pts.length - 1]!.y
  }
  const y0 = yOn(0)
  const y1 = yOn(len)
  for (const p of pts) {
    if (p.s < 0) p.y = Math.min(p.y, y0)
    else if (p.s > len) p.y = Math.min(p.y, y1)
  }
  // Drop points on a straight line between their neighbours (1 mm).
  const out: { s: number; y: number }[] = [pts[0]!]
  for (let i = 1; i < pts.length - 1; i++) {
    const a = out[out.length - 1]!
    const b = pts[i]!
    const c = pts[i + 1]!
    const yLine = a.y + ((c.y - a.y) * (b.s - a.s)) / (c.s - a.s || 1)
    if (Math.abs(b.y - yLine) > 0.001) out.push(b)
  }
  out.push(pts[pts.length - 1]!)
  return out.map((p) => ({ s: Math.round(p.s * 1000) / 1000, y: Math.round(p.y * 1000) / 1000 }))
}

/**
 * The preview's own trim of a straight wall, for the render pipeline: the
 * cross-sections clipWallGeometry cuts with, as [s, yl, yc, yr] -- s metres
 * along the wall from its start (may run past either end), absolute heights
 * at the left face side (+w, the wall's left looking from start to end), the
 * centreline and the right (-w). The pipeline cuts the wall at every s and
 * down its centreline and puts each top vertex on this field, so render and
 * preview trim the same wall (operator 2026-10-04: "the main reason I asked
 * for the preview is that I can see what I get before render"). Points on a
 * straight line with their neighbours (1 mm, all three heights) are dropped.
 * Null when the roof doesn't trim the wall; straight walls only.
 */
export function wallRoofCap(
  node: WallNode,
  slabY: number,
  ctx: RoofContext,
): { w: number; pts: [number, number, number, number][] } | null {
  const f = wallTrimSections(node, slabY, ctx)
  if (!f) return null
  const pts = f.sections.map((q) => [q.c[0], f.baseY + q.yl, f.baseY + q.yc, f.baseY + q.yr] as [number, number, number, number])
  const out: typeof pts = [pts[0]!]
  for (let i = 1; i < pts.length - 1; i++) {
    const a = out[out.length - 1]!
    const b = pts[i]!
    const c = pts[i + 1]!
    const k = (b[0] - a[0]) / (c[0] - a[0] || 1)
    if ([1, 2, 3].some((j) => Math.abs(b[j]! - (a[j]! + (c[j]! - a[j]!) * k)) > 0.001)) out.push(b)
  }
  out.push(pts[pts.length - 1]!)
  const r4 = (v: number) => Math.round(v * 10000) / 10000
  return { w: r4(f.W), pts: out.map((q) => q.map(r4) as [number, number, number, number]) }
}

/** Total triangle area of a geometry. */
function _area(g: THREE.BufferGeometry): number {
  const p = g.getAttribute('position')
  if (!p) return 0
  const ix = g.getIndex()
  const n = ix ? ix.count : p.count
  const a = new THREE.Vector3()
  const b = new THREE.Vector3()
  const c = new THREE.Vector3()
  let sum = 0
  for (let k = 0; k + 2 < n; k += 3) {
    a.fromBufferAttribute(p, ix ? ix.getX(k) : k)
    b.fromBufferAttribute(p, ix ? ix.getX(k + 1) : k + 1)
    c.fromBufferAttribute(p, ix ? ix.getX(k + 2) : k + 2)
    sum += b.sub(a).cross(c.sub(a)).length() / 2
  }
  return sum
}

/** Tiny prism nudges to retry a CSG that came back wrong (coplanar faces). */
const CSG_NUDGES: [number, number, number][] = [
  [0, 0, 0],
  [1.3e-4, 0.7e-4, -0.9e-4],
  [-1.1e-4, 1.7e-4, 0.6e-4],
  [0.6e-4, -1.4e-4, 1.2e-4],
]

/**
 * src ∩ prism, or null if the CSG fails (the wall then shows untrimmed).
 * `keepRatio`: the share of the wall the roof profile leaves (0..1). The CSG
 * sometimes misclassifies and drops most of a wall (operator 2026-10-02:
 * whole L0 walls missing in the preview, an L1 wall at 4% of what the roof
 * allows); a result well short of that is retried with the prism nudged a
 * fraction of a millimetre, and if every try fails the wall stays untrimmed.
 */
function _intersect(
  src: THREE.BufferGeometry,
  makePrism: () => THREE.BufferGeometry,
  id: string,
  keepRatio?: number,
): THREE.BufferGeometry | null {
  const srcArea = keepRatio != null ? _area(src) : 0
  for (const [nx, ny, nz] of CSG_NUDGES) {
    const g = _intersectOnce(src, makePrism(), id, nx, ny, nz)
    if (!g) return null
    if (keepRatio == null || keepRatio < 0.05) return g
    if (_area(g) >= 0.75 * srcArea * keepRatio) return g
    g.dispose()
  }
  console.warn('roof-wall-clip: trim kept far less of the wall than the roof allows; kept untrimmed', id)
  return null
}

function _intersectOnce(
  src: THREE.BufferGeometry,
  prism: THREE.BufferGeometry,
  id: string,
  nx: number,
  ny: number,
  nz: number,
): THREE.BufferGeometry | null {
  try {
    if (nx || ny || nz) prism.translate(nx, ny, nz)
    const a = new Brush(src)
    a.updateMatrixWorld()
    const b = new Brush(prism)
    b.updateMatrixWorld()
    const res = clipEvaluator.evaluate(a, b, INTERSECTION) as Brush
    prism.dispose()
    const g = res.geometry
    // A trimmed wall can only ever be SMALLER than the wall. When the CSG
    // misclassifies (seen 2026-09-26 on a diagonal wall of plan c39200da),
    // it hands back part of the trimming prism instead — a 150 m column
    // through the house. Keep the untrimmed wall rather than that.
    src.computeBoundingBox()
    g.computeBoundingBox()
    const sb = src.boundingBox!
    const gb = g.boundingBox!
    const M = 0.01
    if (
      g.getAttribute('position')?.count &&
      (gb.min.x < sb.min.x - M || gb.min.y < sb.min.y - M || gb.min.z < sb.min.z - M ||
        gb.max.x > sb.max.x + M || gb.max.y > sb.max.y + M || gb.max.z > sb.max.z + M)
    ) {
      console.warn('roof-wall-clip: trim came back larger than the wall; kept untrimmed', id)
      g.dispose()
      return null
    }
    g.computeVertexNormals()
    return g
  } catch (e) {
    prism.dispose()
    console.warn('roof-wall-clip: wall clip failed', id, e)
    return null
  }
}

/**
 * Curved walls. The mesh uses the same wall-local frame as a straight wall
 * (origin at start, x along the CHORD, z across it), but the body bends away
 * from the chord, so a prism extruded straight across z would read the roof
 * at the wrong place. Instead the prism is lofted along the arc itself: a
 * band a little wider than the wall, following the centreline, its top at
 * the roof height sampled at each point of the arc.
 */
function _clipArcWall(
  src: THREE.BufferGeometry,
  node: WallNode,
  slabY: number,
  ctx: RoofContext,
): THREE.BufferGeometry | null {
  const start = node.start
  const end = node.end
  const bulge = node.bulge ?? 0
  const arc = arcParamsFromBulge(start, end, bulge)
  if (!arc) return null
  const chord = Math.hypot(end[0] - start[0], end[1] - start[1])
  if (chord < 1e-3) return null
  const lv = node.parentId ? ctx.levels.get(node.parentId) : undefined
  const baseY = (lv ? lv.elev : 0) + slabY
  const top = node.height ?? 2.7
  const halfT = (node.thickness ?? 0.15) / 2
  // Wide enough to hold the wall, never so wide the inner edge folds over.
  const W = Math.min(halfT + SIDE_MARGIN, arc.radius * 0.8)
  if (W <= halfT) return null

  // Centreline: 0.5 m straight run-out along each end tangent (like the
  // straight prism's overshoot), then the arc at <= SAMPLE_STEP spacing.
  let pts = tessellateArc(start, end, bulge, SAMPLE_STEP) as [number, number][]
  if (pts.length > MAX_SAMPLES) pts = tessellateArc(start, end, bulge, arcLength(start, end, bulge) / MAX_SAMPLES) as [number, number][]
  const t0 = tangentAtStart(start, end, bulge)
  const t1 = tangentAtEnd(start, end, bulge)
  const line: { p: [number, number]; onWall: boolean }[] = [
    { p: [start[0] - t0[0] * 0.5, start[1] - t0[1] * 0.5], onWall: false },
    ...pts.map((p) => ({ p, onWall: true })),
    { p: [end[0] + t1[0] * 0.5, end[1] + t1[1] * 0.5], onWall: false },
  ]

  // World -> wall-local (same transform as generateExtrudedWall).
  const a = Math.atan2(end[1] - start[1], end[0] - start[0])
  const ca = Math.cos(a)
  const sa = Math.sin(a)
  const toLocal = (X: number, Z: number): [number, number] => {
    const dx = X - start[0]
    const dz = Z - start[1]
    return [dx * ca + dz * sa, -dx * sa + dz * ca]
  }

  const roofAt = (X: number, Z: number) => {
    const h = ctx.wallHeightAt(X, Z)
    return h == null ? OPEN_SKY : Math.min(OPEN_SKY, h - baseY - TOP_SINK)
  }
  const sections: Section[] = []
  let needs = false
  for (let i = 0; i < line.length; i++) {
    const here = line[i]!.p
    const prev = line[Math.max(0, i - 1)]!.p
    const next = line[Math.min(line.length - 1, i + 1)]!.p
    const tx = next[0] - prev[0]
    const tz = next[1] - prev[1]
    const m = Math.hypot(tx, tz)
    if (m < 1e-9) continue
    const nx = -tz / m
    const nz = tx / m
    const L: [number, number] = [here[0] + nx * W, here[1] + nz * W]
    const R: [number, number] = [here[0] - nx * W, here[1] - nz * W]
    const sec: Section = {
      l: toLocal(L[0], L[1]),
      c: toLocal(here[0], here[1]),
      r: toLocal(R[0], R[1]),
      yl: roofAt(L[0], L[1]),
      yc: roofAt(here[0], here[1]),
      yr: roofAt(R[0], R[1]),
    }
    if (line[i]!.onWall && Math.min(sec.yl, sec.yc, sec.yr) + TOP_SINK < top - TRIM_MIN_M) needs = true
    sections.push(sec)
  }
  if (!needs || sections.length < 2) return null
  return _intersect(src, () => _loftPrism(sections), node.id)
}

/**
 * Closed solid lofted through cross-sections (wall-local). Each section is a
 * vertical pentagon: flat bottom at y = -50, top running l -> c -> r through
 * the roof heights there. The roof is a min of planes (never bulges up), so
 * a top interpolated between samples stays under it. Orientation is fixed
 * afterwards from the signed volume, so the caller needn't care which side
 * l is on.
 */
function _loftPrism(sections: Section[]): THREE.BufferGeometry {
  const B = -50
  const pos: number[] = []
  const quad = (a: number[], b: number[], c: number[], d: number[]) => {
    pos.push(...a, ...b, ...c, ...a, ...c, ...d)
  }
  const ring = (s: Section) => [
    [s.l[0], B, s.l[1]],
    [s.r[0], B, s.r[1]],
    [s.r[0], s.yr, s.r[1]],
    [s.c[0], s.yc, s.c[1]],
    [s.l[0], s.yl, s.l[1]],
  ]
  const K = 5
  for (let i = 0; i < sections.length - 1; i++) {
    const A = ring(sections[i]!)
    const C = ring(sections[i + 1]!)
    for (let k = 0; k < K; k++) {
      const k2 = (k + 1) % K
      quad(A[k]!, C[k]!, C[k2]!, A[k2]!)
    }
  }
  // End caps, fanned from the bottom-left corner.
  const first = ring(sections[0]!)
  const last = ring(sections[sections.length - 1]!)
  for (let k = 1; k < K - 1; k++) {
    pos.push(...first[0]!, ...first[k + 1]!, ...first[k]!)
    pos.push(...last[0]!, ...last[k]!, ...last[k + 1]!)
  }

  // Signed volume; flip every triangle if the loft came out inside-out.
  let vol = 0
  for (let i = 0; i < pos.length; i += 9) {
    const [ax, ay, az, bx, by, bz, cx, cy, cz] = pos.slice(i, i + 9) as number[] as [
      number, number, number, number, number, number, number, number, number,
    ]
    vol += ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx)
  }
  if (vol < 0) {
    for (let i = 0; i < pos.length; i += 9) {
      for (let j = 0; j < 3; j++) {
        const t = pos[i + 3 + j]!
        pos[i + 3 + j] = pos[i + 6 + j]!
        pos[i + 6 + j] = t
      }
    }
  }
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
  g.computeVertexNormals()
  return g
}

/** True when the roof passes below this window/door's centre. The preview
 *  hides such openings, and the render export leaves them out (roof-export). */
export function openingCoveredByRoof(
  node: { wallId?: string; parentId?: string; position?: number[] },
  nodes: Record<string, AnyNode>,
  ctx: RoofContext,
): boolean {
  const wall = nodes[node.wallId ?? node.parentId ?? ''] as WallNode | undefined
  if (!wall || wall.type !== 'wall') return false
  // A window a dormer follows is replaced by the dormer's own window.
  const id = (node as { id?: string }).id
  if (id) {
    for (const [, r] of ctx.segments) {
      const ds = (r.placement.seg as { dormers?: { windowId?: string }[] }).dormers
      if (ds?.some((d) => d.windowId === id)) return true
    }
  }
  // Opening position is arc length along the wall (chord length if straight).
  const bulge = wall.bulge ?? 0
  const len = arcLength(wall.start, wall.end, bulge)
  if (len < 1e-6) return false
  const along = node.position?.[0] ?? 0
  const { point } = pointAndTangentAtT(wall.start, wall.end, bulge, along / len)
  const h = ctx.wallHeightAt(point[0], point[1])
  if (h == null) return false
  const lv = wall.parentId ? ctx.levels.get(wall.parentId) : undefined
  const cy = (lv ? lv.elev : 0) + (node.position?.[1] ?? 1)
  return cy > h
}
