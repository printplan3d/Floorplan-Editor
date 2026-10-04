import { type AnyNode, getRoofContext, sceneRegistry, useScene, type ZoneNode } from '@ritn3d/core'
import { useFrame } from '@react-three/fiber'
import { useMemo, useRef } from 'react'
import * as THREE from 'three/webgpu'
import useViewer from '../../store/use-viewer'

/** Bright and saturated: nothing else in a plan is this colour. */
const GAP_COLOR = '#ff00d4'
/** Fill grid step (m). */
const STEP = 0.2
/** Fill kept this far inside a room's outline (its walls' centre lines):
 *  a half wall thickness, a grid step, and a margin. */
const INSET = 0.3
/** ...this far above its floor and below its ceiling or roof. */
const FLOOR_GAP = 0.05
const TOP_GAP = 0.25

/**
 * "Check gaps": every room filled with a flat, unlit magenta volume, kept a
 * little inside its walls and under its roof (or the storey above). The
 * house renders as usual and hides the fill completely -- unless there's an
 * opening: a crack or bleed between roof and walls (or a window) shows
 * magenta (operator 2026-10-04). View only.
 *
 * The first version lit each room with magenta lights instead. Lights shine
 * through walls without shadows, and one 1.6 m up in a room under a low
 * eave sat above the roof and lit its top: false "holes" everywhere.
 */
export function GapCheck() {
  const on = useViewer((s) => s.checkGaps)
  const nodes = useScene((s) => s.nodes) as Record<string, AnyNode>
  const fills = useMemo(() => (on ? buildGapFills(nodes) : []), [on, nodes])
  const material = useMemo(
    () => new THREE.MeshBasicMaterial({ color: GAP_COLOR, side: THREE.DoubleSide }),
    [],
  )
  const refs = useRef<(THREE.Mesh | null)[]>([])

  useFrame(() => {
    // Each fill rides with its storey wherever the level system has put it
    // (stacked, exploded or solo).
    fills.forEach((f, i) => {
      const m = refs.current[i]
      if (!m) return
      const lvl = sceneRegistry.nodes.get(f.levelId)
      if (lvl) {
        lvl.getWorldPosition(m.position)
        m.visible = lvl.visible !== false
      }
    })
  })

  if (!on) return null
  return (
    <>
      {fills.map((f, i) => (
        <mesh
          geometry={f.geometry}
          key={f.id}
          material={material}
          raycast={() => undefined}
          ref={(el) => {
            refs.current[i] = el
          }}
        />
      ))}
    </>
  )
}

type Fill = { id: string; levelId: string; geometry: THREE.BufferGeometry }

export function buildGapFills(nodes: Record<string, AnyNode>): Fill[] {
  const ctx = getRoofContext(nodes)
  const elevs = [...ctx.levels.values()].map((l) => l.elev)
  const out: Fill[] = []
  for (const n of Object.values(nodes)) {
    if (n?.type !== 'zone') continue
    const z = n as ZoneNode
    if (!z.parentId || !Array.isArray(z.polygon) || z.polygon.length < 3) continue
    const lv = ctx.levels.get(z.parentId)
    const elev = lv?.elev ?? 0
    const height = lv?.height ?? 2.7
    const hasAbove = elevs.some((e) => e > elev + 0.5)
    // Fill top, level-local: under the roof over the point, and under the
    // storey above when there is one.
    const topAt = (x: number, zz: number): number => {
      const ceiling = hasAbove ? height - FLOOR_GAP : Infinity
      // The LOWEST roof over the point: where roofs overlap the higher one
      // is cut away inside the lower, and a fill under the higher poked up
      // through the lower one's slope -- magenta that looked like a crack
      // (operator 2026-10-04, where the west roof's gable meets the main).
      const roof = ctx.lowestAt(x, zz)
      const underRoof = roof == null ? Infinity : roof - elev - TOP_GAP
      const t = Math.min(ceiling, underRoof)
      return Number.isFinite(t) ? t : height - FLOOR_GAP
    }
    const g = _fillGeometry(z.polygon as [number, number][], topAt)
    if (g) out.push({ id: z.id, levelId: z.parentId, geometry: g })
  }
  return out
}

/** Distance from (x, z) inside the polygon to its nearest edge; < 0 outside. */
function _insideBy(poly: [number, number][], x: number, z: number): number {
  let inside = false
  let d = Infinity
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, zi] = poly[i]!
    const [xj, zj] = poly[j]!
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside
    const ex = xj - xi
    const ez = zj - zi
    const L2 = ex * ex + ez * ez || 1
    const t = Math.max(0, Math.min(1, ((x - xi) * ex + (z - zi) * ez) / L2))
    d = Math.min(d, Math.hypot(x - (xi + ex * t), z - (zi + ez * t)))
  }
  return inside ? d : -d
}

/**
 * The room's fill as grid cells: a cell is kept when its centre lies INSET
 * inside the outline. Top on topAt at every grid corner (so it follows the
 * roof's slopes, ridges and steps), bottom just over the floor, sides where
 * a kept cell meets a dropped one.
 */
function _fillGeometry(
  poly: [number, number][],
  topAt: (x: number, z: number) => number,
): THREE.BufferGeometry | null {
  let x0 = Infinity
  let x1 = -Infinity
  let z0 = Infinity
  let z1 = -Infinity
  for (const [x, z] of poly) {
    x0 = Math.min(x0, x)
    x1 = Math.max(x1, x)
    z0 = Math.min(z0, z)
    z1 = Math.max(z1, z)
  }
  const nx = Math.ceil((x1 - x0) / STEP)
  const nz = Math.ceil((z1 - z0) / STEP)
  if (nx < 1 || nz < 1 || nx * nz > 200000) return null
  const keep = (i: number, k: number) =>
    i >= 0 && k >= 0 && i < nx && k < nz && _insideBy(poly, x0 + (i + 0.5) * STEP, z0 + (k + 0.5) * STEP) >= INSET
  const kept: boolean[] = []
  for (let k = 0; k < nz; k++) for (let i = 0; i < nx; i++) kept.push(keep(i, k))
  const isKept = (i: number, k: number) => i >= 0 && k >= 0 && i < nx && k < nz && kept[k * nx + i]!
  const tops = new Map<number, number>()
  const top = (i: number, k: number) => {
    const key = k * (nx + 1) + i
    let t = tops.get(key)
    if (t === undefined) {
      t = Math.max(FLOOR_GAP + 0.05, topAt(x0 + i * STEP, z0 + k * STEP))
      tops.set(key, t)
    }
    return t
  }
  const pos: number[] = []
  const quad = (a: number[], b: number[], c: number[], d: number[]) => pos.push(...a, ...b, ...c, ...a, ...c, ...d)
  for (let k = 0; k < nz; k++) {
    for (let i = 0; i < nx; i++) {
      if (!isKept(i, k)) continue
      const xa = x0 + i * STEP
      const xb = xa + STEP
      const za = z0 + k * STEP
      const zb = za + STEP
      const y = FLOOR_GAP
      quad([xa, top(i, k), za], [xa, top(i, k + 1), zb], [xb, top(i + 1, k + 1), zb], [xb, top(i + 1, k), za])
      quad([xa, y, za], [xb, y, za], [xb, y, zb], [xa, y, zb])
      if (!isKept(i - 1, k)) quad([xa, y, za], [xa, y, zb], [xa, top(i, k + 1), zb], [xa, top(i, k), za])
      if (!isKept(i + 1, k)) quad([xb, y, za], [xb, top(i + 1, k), za], [xb, top(i + 1, k + 1), zb], [xb, y, zb])
      if (!isKept(i, k - 1)) quad([xa, y, za], [xa, top(i, k), za], [xb, top(i + 1, k), za], [xb, y, za])
      if (!isKept(i, k + 1)) quad([xa, y, zb], [xb, y, zb], [xb, top(i + 1, k + 1), zb], [xa, top(i, k + 1), zb])
    }
  }
  if (!pos.length) return null
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
  return g
}
