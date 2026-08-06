// Base
export { BaseNode, generateId, Material, nodeType, objectId } from './base'
// Camera
export { CameraSchema } from './camera'
// Collections
export { type Collection, type CollectionId, generateCollectionId } from './collections'
export { BuildingNode } from './nodes/building'
export { CeilingNode } from './nodes/ceiling'
export { DoorNode, DoorSegment, DoorStyle } from './nodes/door'
export { GuideNode } from './nodes/guide'
export type {
  AnimationEffect,
  Asset,
  AssetInput,
  Control,
  Effect,
  Interactive,
  LightEffect,
  SliderControl,
  TemperatureControl,
  ToggleControl,
} from './nodes/item'
export { getScaledDimensions, ItemNode } from './nodes/item'
export { LevelNode } from './nodes/level'
export { RoofNode } from './nodes/roof'
export { RoofSegmentNode, RoofType } from './nodes/roof-segment'
// ScanNode removed 2026-06-10 (Ritn3D cleanup).
// Nodes
export { SiteNode } from './nodes/site'
export { SlabNode, SlabSurfaceType } from './nodes/slab'
export {
  computeStairMetrics,
  getStairFootprint,
  STAIR_FLIGHT_GAP,
  STAIR_MAX_ANGLE_DEG,
  STAIR_MAX_RISER,
  STAIR_MIN_RISER,
  STAIR_MIN_TREAD,
  STAIR_MIN_WIDTH,
  STAIR_NOSING,
  STAIR_TARGET_RISER,
  StairNode,
  type StairMetrics,
  StairVariant,
  suggestStairFootprint,
} from './nodes/stair'
export { WallNode } from './nodes/wall'
export { WindowNode } from './nodes/window'
export { ZoneNode, RoomType } from './nodes/zone'
export type { AnyNodeId, AnyNodeType } from './types'
// Union types
export { AnyNode } from './types'
