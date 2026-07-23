import dedent from 'dedent'
import { z } from 'zod'
import { BaseNode, nodeType, objectId } from '../base'

export const DoorSegment = z.object({
  type: z.enum(['panel', 'glass', 'empty']),
  heightRatio: z.number(),

  // Each segment controls its own column split
  columnRatios: z.array(z.number()).default([1]),
  dividerThickness: z.number().default(0.03),

  // panel-specific
  panelDepth: z.number().default(0.01), // + raised, - recessed
  panelInset: z.number().default(0.04),
})

export type DoorSegment = z.infer<typeof DoorSegment>

// Ritn3D 2026-06-18: door styles. 'pedestrian' = legacy default (0.9 x 2.1 m
// hinged door with wooden slab leaf). 'garage' = sectional-style overhead
// door for garages / sheds (default 2.4 x 2.1 m, no swing leaf).
// 'sliding' = interior sliding / barn door (opaque slab, side-slide).
//
// Ritn3D 2026-07-16 (Tier 2): 'glass' + 'patio' added so the pipeline can
// render actual door leaves instead of just doorway frames.
//   glass  = single hinged glass leaf in a frame (front door / office door)
//   patio  = double sliding-glass door (living-room-to-yard style)
//
// Ritn3D 2026-07-24 iOS parity: 'double' added. Two hinged leaves that
// meet at the middle of the opening. Common on wide interior doors
// (living-to-dining transition) and formal entryways. Same panel/frame
// style as 'pedestrian' but split into two mirrored leaves.
// Existing scenes parse with style='pedestrian' (no migration).
export const DoorStyle = z.enum([
  'pedestrian', 'garage', 'sliding', 'glass', 'patio', 'double',
])
export type DoorStyle = z.infer<typeof DoorStyle>

export const DoorNode = BaseNode.extend({
  id: objectId('door'),
  type: nodeType('door'),

  position: z.tuple([z.number(), z.number(), z.number()]).default([0, 0, 0]),
  rotation: z.tuple([z.number(), z.number(), z.number()]).default([0, 0, 0]),
  side: z.enum(['front', 'back']).optional(),
  wallId: z.string().optional(),
  style: DoorStyle.default('pedestrian'),

  // Overall dimensions
  width: z.number().default(0.9),
  height: z.number().default(2.1),

  // Frame
  frameThickness: z.number().default(0.05),
  frameDepth: z.number().default(0.07),
  threshold: z.boolean().default(true),
  thresholdHeight: z.number().default(0.02),

  // Swing
  hingesSide: z.enum(['left', 'right']).default('left'),
  swingDirection: z.enum(['inward', 'outward']).default('inward'),

  // Leaf segments — stacked top to bottom, each with its own column split
  segments: z.array(DoorSegment).default([
    {
      type: 'panel',
      heightRatio: 0.4,
      columnRatios: [1],
      dividerThickness: 0.03,
      panelDepth: 0.01,
      panelInset: 0.04,
    },
    {
      type: 'panel',
      heightRatio: 0.6,
      columnRatios: [1],
      dividerThickness: 0.03,
      panelDepth: 0.01,
      panelInset: 0.04,
    },
  ]),

  // Handle
  handle: z.boolean().default(true),
  handleHeight: z.number().default(1.05),
  handleSide: z.enum(['left', 'right']).default('right'),

  // Leaf inner margin — space between leaf edge and segment content area [x, y]
  contentPadding: z.tuple([z.number(), z.number()]).default([0.04, 0.04]),

  // Emergency / commercial hardware
  doorCloser: z.boolean().default(false),
  panicBar: z.boolean().default(false),
  panicBarHeight: z.number().default(1.0),
}).describe(dedent`Door node - a parametric door placed on a wall
  - position: center of the door in wall-local coordinate system (Y = height/2, always at floor)
  - segments: rows stacked top to bottom, each defining its own columnRatios
  - type 'empty' = flush flat fill, 'panel' = raised/recessed panel, 'glass' = glazed
  - hingesSide/swingDirection: which way the door opens
  - doorCloser/panicBar: commercial and emergency hardware options
`)

export type DoorNode = z.infer<typeof DoorNode>
