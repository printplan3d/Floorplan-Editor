import {
  computeStairMetrics,
  STAIR_FLIGHT_GAP,
  STAIR_NOSING,
  type StairNode,
} from '@ritn3d/core'

/**
 * Ritn3D 2026-08-07 — how a stair draws in plan.
 *
 * Kept out of floorplan-panel.tsx because it is pure geometry with no React
 * in it, and because the shape has to agree with what Blender builds: the
 * flights, the landing and the direction of travel all come from the same
 * numbers `computeStairMetrics` gives the panel and `_stair_build_params`
 * gives the pipeline. A plan symbol that disagreed with the render would be
 * the same class of lie as a wrong riser readout.
 *
 * Local frame matches the pipeline exactly: origin at the outside corner at
 * the foot of flight 1, +X up that flight, +Y across it. Everything below is
 * built in that frame and then rotated and translated into plan coordinates,
 * so there is one place where the convention lives.
 */

export type PlanPoint = { x: number; y: number }

export type StairPlan = {
  stair: StairNode
  /** Footprint outline, for hit-testing and the selection halo. */
  outline: PlanPoint[]
  /** One line per tread, drawn across the flight. */
  treadLines: [PlanPoint, PlanPoint][]
  /** Landing outline for U and L; null for a straight flight. */
  landing: PlanPoint[] | null
  /** Direction-of-travel arrow: shaft plus two barbs. */
  arrow: { shaft: [PlanPoint, PlanPoint]; head: PlanPoint[] } | null
  /** True when the metrics say this stair is uncomfortable. */
  warns: boolean
  label: string
}

function place(
  stair: Pick<StairNode, 'position' | 'rotation'>,
  x: number,
  y: number,
): PlanPoint {
  const ca = Math.cos(stair.rotation)
  const sa = Math.sin(stair.rotation)
  return {
    x: stair.position[0] + x * ca - y * sa,
    y: stair.position[1] + x * sa + y * ca,
  }
}

/**
 * Build the plan symbol for one stair.
 *
 * `levelHeight` is floor-to-floor for the storey it stands on — the tread
 * count is a function of it, so the number of lines drawn changes with the
 * storey. That is deliberate: the symbol should look denser on a tall storey,
 * because it genuinely has more steps.
 */
export function buildStairPlan(stair: StairNode, levelHeight: number): StairPlan {
  const m = computeStairMetrics(stair, levelHeight)
  const width = m.width
  const across = stair.variant === 'straight' ? width : stair.depth
  const p = (x: number, y: number) => place(stair, x, y)

  const outline = [p(0, 0), p(stair.length, 0), p(stair.length, across), p(0, across)]

  const treadLines: [PlanPoint, PlanPoint][] = []
  let landing: PlanPoint[] | null = null
  let arrow: StairPlan['arrow'] = null

  const tread = m.tread
  const firstRun = m.stepCount - Math.floor(m.stepCount / 2)
  const secondRun = Math.floor(m.stepCount / 2)

  if (stair.variant === 'straight') {
    for (let i = 1; i < m.stepCount; i++) {
      const x = i * tread
      if (x > stair.length) break
      treadLines.push([p(x, 0), p(x, width)])
    }
    const midY = width / 2
    arrow = {
      shaft: [p(tread * 0.5, midY), p(Math.max(tread, stair.length - 0.15), midY)],
      head: [
        p(stair.length - 0.15, midY),
        p(stair.length - 0.4, midY - 0.16),
        p(stair.length - 0.4, midY + 0.16),
      ],
    }
  } else {
    // Matches the pipeline's run1_end = nosing + f1 * tread. The nosing is
    // only 25 mm, but the landing is drawn against this line and a symbol
    // that disagrees with the render is the thing this module exists to
    // avoid.
    const run1End = STAIR_NOSING + m.tread * firstRun
    const landingDepth = width

    // Flight 1 runs +X on y = [0, width].
    for (let i = 1; i < firstRun; i++) {
      treadLines.push([p(i * tread, 0), p(i * tread, width)])
    }

    if (stair.variant === 'u') {
      const y2 = width + STAIR_FLIGHT_GAP
      landing = [
        p(run1End, 0),
        p(run1End + landingDepth, 0),
        p(run1End + landingDepth, across),
        p(run1End, across),
      ]
      // Flight 2 folds BACK alongside flight 1, climbing -X.
      for (let i = 1; i < secondRun; i++) {
        const x = run1End - i * tread
        if (x < 0) break
        treadLines.push([p(x, y2), p(x, y2 + width)])
      }
      arrow = {
        shaft: [p(tread * 0.5, width / 2), p(run1End - 0.15, width / 2)],
        head: [
          p(run1End - 0.05, width / 2),
          p(run1End - 0.3, width / 2 - 0.16),
          p(run1End - 0.3, width / 2 + 0.16),
        ],
      }
    } else {
      landing = [
        p(run1End, 0),
        p(run1End + landingDepth, 0),
        p(run1End + landingDepth, landingDepth),
        p(run1End, landingDepth),
      ]
      // Flight 2 turns 90 degrees and climbs +Y past the landing.
      for (let i = 1; i < secondRun; i++) {
        const y = landingDepth + i * tread
        if (y > across) break
        treadLines.push([p(run1End, y), p(run1End + landingDepth, y)])
      }
      arrow = {
        shaft: [p(tread * 0.5, width / 2), p(run1End - 0.15, width / 2)],
        head: [
          p(run1End - 0.05, width / 2),
          p(run1End - 0.3, width / 2 - 0.16),
          p(run1End - 0.3, width / 2 + 0.16),
        ],
      }
    }
  }

  return {
    stair,
    outline,
    treadLines,
    landing,
    arrow,
    warns: !m.fits,
    label: `${m.stepCount} risers · ${Math.round(m.riser * 1000)} mm · ${m.angleDeg.toFixed(0)}°`,
  }
}

/** Winding-number test, matching the panel's other hit-tests. */
export function isPointInStairPlan(point: PlanPoint, plan: StairPlan): boolean {
  const poly = plan.outline
  let inside = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i]
    const b = poly[j]
    if (!(a && b)) continue
    if (
      a.y > point.y !== b.y > point.y &&
      point.x < ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y) + a.x
    ) {
      inside = !inside
    }
  }
  return inside
}

/**
 * Node space -> SVG space.
 *
 * The floor plan draws with toSvgX/toSvgY, which both NEGATE: a click at svg
 * (sx, sy) is stored as (-sx, -sy), and drawing it back negates again. Walls
 * and slabs go through that on the way to the canvas; the stair symbol did
 * not, so it rendered point-mirrored through the origin — the stair appeared
 * nowhere near where it was placed, while the stored position (and therefore
 * the 3D render) was correct all along.
 *
 * Hit-testing deliberately stays in NODE space, because the click point it is
 * compared against is already in node space.
 */
export function toStairSvg(pt: PlanPoint): PlanPoint {
  return { x: -pt.x, y: -pt.y }
}

export function polygonToPath(points: PlanPoint[]): string {
  if (points.length === 0) return ''
  const p = points.map(toStairSvg)
  return `${p.map((pt, i) => `${i === 0 ? 'M' : 'L'} ${pt.x} ${pt.y}`).join(' ')} Z`
}
