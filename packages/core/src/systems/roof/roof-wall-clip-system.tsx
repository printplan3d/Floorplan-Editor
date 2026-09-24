import { useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import { Brush, Evaluator, INTERSECTION } from 'three-bvh-csg'
import { sceneRegistry } from '../../hooks/scene-registry/scene-registry'
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
        const covered = _openingCovered(node, nodes, ctx)
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
  if ((node.bulge ?? 0) !== 0) return null // arc walls: not handled yet
  const [sx, sz] = node.start
  const [ex, ez] = node.end
  const len = Math.hypot(ex - sx, ez - sz)
  if (len < 1e-3) return null
  const dx = (ex - sx) / len
  const dz = (ez - sz) / len
  const lv = node.parentId ? ctx.levels.get(node.parentId) : undefined
  const baseY = (lv ? lv.elev : 0) + slabY
  const top = node.height ?? 2.7

  // Sample the roof height along the wall's centreline, in wall-local x/y.
  const x0 = -0.5
  const x1 = len + 0.5
  const n = Math.min(MAX_SAMPLES, Math.max(2, Math.ceil((x1 - x0) / SAMPLE_STEP) + 1))
  const xs: number[] = []
  const ys: number[] = []
  let needs = false
  for (let i = 0; i < n; i++) {
    const x = x0 + ((x1 - x0) * i) / (n - 1)
    const h = ctx.heightAt(sx + dx * x, sz + dz * x)
    const y = h == null ? OPEN_SKY : Math.min(OPEN_SKY, h - baseY)
    xs.push(x)
    ys.push(y)
    if (x >= 0 && x <= len && y < top - 0.005) needs = true
  }
  if (!needs) return null

  try {
    const prism = _profilePrism(xs, ys)
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
    console.warn('roof-wall-clip: wall clip failed', node.id, e)
    return null
  }
}

/**
 * Closed prism in wall-local space: bottom at y = -50, top following the
 * sampled roof profile, extruded well past the wall thickness in z.
 */
function _profilePrism(xs: number[], ys: number[]): THREE.BufferGeometry {
  const Z = 5
  const B = -50
  const pos: number[] = []
  const quad = (a: number[], b: number[], c: number[], d: number[]) => {
    pos.push(...a, ...b, ...c, ...a, ...c, ...d)
  }
  const last = xs.length - 1
  for (let i = 0; i < last; i++) {
    const xa = xs[i]!
    const xb = xs[i + 1]!
    const ya = ys[i]!
    const yb = ys[i + 1]!
    // Front (+z) and back (-z) faces, as strips between samples.
    quad([xa, B, Z], [xb, B, Z], [xb, yb, Z], [xa, ya, Z])
    quad([xb, B, -Z], [xa, B, -Z], [xa, ya, -Z], [xb, yb, -Z])
    // Top follows the roof; bottom is flat.
    quad([xa, ya, Z], [xb, yb, Z], [xb, yb, -Z], [xa, ya, -Z])
    quad([xa, B, -Z], [xb, B, -Z], [xb, B, Z], [xa, B, Z])
  }
  // End caps.
  quad([xs[0]!, B, -Z], [xs[0]!, B, Z], [xs[0]!, ys[0]!, Z], [xs[0]!, ys[0]!, -Z])
  quad([xs[last]!, B, Z], [xs[last]!, B, -Z], [xs[last]!, ys[last]!, -Z], [xs[last]!, ys[last]!, Z])
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
  g.computeVertexNormals()
  return g
}

/** True when the roof passes below this window/door's centre. */
function _openingCovered(
  node: { wallId?: string; parentId?: string; position?: number[] },
  nodes: Record<string, AnyNode>,
  ctx: RoofContext,
): boolean {
  const wall = nodes[node.wallId ?? node.parentId ?? ''] as WallNode | undefined
  if (!wall || wall.type !== 'wall') return false
  const len = Math.hypot(wall.end[0] - wall.start[0], wall.end[1] - wall.start[1])
  if (len < 1e-6) return false
  const along = node.position?.[0] ?? 0
  const x = wall.start[0] + ((wall.end[0] - wall.start[0]) / len) * along
  const z = wall.start[1] + ((wall.end[1] - wall.start[1]) / len) * along
  const h = ctx.heightAt(x, z)
  if (h == null) return false
  const lv = wall.parentId ? ctx.levels.get(wall.parentId) : undefined
  const cy = (lv ? lv.elev : 0) + (node.position?.[1] ?? 1)
  return cy > h
}
