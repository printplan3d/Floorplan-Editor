import dedent from 'dedent'
import { z } from 'zod'
import { BaseNode, nodeType, objectId } from '../base'
import { ItemNode } from './item'
// import { DoorNode } from "./door";
// import { ItemNode } from "./item";
// import { WindowNode } from "./window";

export const WallNode = BaseNode.extend({
  id: objectId('wall'),
  type: nodeType('wall'),
  children: z.array(ItemNode.shape.id).default([]),
  // Specific props
  thickness: z.number().optional(),
  height: z.number().optional(),
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
