import { isStraight, tessellateArc } from '../../lib/arc-math'
import type { WallNode } from '../../schema'
import { type Point2D, pointToKey, type WallMiterData } from './wall-mitering'

export const DEFAULT_WALL_THICKNESS = 0.1
export const DEFAULT_WALL_HEIGHT = 2.5

export function getWallThickness(wallNode: WallNode): number {
  return wallNode.thickness ?? DEFAULT_WALL_THICKNESS
}

export function getWallPlanFootprint(wallNode: WallNode, miterData: WallMiterData): Point2D[] {
  // Ritn3D: curved walls. When bulge != 0 the centerline is an arc, so the
  // footprint becomes two concentric tessellated arcs joined at the endpoints
  // (not a 4-point rectangle). Junction-mitering on arcs is Phase 4 — until
  // then arc walls butt-join at endpoints, which looks fine for floor plans.
  // Straight-wall code path below is byte-identical to the original Pascal
  // version, so existing scenes round-trip exactly.
  if (!isStraight(wallNode.bulge)) {
    return getArcWallPlanFootprint(wallNode)
  }

  const { junctionData } = miterData

  const wallStart: Point2D = { x: wallNode.start[0], y: wallNode.start[1] }
  const wallEnd: Point2D = { x: wallNode.end[0], y: wallNode.end[1] }
  const thickness = getWallThickness(wallNode)
  const halfT = thickness / 2

  const v = { x: wallEnd.x - wallStart.x, y: wallEnd.y - wallStart.y }
  const L = Math.sqrt(v.x * v.x + v.y * v.y)
  if (L < 1e-9) {
    return []
  }
  const nUnit = { x: -v.y / L, y: v.x / L }

  const keyStart = pointToKey(wallStart)
  const keyEnd = pointToKey(wallEnd)

  const startJunction = junctionData.get(keyStart)?.get(wallNode.id)
  const endJunction = junctionData.get(keyEnd)?.get(wallNode.id)

  const pStartLeft: Point2D = startJunction?.left || {
    x: wallStart.x + nUnit.x * halfT,
    y: wallStart.y + nUnit.y * halfT,
  }
  const pStartRight: Point2D = startJunction?.right || {
    x: wallStart.x - nUnit.x * halfT,
    y: wallStart.y - nUnit.y * halfT,
  }

  // Junction offsets are stored relative to the outgoing direction.
  const pEndLeft: Point2D = endJunction?.right || {
    x: wallEnd.x + nUnit.x * halfT,
    y: wallEnd.y + nUnit.y * halfT,
  }
  const pEndRight: Point2D = endJunction?.left || {
    x: wallEnd.x - nUnit.x * halfT,
    y: wallEnd.y - nUnit.y * halfT,
  }

  const polygon: Point2D[] = [pStartRight, pEndRight]
  if (endJunction) {
    polygon.push(wallEnd)
  }
  polygon.push(pEndLeft, pStartLeft)
  if (startJunction) {
    polygon.push(wallStart)
  }

  return polygon
}

/**
 * Footprint for an arc wall (bulge != 0). Tessellates the centerline into N+1
 * points, then offsets each point by ±halfT along the LOCAL normal at that
 * point (the chord-to-next direction's perpendicular). The result is a closed
 * polygon: outer arc forward + inner arc reverse.
 *
 * Local normal at each tessellated vertex is the perpendicular to the segment
 * between this point and the next — that approximates the arc's radial
 * direction with no expensive recomputation, and the small per-segment error
 * is invisible at the segment lengths we use (default 0.1 m, so the angle
 * error between segment normal and true radial is well under a degree).
 *
 * No junction-mitering here yet — the start/end caps just sit perpendicular
 * to the local tangent. Mitering for arc joins is Phase 4.
 */
function getArcWallPlanFootprint(wallNode: WallNode): Point2D[] {
  const start: readonly [number, number] = wallNode.start
  const end: readonly [number, number] = wallNode.end
  const halfT = getWallThickness(wallNode) / 2

  // Centerline tessellation. tessellateArc returns [start, ..., end] with
  // segment length tuned for visual smoothness; on a 5 m wall with bulge 0.5
  // we get ~50 segments — overkill for 2D SVG but cheap.
  const centerline = tessellateArc(start, end, wallNode.bulge)
  if (centerline.length < 2) return []

  // Compute outer/inner offset for every centerline vertex. Normal at vertex
  // i uses the segment direction to vertex i+1 for interior vertices, and the
  // previous segment for the last vertex.
  const outer: Point2D[] = []
  const inner: Point2D[] = []
  for (let i = 0; i < centerline.length; i++) {
    const here = centerline[i]!
    const next = i + 1 < centerline.length ? centerline[i + 1]! : centerline[i - 1]!
    const flip = i + 1 < centerline.length ? 1 : -1
    const dx = (next[0] - here[0]) * flip
    const dy = (next[1] - here[1]) * flip
    const m = Math.hypot(dx, dy)
    if (m < 1e-12) continue
    // +90° perpendicular: (-dy, dx) / m. This is the "left" side of the
    // local segment direction — same handedness as straight walls.
    const nx = -dy / m
    const ny = dx / m
    outer.push({ x: here[0] + nx * halfT, y: here[1] + ny * halfT })
    inner.push({ x: here[0] - nx * halfT, y: here[1] - ny * halfT })
  }

  // Build closed polygon: outer forward + inner reverse.
  const polygon: Point2D[] = [...outer]
  for (let i = inner.length - 1; i >= 0; i--) {
    polygon.push(inner[i]!)
  }
  return polygon
}
