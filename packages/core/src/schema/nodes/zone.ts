import dedent from 'dedent'
import { z } from 'zod'
import { BaseNode, nodeType, objectId } from '../base'

// Ritn3D 2026-07-24 iOS parity: room type taxonomy matching iOS
// FloorPlanScene.RoomType. Feeds the ZonePanel chip picker and the
// pipeline (which uses it for floor material selection + room-specific
// furniture rules). Legacy zones default to 'other'.
export const RoomType = z.enum([
  'living', 'kitchen', 'dining', 'bedroom', 'bathroom',
  'office', 'hallway', 'entryway', 'closet', 'laundry',
  'garage', 'outdoor', 'other',
])
export type RoomType = z.infer<typeof RoomType>

export const ZoneNode = BaseNode.extend({
  id: objectId('zone'),
  type: nodeType('zone'),
  name: z.string(),
  // Polygon boundary - array of [x, z] coordinates defining the zone
  polygon: z.array(z.tuple([z.number(), z.number()])),
  // Visual styling
  color: z.string().default('#3b82f6'), // Default blue
  // Semantic room type (Ritn3D 2026-07-24)
  roomType: RoomType.default('other'),
  metadata: z.json().optional().default({}),
}).describe(
  dedent`
  Zone schema - a polygon zone attached to a level
  - object: "zone"
  - id: zone id
  - levelId: level this zone is attached to
  - name: zone name
  - polygon: array of [x, z] points defining the zone boundary
  - color: hex color for visual styling
  - metadata: zone metadata (optional)
  `,
)

export type ZoneNode = z.infer<typeof ZoneNode>
