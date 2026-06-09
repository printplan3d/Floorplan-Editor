/**
 * Arc geometry helpers for curved walls.
 *
 * WallNode stores the arc as a single `bulge` field (DXF convention):
 *   bulge = tan(included_arc_angle / 4)
 *
 * That single scalar — combined with the wall's `start` and `end` 2D points —
 * uniquely defines an arc. Everything below derives center / radius / angles /
 * tessellation from those three inputs.
 *
 * Sign convention:
 *   bulge > 0 -> arc bulges LEFT of the start->end chord
 *   bulge < 0 -> arc bulges RIGHT
 *   "Left" is +90° from the chord direction (standard math conventions).
 *
 * Why bulge (not center+radius+angles in the schema):
 *   - Single scalar, backwards-compatible default `0` (= straight)
 *   - Stays finite at the straight-line limit (center/radius blow up)
 *   - Standard CAD interchange format — DXF, DWG, IFC all use bulge
 *   - Trivial to derive every other arc quantity on demand
 */

export type Point2 = readonly [number, number]

/** Numerical threshold below which we treat the wall as straight. */
export const STRAIGHT_BULGE_EPSILON = 1e-6

export function isStraight(bulge: number): boolean {
  return Math.abs(bulge) < STRAIGHT_BULGE_EPSILON
}

/** Euclidean distance between two 2D points. */
function dist(a: Point2, b: Point2): number {
  const dx = b[0] - a[0]
  const dy = b[1] - a[1]
  return Math.hypot(dx, dy)
}

/**
 * Derived arc parameters. `bulge = 0` returns `null` — callers should
 * branch on the straight-line case explicitly (they probably already do).
 */
export interface ArcParams {
  /** Centre of the arc circle in level coordinates. */
  center: Point2
  /** Circle radius (always positive). */
  radius: number
  /** Angle from center to `start`, radians, in [-π, π]. */
  startAngle: number
  /** Angle from center to `end`, radians, in [-π, π]. */
  endAngle: number
  /** Sweep angle from start to end, signed (matches sign of bulge). Radians. */
  sweepAngle: number
  /** True if the arc sweeps counterclockwise (bulge > 0). */
  ccw: boolean
}

/**
 * Convert (start, end, bulge) -> ArcParams. Returns `null` for straight walls
 * (|bulge| below epsilon) so callers can fall back to line math.
 *
 * Derivation:
 *   chord length c = |end - start|
 *   sagitta     s = c * |b| / 2          (perpendicular distance chord -> arc apex)
 *   radius      r = c * (1 + b^2) / (4 * |b|)
 *   sweep angle θ = 4 * atan(b)          (signed)
 *   center sits perpendicular to the chord midpoint, on the +90° side
 *   (relative to start->end) when bulge > 0.
 */
export function arcParamsFromBulge(start: Point2, end: Point2, bulge: number): ArcParams | null {
  if (isStraight(bulge)) return null

  const chord = dist(start, end)
  if (chord === 0) return null // degenerate wall

  const absB = Math.abs(bulge)
  const radius = (chord * (1 + bulge * bulge)) / (4 * absB)

  // Chord midpoint
  const mx = (start[0] + end[0]) / 2
  const my = (start[1] + end[1]) / 2

  // Unit perpendicular to the chord, rotated +90° from start->end direction
  // (so it points "left" in the standard math sense). For bulge>0 the centre
  // is on the OPPOSITE side from where the arc bulges — i.e. we step from the
  // midpoint AWAY from the arc apex by (radius - sagitta).
  const dx = (end[0] - start[0]) / chord
  const dy = (end[1] - start[1]) / chord
  const perpX = -dy // +90° rotation of (dx, dy)
  const perpY = dx

  // Distance from chord midpoint to centre (positive number).
  // d = sqrt(r^2 - (c/2)^2)
  const halfChord = chord / 2
  const distToCenter = Math.sqrt(Math.max(0, radius * radius - halfChord * halfChord))

  // Direction sign: arc bulges in the +perp direction when bulge>0, so the
  // centre is in the -perp direction. (Geometric: the arc apex is on the
  // opposite side of the chord from the centre.)
  const sign = bulge > 0 ? -1 : 1
  const cx = mx + sign * perpX * distToCenter
  const cy = my + sign * perpY * distToCenter
  const center: Point2 = [cx, cy]

  const startAngle = Math.atan2(start[1] - cy, start[0] - cx)
  const endAngle = Math.atan2(end[1] - cy, end[0] - cx)
  const sweepAngle = 4 * Math.atan(bulge)

  return {
    center,
    radius,
    startAngle,
    endAngle,
    sweepAngle,
    ccw: bulge > 0,
  }
}

/**
 * Arc length of the wall. Returns the straight-line distance when bulge ≈ 0.
 * Needed for door/window positioning on curved walls — `position_along_wall`
 * is expressed as 0..1 of arc length, not chord length.
 */
export function arcLength(start: Point2, end: Point2, bulge: number): number {
  if (isStraight(bulge)) return dist(start, end)
  const p = arcParamsFromBulge(start, end, bulge)
  if (!p) return dist(start, end)
  return p.radius * Math.abs(p.sweepAngle)
}

/**
 * Perpendicular distance from the chord midpoint to the arc apex. Useful for
 * drawing a draggable midpoint handle.
 */
export function arcSagitta(start: Point2, end: Point2, bulge: number): number {
  if (isStraight(bulge)) return 0
  return (dist(start, end) * Math.abs(bulge)) / 2
}

/**
 * The 2D point at the arc's midpoint (the bulge apex). For a straight wall
 * this is the chord midpoint. Used by the edit-handle UI in a later phase.
 */
export function arcMidpoint(start: Point2, end: Point2, bulge: number): Point2 {
  const mx = (start[0] + end[0]) / 2
  const my = (start[1] + end[1]) / 2
  if (isStraight(bulge)) return [mx, my]

  const chord = dist(start, end)
  if (chord === 0) return [mx, my]
  const dx = (end[0] - start[0]) / chord
  const dy = (end[1] - start[1]) / chord
  // Unit perpendicular rotated +90° from the start->end direction.
  const perpX = -dy
  const perpY = dx
  // Sign of bulge picks which side of the chord we go.
  const offset = (chord * bulge) / 2
  return [mx + perpX * offset, my + perpY * offset]
}

/**
 * Compute a wall's bulge given three points the user clicked: start, end,
 * and a mid-point through which the arc should pass. Used by the arc-wall
 * drafting tool (the user drags after the second click to set the bulge).
 *
 * Returns `0` when the three points are collinear (treat as a straight wall).
 *
 * Math: bulge = (sagitta * 2) / chord with sign from the side `mid` falls on.
 */
export function bulgeFromThreePoints(start: Point2, end: Point2, mid: Point2): number {
  const chord = dist(start, end)
  if (chord === 0) return 0

  // Perpendicular distance from `mid` to the chord line, SIGNED — positive
  // when `mid` is on the +perp (left) side of the chord.
  const dx = (end[0] - start[0]) / chord
  const dy = (end[1] - start[1]) / chord
  // (mid - start) projected on the +90° perpendicular of (dx, dy).
  const vx = mid[0] - start[0]
  const vy = mid[1] - start[1]
  const perp = vx * -dy + vy * dx // signed sagitta-like value

  // The midpoint of an arc with bulge `b` over chord `c` sits at perp distance
  // `c * b / 2` from the chord midpoint. But we measured from the chord
  // *line*, not midpoint — for an arc the apex lies at the chord midpoint, so
  // the math is the same when `mid` is at the chord's parametric centre. We
  // approximate: bulge = 2 * perp / chord. Sufficient for the drafting tool
  // since the user re-sees the live preview and adjusts.
  return (2 * perp) / chord
}

/**
 * Tessellate an arc wall edge into a polyline. Returns N+1 points along the
 * arc from `start` to `end`. Used by the wall footprint + extrusion in the
 * rendering phase (a THREE.Shape can't store true arcs in a way ExtrudeGeometry
 * tolerates well — Pascal already builds 4-point polygons, we expand to many).
 *
 * `segmentLengthMeters` caps the linear length of any one segment, so tight
 * curves get more points automatically. Pascal's grid step is ~0.5m so 0.1m
 * gives ~5 segments per grid cell on a tightly-curved wall — visually smooth.
 */
export function tessellateArc(
  start: Point2,
  end: Point2,
  bulge: number,
  segmentLengthMeters = 0.1,
): Point2[] {
  if (isStraight(bulge)) return [start, end]
  const p = arcParamsFromBulge(start, end, bulge)
  if (!p) return [start, end]

  const len = p.radius * Math.abs(p.sweepAngle)
  const nSegments = Math.max(2, Math.ceil(len / segmentLengthMeters))
  const points: Point2[] = []
  for (let i = 0; i <= nSegments; i++) {
    const t = i / nSegments
    const angle = p.startAngle + p.sweepAngle * t
    points.push([
      p.center[0] + p.radius * Math.cos(angle),
      p.center[1] + p.radius * Math.sin(angle),
    ])
  }
  // Snap exact endpoints to avoid floating-point drift at the boundaries —
  // mitering math at junctions cares about exact equality.
  points[0] = start
  points[points.length - 1] = end
  return points
}

/**
 * Point on the arc + unit tangent at parametric arc-length t (0 = start,
 * 1 = end). For a straight wall this is just linear interpolation along the
 * chord. Used to render and place doors / windows on curved walls — the
 * opening's `position` along the wall is in arc-length units, and the
 * tangent gives the local "wall direction" so the opening rectangle stays
 * perpendicular to the wall.
 */
export function pointAndTangentAtT(
  start: Point2,
  end: Point2,
  bulge: number,
  t: number,
): { point: Point2; tangent: Point2 } {
  const clampedT = Math.max(0, Math.min(1, t))
  if (isStraight(bulge)) {
    const point: Point2 = [
      start[0] + (end[0] - start[0]) * clampedT,
      start[1] + (end[1] - start[1]) * clampedT,
    ]
    const chord = dist(start, end)
    const tangent: Point2 = chord === 0
      ? [1, 0]
      : [(end[0] - start[0]) / chord, (end[1] - start[1]) / chord]
    return { point, tangent }
  }
  const p = arcParamsFromBulge(start, end, bulge)
  if (!p) {
    return { point: start, tangent: [1, 0] }
  }
  const angle = p.startAngle + p.sweepAngle * clampedT
  const cos = Math.cos(angle)
  const sin = Math.sin(angle)
  const point: Point2 = [p.center[0] + p.radius * cos, p.center[1] + p.radius * sin]
  // Tangent: perpendicular to the radial direction (cos, sin), rotated in
  // the sweep direction.
  const sign = p.ccw ? 1 : -1
  const tangent: Point2 = [-sign * sin, sign * cos]
  return { point, tangent }
}

/**
 * Unit tangent direction at the start of the wall (points INTO the wall from
 * `start`). For a straight wall this is just normalize(end - start). For an
 * arc it's the tangent of the circle at the start point. Used by the mitering
 * phase to compute join angles.
 */
export function tangentAtStart(start: Point2, end: Point2, bulge: number): Point2 {
  const chord = dist(start, end)
  if (chord === 0) return [0, 0]
  if (isStraight(bulge)) {
    return [(end[0] - start[0]) / chord, (end[1] - start[1]) / chord]
  }
  const p = arcParamsFromBulge(start, end, bulge)
  if (!p) return [(end[0] - start[0]) / chord, (end[1] - start[1]) / chord]
  // Tangent at start = perpendicular to (start - center), rotated so it heads
  // in the direction of the sweep.
  const rx = start[0] - p.center[0]
  const ry = start[1] - p.center[1]
  // Rotate +90° (counterclockwise) for ccw sweep, -90° for cw.
  const sign = p.ccw ? 1 : -1
  const tx = -sign * ry
  const ty = sign * rx
  const m = Math.hypot(tx, ty)
  if (m === 0) return [0, 0]
  return [tx / m, ty / m]
}

/**
 * Unit tangent direction at the end of the wall (points OUT of the wall at
 * `end`, i.e. the direction it WOULD continue if extended). Mirror of
 * tangentAtStart for the join math at the other end.
 */
export function tangentAtEnd(start: Point2, end: Point2, bulge: number): Point2 {
  const chord = dist(start, end)
  if (chord === 0) return [0, 0]
  if (isStraight(bulge)) {
    return [(end[0] - start[0]) / chord, (end[1] - start[1]) / chord]
  }
  const p = arcParamsFromBulge(start, end, bulge)
  if (!p) return [(end[0] - start[0]) / chord, (end[1] - start[1]) / chord]
  const rx = end[0] - p.center[0]
  const ry = end[1] - p.center[1]
  const sign = p.ccw ? 1 : -1
  const tx = -sign * ry
  const ty = sign * rx
  const m = Math.hypot(tx, ty)
  if (m === 0) return [0, 0]
  return [tx / m, ty / m]
}
