/*
 * Per-surface finishes — client-side schema.
 *
 * Shape frozen in D:/Planprint3d Cursor/PER_SURFACE_FINISHES_STORAGE_SPEC.md.
 * The backend dispatcher `apply_finishes_to_manifest` (api/textures_catalog.py)
 * consumes the same shape verbatim, so DO NOT rename fields here without
 * a coordinated bump across web + iOS + Android + backend.
 *
 * Persistence: schemes live on Project.furniture_scene.schemes (JSONB,
 * no migration). Legacy Project.furniture_scene.textures continues to
 * work — the backend auto-wraps it into a synthesised 'default' scheme.
 *
 * Task IDs from PER_SURFACE_FINISHES_BUILD_PLAN.md: D2 core schema.
 */

import { generateId } from './base'

export type SchemeId = 'default' | `scheme_${string}`
export type RegionId = `reg_${string}`

/** A wall / floor material picked from the catalog. */
export type MaterialId = string

/** Wall side — interior partitions have only 'interior'; exterior walls have both. */
export type WallSide = 'interior' | 'exterior'

/** Region target — discriminated union on `type`. */
export type RegionTargetWall = {
  type: 'wall'
  wall_id: string
  side: WallSide
}
export type RegionTargetFloor = {
  type: 'floor'
  level: number
  region_id?: string
}
export type RegionTarget = RegionTargetWall | RegionTargetFloor

/**
 * Region polygon coordinates.
 *  * Wall regions: (along, up) in metres, absolute (not normalised).
 *    `along` = 0 at wall start; `up` = 0 at wall base.
 *  * Floor regions: plan-XY (x, y) in metres.
 *
 * 3–128 vertices. Winding is CCW as viewed from the surface's outside
 * face; rasterisation uses even-odd fill so either winding renders.
 */
export type RegionPolygonPoint = [number, number]

export type Region = {
  id: RegionId
  target: RegionTarget
  polygon: RegionPolygonPoint[]
  /** Catalog id — resolved to a full PBR blob at manifest patch time. */
  material: MaterialId
  /** Higher wins on overlap. Default 0. */
  z_order?: number
}

export type Scheme = {
  /** Human display label. 1–64 chars. */
  name: string
  /** Global wall finish (catalog id). Nullable when user hasn't picked. */
  wall: MaterialId | null
  /** Global floor finish (catalog id). */
  floor: MaterialId | null
  /** Per-object / per-room slot overrides. Key: "obj:<mesh_name>" or "room:<zone_id>". */
  overrides: Record<string, Partial<Record<string, MaterialId>>>
  /** Drawn regions. Order matters within a wall (later wins on z_order tie). */
  regions: Region[]
}

export type FinishesState = {
  active: SchemeId
  sets: Record<SchemeId, Scheme>
}

/** Empty starter scheme — for a fresh plan or a "create scheme" click. */
export function makeEmptyScheme(name = 'Default'): Scheme {
  return {
    name,
    wall: null,
    floor: null,
    overrides: {},
    regions: [],
  }
}

export function makeDefaultFinishes(): FinishesState {
  return {
    active: 'default',
    sets: {
      default: makeEmptyScheme('Default'),
    },
  }
}

export const generateSchemeId = (): SchemeId => generateId('scheme')
export const generateRegionId = (): RegionId => generateId('reg')
