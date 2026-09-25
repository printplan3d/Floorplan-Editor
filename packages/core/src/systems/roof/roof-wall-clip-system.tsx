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
/** How far past each wall face the roof is sampled. */
const SIDE_MARGIN = 0.05

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
    const h = ctx.heightAt(sx + dx * x - dz * z, sz + dz * x + dx * z)
    return h == null ? OPEN_SKY : Math.min(OPEN_SKY, h - baseY)
  }
  const sections: Section[] = []
  let needs = false
  for (let i = 0; i < n; i++) {
    const x = x0 + ((x1 - x0) * i) / (n - 1)
    const sec: Section = { l: [x, W], c: [x, 0], r: [x, -W], yl: at(x, W), yc: at(x, 0), yr: at(x, -W) }
    if (x >= 0 && x <= len && Math.min(sec.yl, sec.yc, sec.yr) < top - 0.005) needs = true
    sections.push(sec)
  }
  if (!needs) return null
  return _intersect(src, _loftPrism(sections), node.id)
}

/** src ∩ prism, or null if the CSG fails (the wall then shows untrimmed). */
function _intersect(src: THREE.BufferGeometry, prism: THREE.BufferGeometry, id: string): THREE.BufferGeometry | null {
  try {
    const a = new Brush(src)
    a.updateMatrixWorld()
    const b = new Brush(prism)
    b.updateMatrixWorld()
    const res = clipEvaluator.evaluate(a, b, INTERSECTION) as Brush
    prism.dispose()
    const g = res.geometry
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
    const h = ctx.heightAt(X, Z)
    return h == null ? OPEN_SKY : Math.min(OPEN_SKY, h - baseY)
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
    if (line[i]!.onWall && Math.min(sec.yl, sec.yc, sec.yr) < top - 0.005) needs = true
    sections.push(sec)
  }
  if (!needs || sections.length < 2) return null
  return _intersect(src, _loftPrism(sections), node.id)
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
  // Opening position is arc length along the wall (chord length if straight).
  const bulge = wall.bulge ?? 0
  const len = arcLength(wall.start, wall.end, bulge)
  if (len < 1e-6) return false
  const along = node.position?.[0] ?? 0
  const { point } = pointAndTangentAtT(wall.start, wall.end, bulge, along / len)
  const h = ctx.heightAt(point[0], point[1])
  if (h == null) return false
  const lv = wall.parentId ? ctx.levels.get(wall.parentId) : undefined
  const cy = (lv ? lv.elev : 0) + (node.position?.[1] ?? 1)
  return cy > h
}
