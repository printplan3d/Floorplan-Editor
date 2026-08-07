import dedent from 'dedent'
import { z } from 'zod'
import { BaseNode, nodeType, objectId } from '../base'

/**
 * Ritn3D 2026-08-06 — stairs are PLACED, not inferred.
 *
 * The pipeline has had procedural staircase generation since before the first
 * launch, driven by any room the user typed 'staircase'. It was never shipped
 * because of one flaw: step count is forced by the storey height
 * (ceil(height / riser)), so when a room was too short to hold the run, the
 * generator preserved riser ergonomics and let the run overflow the room —
 * the stair came out through the wall. See `_select_staircase_variant_procedural`
 * in generate_3d.py, where the last fallback clamps tread UP to MIN_TREAD and
 * returns `run_length = steps * tread` with no bound on the region at all.
 *
 * A StairNode fixes that by making the footprint an explicit, user-owned
 * input instead of a room's leftover shape, and by computing the metrics in
 * ONE place — `computeStairMetrics` below — which the Blender pipeline
 * mirrors exactly. The editor can then show the true riser/pitch while the
 * user drags, so the constraint is visible at draw time rather than being
 * discovered as a stair sticking out of the building after a render.
 */

export const StairVariant = z.enum([
  'straight', // single flight
  'u', // two flights, 180° turn around a landing (switchback)
  'l', // two flights, 90° turn around a landing
])
export type StairVariant = z.infer<typeof StairVariant>

export const StairNode = BaseNode.extend({
  id: objectId('stair'),
  type: nodeType('stair'),
  /** Footprint origin — the outside corner at the FOOT of the first flight. */
  position: z.tuple([z.number(), z.number()]).default([0, 0]),
  /** Radians, CCW, about the footprint origin. 0 = first flight runs +X. */
  rotation: z.number().default(0),
  variant: StairVariant.default('straight'),
  /** Width of a single flight. */
  width: z.number().default(1.0),
  /** Footprint extent along the first flight's direction. */
  length: z.number().default(3.0),
  /**
   * Footprint extent across the first flight. Only meaningful for 'u' and
   * 'l'; a straight flight is exactly `width` across. Defaults big enough to
   * hold a U's two flights plus the gap between them.
   */
  depth: z.number().default(2.1),
  /** Which way the second flight turns, seen from the foot of the stair. */
  handedness: z.enum(['left', 'right']).default('right'),
  railing: z.boolean().default(true),
}).describe(
  dedent`
  Stair node — a placed staircase connecting this level to the one above
  - position: outside corner at the foot of the first flight, level coords
  - rotation: radians CCW; 0 means the first flight runs along +X
  - variant: straight | u (180 switchback) | l (90 turn)
  - width: width of one flight
  - length / depth: the footprint the stair must fit inside. The pipeline
    never builds outside this box — if the run cannot fit, the stair gets
    steeper and is reported, rather than overflowing the room.
  - handedness: which way the second flight turns (u and l only)
  `,
)

export type StairNode = z.infer<typeof StairNode>

// ── Ergonomics ─────────────────────────────────────────────────────────────
// These MUST stay in step with STAIR_* in blender_pipeline_dev/generate_3d.py.
// Any drift makes the editor's live readout describe a stair the pipeline is
// not going to build, which is worse than showing nothing.
export const STAIR_TARGET_RISER = 0.175
export const STAIR_MIN_RISER = 0.15
export const STAIR_MAX_RISER = 0.2
export const STAIR_MIN_TREAD = 0.22
export const STAIR_MAX_ANGLE_DEG = 40
/** Gap between the two flights of a U, where the handrail runs. */
export const STAIR_FLIGHT_GAP = 0.1
/** Narrower than this is not a usable stair. */
export const STAIR_MIN_WIDTH = 0.6
/**
 * Tread overhang past the riser below. The step grid is shifted forward by
 * one nosing so the bottom tread's overhang starts at the footprint edge
 * rather than poking out behind the stair, which costs one nosing of run —
 * reserved in every bound below, exactly as generate_3d.py does.
 */
export const STAIR_NOSING = 0.025

export type StairMetrics = {
  stepCount: number
  riser: number
  tread: number
  angleDeg: number
  /** Steps in the longest single flight — what the run length must hold. */
  stepsInLongestFlight: number
  /** Run the footprint actually gives that flight, after the landing. */
  availableRun: number
  /** Run that flight WANTS at a comfortable tread. */
  neededRun: number
  /** Flight width actually built — narrowed if the footprint demanded it. */
  width: number
  /** True when the footprint forced narrower flights than requested. */
  narrowed: boolean
  fits: boolean
  /** Human-readable reason when !fits, else null. */
  problem: string | null
}

/**
 * Everything the user needs to know about a stair before it is rendered.
 *
 * `levelHeight` is floor-to-floor for the storey the stair sits on — the real
 * one from getLevelHeight, never a constant. Getting this from a hardcoded
 * 2.8 m default is precisely why the existing pipeline stairs land at the
 * wrong height on a 2.7 m or 3.0 m storey.
 */
export function computeStairMetrics(
  stair: Pick<StairNode, 'variant' | 'width' | 'length' | 'depth'>,
  levelHeight: number,
): StairMetrics {
  const h = Math.max(0.1, levelHeight)

  // Step count is NOT free — it falls out of the storey height. This is the
  // constraint users are surprised by, so it is computed first and shown.
  const stepCount = Math.max(2, Math.ceil(h / STAIR_TARGET_RISER))
  const riser = h / stepCount

  // A landing eats into the run, and each flight carries about half the steps.
  // The bound on tread differs per variant because the flights run along
  // different axes — this mirrors `_stair_build_params` in generate_3d.py
  // exactly, including the split of steps between the two flights.
  // Flight 1 takes the extra step on an odd count — flight 2 folds back
  // inside flight 1's run (U) or turns off the landing (L), so the longer of
  // the two has to be flight 1 or it overshoots the footprint by one tread.
  const firstRun = stepCount - Math.floor(stepCount / 2) // ceil
  const secondRun = Math.floor(stepCount / 2)

  // The footprint constrains flight WIDTH as well as run length. A U puts two
  // flights side by side with a gap, so it needs 2*width + gap across; asking
  // for more than the footprint gives pushes the second flight out the side.
  // The pipeline narrows the flights to fit rather than overflowing, so the
  // same narrowing is applied here — otherwise the readout would describe a
  // wider stair than the one that gets built.
  const widthRequested = stair.width
  const maxWidth =
    stair.variant === 'u'
      ? (stair.depth - STAIR_FLIGHT_GAP) / 2
      : stair.variant === 'l'
        ? stair.depth
        : stair.width
  const width = Math.min(stair.width, maxWidth)
  const narrowed = width < widthRequested - 1e-9

  let stepsInLongestFlight: number
  let availableRun: number
  let maxTread: number
  if (stair.variant === 'straight') {
    stepsInLongestFlight = stepCount
    availableRun = Math.max(0, stair.length - STAIR_NOSING)
    maxTread = stepCount > 0 ? availableRun / stepCount : 0
  } else if (stair.variant === 'u') {
    // Both flights run along the length; the second folds back alongside the
    // first, so the landing is subtracted once and the longer flight sets it.
    const landing = width
    stepsInLongestFlight = Math.max(firstRun, secondRun)
    availableRun = Math.max(0, stair.length - landing - STAIR_NOSING)
    maxTread = stepsInLongestFlight > 0 ? availableRun / stepsInLongestFlight : 0
  } else {
    // 'l' — the second flight turns 90° and runs along `depth`, so depth
    // constrains it just as length constrains the first. Missing this was
    // letting an L report a comfortable tread while the second flight ran
    // out past the footprint.
    const landing = width
    stepsInLongestFlight = Math.max(firstRun, secondRun)
    availableRun = Math.max(0, stair.length - landing - STAIR_NOSING)
    // Flight 2 starts PAST the landing in depth, so the landing is subtracted
    // from the depth exactly as it is from the length.
    const availableDepth = Math.max(0, stair.depth - landing - STAIR_NOSING)
    const alongLength = firstRun > 0 ? availableRun / firstRun : Number.POSITIVE_INFINITY
    const alongDepth = secondRun > 0 ? availableDepth / secondRun : Number.POSITIVE_INFINITY
    maxTread = Math.min(alongLength, alongDepth)
  }

  const neededRun = stepsInLongestFlight * Math.max(STAIR_MIN_TREAD, 0.27)
  const tread = Number.isFinite(maxTread) ? Math.max(0, maxTread) : 0
  const angleDeg = tread > 0 ? (Math.atan2(riser, tread) * 180) / Math.PI : 90

  let problem: string | null = null
  if (availableRun <= 0) {
    problem = 'No room for a flight — the landing alone fills the footprint.'
  } else if (tread < STAIR_MIN_TREAD) {
    problem = `Tread ${Math.round(tread * 1000)} mm is below the ${Math.round(
      STAIR_MIN_TREAD * 1000,
    )} mm minimum. Make it longer, or switch to a U or L.`
  } else if (angleDeg > STAIR_MAX_ANGLE_DEG) {
    problem = `${Math.round(angleDeg)}° is steeper than the ${STAIR_MAX_ANGLE_DEG}° maximum.`
  }

  // Width. The pipeline narrows the flights rather than overflowing, so this
  // is not "it will break" but "you will not get the stair you asked for".
  if (!problem && width < STAIR_MIN_WIDTH) {
    const needed =
      stair.variant === 'u' ? STAIR_MIN_WIDTH * 2 + STAIR_FLIGHT_GAP : STAIR_MIN_WIDTH
    problem = `Only ${width.toFixed(2)} m per flight — needs ${needed.toFixed(2)} m across.`
  } else if (!problem && narrowed) {
    problem = `Flights narrowed to ${width.toFixed(2)} m to fit ${stair.depth.toFixed(2)} m across.`
  }

  return {
    stepCount,
    riser,
    tread,
    angleDeg,
    stepsInLongestFlight,
    availableRun,
    neededRun,
    width,
    narrowed,
    fits: problem === null,
    problem,
  }
}

/**
 * Axis-aligned footprint size, before rotation. The pipeline is not allowed
 * to build anything outside this box.
 */
export function getStairFootprint(
  stair: Pick<StairNode, 'variant' | 'width' | 'length' | 'depth'>,
): { length: number; width: number } {
  return {
    length: stair.length,
    width: stair.variant === 'straight' ? stair.width : stair.depth,
  }
}

/**
 * The smallest footprint that renders this variant within ergonomic limits.
 * Used by the tool to place a stair that is valid the moment it lands, and by
 * the panel's "fit to storey" action.
 */
export function suggestStairFootprint(
  variant: StairVariant,
  width: number,
  levelHeight: number,
): { length: number; depth: number } {
  /* The exact inverse of computeStairMetrics, so "fit to this storey" always
     lands on fits === true.

     The previous version was neither. It never reserved STAIR_NOSING, which
     the metrics subtract from every available run — so a fitted stair came
     back one nosing short and reported as slightly too steep. And for an L it
     returned depth = width, the landing alone, leaving flight 2 with no run
     at all: fitting an L produced a stair the panel immediately flagged. */
  const h = Math.max(0.1, levelHeight)
  const stepCount = Math.max(2, Math.ceil(h / STAIR_TARGET_RISER))
  const tread = 0.27
  const round = (v: number) => Math.round(v * 100) / 100

  if (variant === 'straight') {
    return { length: round(STAIR_NOSING + stepCount * tread), depth: round(width) }
  }

  // Same split the metrics use: flight 1 takes the extra step on an odd count.
  const firstRun = stepCount - Math.floor(stepCount / 2)
  const secondRun = Math.floor(stepCount / 2)
  const landing = width

  if (variant === 'u') {
    // Both flights run along the length; the longer one sets it.
    const perFlight = Math.max(firstRun, secondRun)
    return {
      length: round(STAIR_NOSING + landing + perFlight * tread),
      depth: round(width * 2 + STAIR_FLIGHT_GAP),
    }
  }

  // 'l' — flight 1 along the length, flight 2 along the depth. Both need the
  // landing and the nosing subtracted, which is what the metrics do.
  return {
    length: round(STAIR_NOSING + landing + firstRun * tread),
    depth: round(STAIR_NOSING + landing + secondRun * tread),
  }
}
