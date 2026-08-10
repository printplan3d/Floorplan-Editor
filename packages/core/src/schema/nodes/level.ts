import dedent from 'dedent'
import { z } from 'zod'
import { BaseNode, nodeType, objectId } from '../base'
import { CeilingNode } from './ceiling'
import { GuideNode } from './guide'
import { RoofNode } from './roof'
import { SlabNode } from './slab'
import { StairNode } from './stair'
import { WallNode } from './wall'
import { ZoneNode } from './zone'

export const LevelNode = BaseNode.extend({
  id: objectId('level'),
  type: nodeType('level'),
  children: z
    .array(
      z.union([
        WallNode.shape.id,
        ZoneNode.shape.id,
        SlabNode.shape.id,
        StairNode.shape.id,
        CeilingNode.shape.id,
        RoofNode.shape.id,
        // ScanNode removed 2026-06-10 (Ritn3D cleanup): 3D-scan reference
        // (LiDAR/photogrammetry GLB) was Pascal's BIM feature, irrelevant
        // for floor-plan tracing. GuideNode (image overlay) is what we use.
        GuideNode.shape.id,
      ]),
    )
    .default([]),
  // Specific props
  level: z.number().default(0),
  /* Ritn3D 2026-08-10: should the pipeline invent a floor for this storey
     when none is drawn?

     Any upper level with walls and no slab gets one synthesised, otherwise a
     new storey renders as walls standing over open air. But "no slab" cannot
     tell "I have not drawn one yet" from "I deleted it deliberately", so
     deleting a floor just made the pipeline put it back — and there was no
     way at all to express a mezzanine, a void over a double-height room, or
     an open roof deck.

     true keeps the helpful default; false means this storey genuinely has no
     floor beyond whatever is drawn by hand. Defaulting to true leaves every
     existing level parsing and rendering exactly as before. */
  autoFloor: z.boolean().default(true),
}).describe(
  dedent`
  Level node - used to represent a level in the building
  - children: array of floor, wall, ceiling, roof, item nodes
  - level: level number
  - autoFloor: synthesise a floor when none is drawn (false = open void)
  `,
)

export type LevelNode = z.infer<typeof LevelNode>
