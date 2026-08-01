import dedent from 'dedent'
import { z } from 'zod'
import { BaseNode, nodeType, objectId } from '../base'
import { ItemNode } from './item'
// import { DoorNode } from "./door";
// import { ItemNode } from "./item";
// import { WindowNode } from "./window";

/**
 * Ritn3D 2026-08-01: canonical wall defaults, in metres.
 *
 * These were `optional()` with no default, and createWallOnCurrentLevel does
 * not pass either — so EVERY wall drawn in the web editor carried
 * thickness: undefined and height: undefined, and each consumer applied its
 * own fallback. Those had drifted apart:
 *
 *   plan-view render   thickness 0.10   (floorplan-panel)
 *   export to pipeline thickness 0.15, height 2.50  (export-json)
 *   iOS / Flutter      height 2.70
 *
 * So a web-drawn wall was DRAWN at 0.10 and BUILT at 0.15, and the same
 * drawing produced a 2.5 m ceiling on web against 2.7 m on iOS and Flutter —
 * different buildings from identical input.
 *
 * 2.7 matches iOS (PlanWall.height, DetectionToPlan.defaultWallHeightM) and
 * Flutter. 0.15 matches what the Blender pipeline actually builds, so the
 * plan view now draws what gets rendered.
 *
 * Exported because scenes loaded from storage bypass schema parsing
 * (applySceneGraphToEditor calls setScene directly), so legacy walls still
 * arrive undefined and consumers need the same number to fall back to.
 *
 * Defined here rather than in systems/wall/wall-footprint (where they used to
 * live, at 0.1 / 2.5) so the schema owns its own defaults with no dependency
 * on the systems layer. wall-footprint re-exports these, so its existing
 * consumers — including the 3D wall system — are unchanged.
 */
export const DEFAULT_WALL_THICKNESS = 0.15
export const DEFAULT_WALL_HEIGHT = 2.7

export const WallNode = BaseNode.extend({
  id: objectId('wall'),
  type: nodeType('wall'),
  children: z.array(ItemNode.shape.id).default([]),
  // Specific props
  thickness: z.number().default(DEFAULT_WALL_THICKNESS),
  height: z.number().default(DEFAULT_WALL_HEIGHT),
  // e.g., start/end points for path
  start: z.tuple([z.number(), z.number()]),
  end: z.tuple([z.number(), z.number()]),
  // Curved-wall support (Ritn3D extension, 2026-06-10).
  // DXF "bulge" convention: tan(included_arc_angle / 4).
  //   bulge = 0    -> straight line (default — backwards compatible)
  //   bulge > 0    -> arc bulges to the LEFT of the start->end chord
  //   bulge < 0    -> arc bulges to the RIGHT
  //   |bulge| = 1  -> semicircle
  //   |bulge| ~ tan(pi/8) = 0.414 -> quarter circle
  // Storing bulge rather than center+radius+angles keeps a single optional
  // scalar, has clean math, stays finite at the straight-line limit, and lets
  // every existing WallNode in a scene parse with `bulge: 0` (no migration).
  // Helpers in `core/lib/arc-math.ts` convert to center/radius/angles for
  // geometry / rendering / mitering.
  bulge: z.number().default(0),
  // Space detection for cutaway mode
  frontSide: z.enum(['interior', 'exterior', 'unknown']).default('unknown'),
  backSide: z.enum(['interior', 'exterior', 'unknown']).default('unknown'),
}).describe(
  dedent`
  Wall node - used to represent a wall in the building
  - thickness: thickness in meters
  - height: height in meters
  - start: start point of the wall in level coordinate system
  - end: end point of the wall in level coordinate system
  - bulge: DXF-style arc bulge (tan(arc_angle/4)); 0 = straight wall
  - size: size of the wall in grid units
  - frontSide: whether the front side faces interior, exterior, or unknown
  - backSide: whether the back side faces interior, exterior, or unknown
  `,
)
export type WallNode = z.infer<typeof WallNode>
