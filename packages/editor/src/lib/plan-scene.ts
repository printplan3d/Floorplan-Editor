'use client'

// Cross-platform plan sync: convert between the editor's native
// SceneGraph and the canonical "FloorPlanScene" wire format shared by
// iOS, Flutter and the webapp (the /api/plans document `scene`).
//
// CANONICAL FORMAT (native, UN-mirrored — same as iOS FloorPlanScene &
// Flutter toExportJson(flipForBackend:false)):
//   walls[]:   { id, start:[x,z], end:[x,z], thickness, height, type,
//                bulge? }                       (bulge omitted when ~0)
//   doors[]:   { id, wall_id, position_along_wall(0..1), width, height,
//                door_type, swing_direction, swing_side }
//   windows[]: { id, wall_id, position_along_wall(0..1), width, height,
//                sill_height, pane_rows, pane_columns, pane_count }
//   rooms[]:   { id, label, type, wall_ids, area, polygon:[[x,z],...] }
//   floors[], stairs[], furniture[], metadata{}
//
// IMPORTANT — coordinates are NOT flipped here. The X/bulge flip lives
// only in export-json.ts (the render POST body). Canonical == native ==
// iOS-native == Flutter-native. Flipping here would mirror every plan.
//
// The tracing guide is NOT part of `scene` — it syncs separately via
// guide_meta + a GCS image blob, matching iOS.

import {
  arcLength,
  BuildingNode,
  DEFAULT_WALL_HEIGHT,
  DEFAULT_WALL_THICKNESS,
  DoorNode,
  LevelNode,
  SiteNode,
  WallNode,
  WindowNode,
  ZoneNode,
} from '@ritn3d/core'
import type { SceneGraph } from './scene'

// Loose structural types for the canonical wire shape.
export interface CanonicalWall {
  id: string
  start: [number, number]
  end: [number, number]
  thickness?: number
  height?: number
  type?: string
  bulge?: number
}
export interface CanonicalDoor {
  id: string
  wall_id: string
  position_along_wall: number
  width: number
  height: number
  door_type?: string
  swing_direction?: string
  swing_side?: string
}
export interface CanonicalWindow {
  id: string
  wall_id: string
  position_along_wall: number
  width: number
  height: number
  sill_height?: number
  pane_rows?: number
  pane_columns?: number
  pane_count?: number
}
export interface CanonicalRoom {
  id: string
  label?: string
  type?: string
  wall_ids?: string[]
  area?: number
  polygon?: [number, number][]
}
export interface CanonicalScene {
  walls: CanonicalWall[]
  doors: CanonicalDoor[]
  windows: CanonicalWindow[]
  rooms: CanonicalRoom[]
  floors: unknown[]
  stairs: unknown[]
  furniture: unknown[]
  metadata: Record<string, unknown>
}

// ── enum mappings ─────────────────────────────────────────────────────

const IOS_ROOM_TYPES = new Set([
  'living', 'kitchen', 'dining', 'bedroom', 'bathroom',
  'hallway', 'office', 'laundry', 'garage', 'other',
])
const WEB_ROOM_TYPES = new Set([
  'living', 'kitchen', 'dining', 'bedroom', 'bathroom', 'office',
  'hallway', 'entryway', 'closet', 'laundry', 'garage', 'outdoor', 'other',
])

// ---------------------------------------------------------------------------
// Coordinate frames.
//
// The canonical wire format is the MOBILE frame. iOS (EditorState.screenFromWorld)
// and Flutter (Camera.worldToScreen) both map world -> screen as (+x, +y); the
// webapp editor maps it as (-x, -y) (floorplan-panel toSvgX/toSvgY). So the
// webapp's native frame is the mobile frame rotated 180 degrees, and a plan
// handed between them unchanged shows up turned around. Two of the three
// clients already use the mobile frame, and it is what the render translator
// expects, so that is what goes on the wire.
//
// This file used to pass coordinates through untouched, on the note
// "NO flip -- native == canonical". That was true of the SHAPE, never of the
// orientation.
//
// Negating both axes is a 180-degree ROTATION, not a mirror, so:
//   - arc bulge sign is preserved (handedness survives a rotation; it would
//     only invert under a true mirror, which is why export-json.ts flips it
//     there and this does not)
//   - wall start/end order is untouched, so every opening's
//     position_along_wall stays valid
//   - the transform is its own inverse, so one helper serves both directions
const rot180 = ([x, y]: [number, number]): [number, number] => [-x, -y]

function styleToDoorType(style?: string): string {
  switch (style) {
    case 'double': return 'double'
    case 'patio': return 'patio'
    case 'glass': return 'glass'
    default: return 'single'   // pedestrian / garage / sliding -> single
  }
}
function doorTypeToStyle(t?: string): string {
  switch (t) {
    case 'double': return 'double'
    case 'patio': return 'patio'
    case 'glass': return 'glass'
    default: return 'pedestrian'
  }
}

// ── SceneGraph -> canonical (for pushing to /api/plans) ───────────────

export function sceneGraphToCanonical(scene: SceneGraph): CanonicalScene {
  const nodes = (scene?.nodes ?? {}) as Record<string, any>
  const all = Object.values(nodes)

  const walls: CanonicalWall[] = []
  const doors: CanonicalDoor[] = []
  const windows: CanonicalWindow[] = []
  const rooms: CanonicalRoom[] = []

  for (const n of all) {
    if (n?.type === 'wall') {
      const w = n
      const bulge = typeof w.bulge === 'number' ? w.bulge : 0
      const wall: CanonicalWall = {
        id: w.id,
        start: rot180(w.start as [number, number]),
        end: rot180(w.end as [number, number]),
        thickness: w.thickness ?? DEFAULT_WALL_THICKNESS,
        height: w.height ?? DEFAULT_WALL_HEIGHT,
        type: w.frontSide === 'exterior' || w.backSide === 'exterior' ? 'exterior' : 'interior',
      }
      if (Math.abs(bulge) > 1e-6) wall.bulge = bulge
      walls.push(wall)

      const wallLen = arcLength(w.start, w.end, bulge)
      const children = (w.children || []).map((id: string) => nodes[id]).filter(Boolean)
      for (const c of children) {
        if (c?.type === 'door') {
          doors.push({
            id: c.id,
            wall_id: w.id,
            position_along_wall: wallLen > 0 ? (c.position?.[0] ?? 0) / wallLen : 0.5,
            width: c.width ?? 0.9,
            height: c.height ?? 2.1,
            door_type: styleToDoorType(c.style),
            swing_direction: c.hingesSide === 'left' ? 'left' : 'right',
            swing_side: c.swingDirection === 'outward' ? 'outside' : 'inside',
          })
        } else if (c?.type === 'window') {
          const cols = c.columnRatios?.length ?? 1
          const rowsN = c.rowRatios?.length ?? 1
          const centerH = c.position?.[1] ?? 0
          windows.push({
            id: c.id,
            wall_id: w.id,
            position_along_wall: wallLen > 0 ? (c.position?.[0] ?? 0) / wallLen : 0.5,
            width: c.width ?? 1.2,
            height: c.height ?? 1.2,
            sill_height: Math.max(0, centerH - (c.height ?? 1.2) / 2),
            pane_rows: rowsN,
            pane_columns: cols,
            pane_count: Math.max(1, rowsN * cols),
          })
        }
      }
    } else if (n?.type === 'zone') {
      const type = WEB_ROOM_TYPES.has(n.roomType) && IOS_ROOM_TYPES.has(n.roomType)
        ? n.roomType : 'other'
      rooms.push({
        id: n.id,
        label: n.name || 'Room',
        type,
        wall_ids: [],
        area: 0,
        polygon: (n.polygon || []).map((p: number[]) => rot180([p[0] ?? 0, p[1] ?? 0])),
      })
    }
  }

  const floor = {
    id: 'level-0',
    level: 0,
    label: 'Ground floor',
    height: 2.7,
    walls: walls.map((w) => w.id),
    doors: doors.map((d) => d.id),
    windows: windows.map((w) => w.id),
    rooms: rooms.map((r) => r.id),
  }

  return {
    walls, doors, windows, rooms,
    floors: [floor],
    stairs: [],
    furniture: [],
    metadata: {
      unit: 'meters',
      scale: 1.0,
      created_at: new Date().toISOString(),
      source: 'web_editor',
      version: '1.0',
    },
  }
}

// ── canonical -> SceneGraph (for loading a pulled plan) ───────────────
//
// Node ids are REGENERATED: the webapp's Zod schemas runtime-validate a
// `wall_`/`door_`/... id prefix, which iOS/Flutter UUIDs don't satisfy.
// We map canonical ids -> fresh node ids and rewire references. (The
// plan DOCUMENT id stays stable; only internal node ids change, which is
// harmless under whole-scene last-write-wins.)

export function canonicalToSceneGraph(canonical: CanonicalScene | null | undefined): SceneGraph {
  const level0: any = LevelNode.parse({ level: 0, children: [] })
  const building: any = BuildingNode.parse({ children: [level0.id] })
  const site: any = SiteNode.parse({ children: [building] })

  const nodes: Record<string, any> = {
    [site.id]: site,
    [building.id]: building,
    [level0.id]: level0,
  }

  if (!canonical) {
    return { nodes, rootNodeIds: [site.id] }
  }

  const wallIdMap = new Map<string, any>()  // canonical wall id -> WallNode

  for (const w of canonical.walls ?? []) {
    const wall: any = WallNode.parse({
      parentId: level0.id,
      children: [],
      start: rot180(w.start as [number, number]),
      end: rot180(w.end as [number, number]),
      thickness: w.thickness ?? DEFAULT_WALL_THICKNESS,
      height: w.height ?? DEFAULT_WALL_HEIGHT,
      bulge: typeof w.bulge === 'number' ? w.bulge : 0,
      frontSide: w.type === 'exterior' ? 'exterior' : 'unknown',
      backSide: w.type === 'exterior' ? 'exterior' : 'unknown',
    })
    nodes[wall.id] = wall
    level0.children.push(wall.id)
    wallIdMap.set(w.id, wall)
  }

  for (const d of canonical.doors ?? []) {
    const wall = wallIdMap.get(d.wall_id)
    if (!wall) continue
    const len = arcLength(wall.start, wall.end, wall.bulge ?? 0)
    const height = d.height ?? 2.1
    const door: any = DoorNode.parse({
      parentId: wall.id,
      wallId: wall.id,
      position: [(d.position_along_wall ?? 0.5) * len, height / 2, 0],
      width: d.width ?? 0.9,
      height,
      style: doorTypeToStyle(d.door_type),
      hingesSide: d.swing_direction === 'left' ? 'left' : 'right',
      swingDirection: d.swing_side === 'outside' ? 'outward' : 'inward',
    })
    nodes[door.id] = door
    wall.children.push(door.id)
  }

  for (const win of canonical.windows ?? []) {
    const wall = wallIdMap.get(win.wall_id)
    if (!wall) continue
    const len = arcLength(wall.start, wall.end, wall.bulge ?? 0)
    const height = win.height ?? 1.2
    const sill = win.sill_height ?? 0.9
    const cols = Math.max(1, win.pane_columns ?? 1)
    const rowsN = Math.max(1, win.pane_rows ?? 1)
    const window: any = WindowNode.parse({
      parentId: wall.id,
      wallId: wall.id,
      position: [(win.position_along_wall ?? 0.5) * len, sill + height / 2, 0],
      width: win.width ?? 1.2,
      height,
      columnRatios: Array(cols).fill(1),
      rowRatios: Array(rowsN).fill(1),
    })
    nodes[window.id] = window
    wall.children.push(window.id)
  }

  for (const r of canonical.rooms ?? []) {
    const polygon = (r.polygon || []).map((p) => rot180([p[0], p[1]] as [number, number]))
    if (polygon.length < 3) continue
    const roomType = WEB_ROOM_TYPES.has(r.type ?? '') ? r.type : 'other'
    const zone: any = ZoneNode.parse({
      parentId: level0.id,
      name: r.label || 'Room',
      polygon,
      roomType,
    })
    nodes[zone.id] = zone
    level0.children.push(zone.id)
  }

  return { nodes, rootNodeIds: [site.id] }
}
