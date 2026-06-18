import dedent from 'dedent'
import { z } from 'zod'
import { BaseNode, nodeType, objectId } from '../base'

// Ritn3D 2026-06-18: surfaceType drives how the Blender pipeline materials
// a slab. 'interior' is the legacy default (every existing scene parses with
// no migration). Outdoor variants change material + texture without changing
// any geometry — same polygon + holes + elevation pipeline.
export const SlabSurfaceType = z.enum([
  'interior',
  'patio',
  'deck',
  'driveway',
  'garage',
  'gravel',
  'grass',
  'wood',
])
export type SlabSurfaceType = z.infer<typeof SlabSurfaceType>

export const SlabNode = BaseNode.extend({
  id: objectId('slab'),
  type: nodeType('slab'),
  // Specific props
  // Polygon boundary - array of [x, z] coordinates defining the slab
  polygon: z.array(z.tuple([z.number(), z.number()])),
  holes: z.array(z.array(z.tuple([z.number(), z.number()]))).default([]),
  elevation: z.number().default(0.05), // Elevation in meters
  surfaceType: SlabSurfaceType.default('interior'),
}).describe(
  dedent`
  Slab node - used to represent a slab/floor in the building
  - polygon: array of [x, z] points defining the slab boundary
  - holes: array of polygon holes (for stair openings, double-height voids)
  - elevation: elevation in meters
  - surfaceType: drives the Blender material (interior floor, patio, deck,
    driveway, garage, gravel, grass, wood). Defaults to interior so legacy
    scenes parse unchanged.
  `,
)

export type SlabNode = z.infer<typeof SlabNode>
