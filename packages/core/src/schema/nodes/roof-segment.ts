import dedent from 'dedent'
import { z } from 'zod'
import { BaseNode, nodeType, objectId } from '../base'

export const RoofType = z.enum(['hip', 'gable', 'shed', 'gambrel', 'dutch', 'mansard', 'flat'])

export type RoofType = z.infer<typeof RoofType>

// Roof material picker — the pipeline maps these to concrete PBR packs
// (roof_slates_03 for slate, terracotta for terracotta, etc). Unknown
// values fall back to the shingle default at parse time. Keep this list
// in sync with SUPPORTED_MATERIALS in blender_pipeline_dev/roof/scene.py.
export const RoofMaterial = z.enum(['slate', 'terracotta', 'metal', 'shingle', 'flat'])

export type RoofMaterial = z.infer<typeof RoofMaterial>

export const RoofSegmentNode = BaseNode.extend({
  id: objectId('rseg'),
  type: nodeType('roof-segment'),
  // Position relative to parent roof group
  position: z.tuple([z.number(), z.number(), z.number()]).default([0, 0, 0]),
  // Rotation around Y axis in radians
  rotation: z.number().default(0),
  // Roof shape type
  roofType: RoofType.default('gable'),
  // Which axis the ridge runs along, INDEPENDENT of width/depth. Set
  // explicitly so a later width/depth edit doesn't silently flip it
  // to whichever axis is currently longer. "auto" keeps the old
  // width>=depth heuristic for anything the user hasn't touched.
  ridgeAxis: z.enum(['auto', 'east-west', 'north-south']).default('auto'),
  // Material (drives the manifest slot the viewer swaps in)
  material: RoofMaterial.default('slate'),
  // Footprint dimensions — width/depth define a rectangle. Ignored when
  // `polygon` is set (four-point mode).
  width: z.number().default(8),
  depth: z.number().default(6),
  // Optional explicit polygon (world plan coords) — when set, the
  // pipeline uses this instead of the width/depth rectangle. Lets the
  // user draw non-rectangular gables (trapezoidal footprints where the
  // two gable ends are different lengths). Four vertices for now;
  // arbitrary N later. Position + rotation still apply as a rigid
  // transform on top of the polygon.
  polygon: z.array(z.tuple([z.number(), z.number()])).optional(),
  // Vertical dimensions
  wallHeight: z.number().default(0.5),
  roofHeight: z.number().default(2.5),
  // Structure thicknesses
  wallThickness: z.number().default(0.1),
  deckThickness: z.number().default(0.1),
  overhang: z.number().default(0.3),
  shingleThickness: z.number().default(0.05),
}).describe(
  dedent`
  Roof segment node - an individual roof module within a roof group.
  Each segment generates a complete architectural volume (walls + roof).
  Multiple segments can be combined to form complex roof shapes.
  - roofType: hip, gable, shed, gambrel, dutch, mansard, flat
  - width/depth: footprint dimensions
  - wallHeight: height of walls below the roof
  - roofHeight: height of the roof peak above the walls
  - wallThickness/deckThickness: structural thicknesses
  - overhang: eave overhang distance
  - shingleThickness: outer shingle layer thickness
  `,
)

export type RoofSegmentNode = z.infer<typeof RoofSegmentNode>
