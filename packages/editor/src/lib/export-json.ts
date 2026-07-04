import { type AnyNodeId, arcLength, type DoorNode, type WallNode, type WindowNode, type ZoneNode, useScene } from '@ritn3d/core'
import { useViewer } from '@ritn3d/viewer'

/**
 * Export the current floor plan as structured JSON matching the Ritn3D Blender pipeline format.
 * This JSON can be POST'd to /api/generate-from-drawing to create a 3D model.
 */
export function exportFloorPlanJSON(): object {
  const { nodes } = useScene.getState()
  const { selection } = useViewer.getState()

  const allNodes = Object.values(nodes)

  // Collect walls per level
  const levels = allNodes.filter((n) => n.type === 'level') as any[]
  const floors: any[] = []

  for (const level of levels) {
    const levelWalls: any[] = []
    const levelDoors: any[] = []
    const levelWindows: any[] = []
    const levelRooms: any[] = []

    const children = (level.children || []).map((id: string) => nodes[id as AnyNodeId]).filter(Boolean)

    for (const child of children) {
      if (child.type === 'wall') {
        const w = child as WallNode
        const wallExport = {
          id: w.id,
          start: w.start,
          end: w.end,
          thickness: w.thickness ?? 0.15,
          height: w.height ?? 2.5,
          type: w.frontSide === 'exterior' || w.backSide === 'exterior' ? 'exterior' : 'interior',
          // Ritn3D arc walls (DXF bulge: tan(arc_angle/4); 0 = straight).
          // Omitted from JSON when bulge is 0 so the Blender pipeline can
          // keep a simpler straight-wall code path for legacy plans.
          ...(w.bulge && w.bulge !== 0 ? { bulge: w.bulge } : {}),
        }
        levelWalls.push(wallExport)

        // Collect doors/windows on this wall
        const wallChildren = (w.children || []).map((id: string) => nodes[id as AnyNodeId]).filter(Boolean)
        for (const wc of wallChildren) {
          if (!wc) continue  // .filter(Boolean) doesn't narrow the TS type
          if (wc.type === 'door') {
            const d = wc as DoorNode
            // For curved walls, "position_along_wall" is parametric over arc
            // length, not chord. For straight walls bulge=0 so arcLength
            // collapses to chord length — same answer as before.
            const wallLen = arcLength(w.start, w.end, w.bulge ?? 0)
            levelDoors.push({
              id: d.id,
              wall_id: w.id,
              position_along_wall: wallLen > 0 ? d.position[0] / wallLen : 0.5,
              width: d.width,
              height: d.height,
              door_type: 'single',
              swing_direction: d.hingesSide === 'left' ? 'left' : 'right',
            })
          }
          if (wc.type === 'window') {
            const win = wc as WindowNode
            // For curved walls, "position_along_wall" is parametric over arc
            // length, not chord. For straight walls bulge=0 so arcLength
            // collapses to chord length — same answer as before.
            const wallLen = arcLength(w.start, w.end, w.bulge ?? 0)
            const sillHeight = Math.max(0, (win.position[1] ?? 0) - (win.height ?? 1.5) / 2)
            levelWindows.push({
              id: win.id,
              wall_id: w.id,
              position_along_wall: wallLen > 0 ? win.position[0] / wallLen : 0.5,
              width: win.width,
              height: win.height,
              sill_height: sillHeight,
              pane_count: (win.columnRatios?.length ?? 1) * (win.rowRatios?.length ?? 1),
            })
          }
        }
      }

      if (child.type === 'zone') {
        const z = child as ZoneNode
        levelRooms.push({
          id: z.id,
          label: z.name || 'Room',
          type: 'other',
          wall_ids: [],
          area: 0, // calculated by pipeline
        })
      }
    }

    floors.push({
      id: level.id,
      level: level.level ?? 0,
      label: `Level ${level.level ?? 0}`,
      height: 2.7,
      walls: levelWalls.map((w: any) => w.id),
      doors: levelDoors.map((d: any) => d.id),
      windows: levelWindows.map((w: any) => w.id),
      rooms: levelRooms.map((r: any) => r.id),
    })

    // Flatten into top-level arrays (first floor for now)
    if (floors.length === 1) {
      return {
        walls: levelWalls,
        doors: levelDoors,
        windows: levelWindows,
        rooms: levelRooms,
        floors,
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
  }

  // Multi-floor: return all
  const allWalls: any[] = []
  const allDoors: any[] = []
  const allWindows: any[] = []
  const allRooms: any[] = []

  for (const level of levels) {
    const children = (level.children || []).map((id: string) => nodes[id as AnyNodeId]).filter(Boolean)
    for (const child of children) {
      if (child.type === 'wall') {
        const w = child as WallNode
        allWalls.push({
          id: w.id,
          start: w.start,
          end: w.end,
          thickness: w.thickness ?? 0.15,
          height: w.height ?? 2.5,
          type: 'interior',
          ...(w.bulge && w.bulge !== 0 ? { bulge: w.bulge } : {}),
        })
        const wallChildren = (w.children || []).map((id: string) => nodes[id as AnyNodeId]).filter(Boolean)
        for (const wc of wallChildren) {
          if (!wc) continue  // .filter(Boolean) doesn't narrow the TS type
          if (wc.type === 'door') {
            const d = wc as DoorNode
            // For curved walls, "position_along_wall" is parametric over arc
            // length, not chord. For straight walls bulge=0 so arcLength
            // collapses to chord length — same answer as before.
            const wallLen = arcLength(w.start, w.end, w.bulge ?? 0)
            allDoors.push({
              id: d.id, wall_id: w.id,
              position_along_wall: wallLen > 0 ? d.position[0] / wallLen : 0.5,
              width: d.width, height: d.height,
              door_type: 'single', swing_direction: d.hingesSide === 'left' ? 'left' : 'right',
            })
          }
          if (wc.type === 'window') {
            const win = wc as WindowNode
            // For curved walls, "position_along_wall" is parametric over arc
            // length, not chord. For straight walls bulge=0 so arcLength
            // collapses to chord length — same answer as before.
            const wallLen = arcLength(w.start, w.end, w.bulge ?? 0)
            allWindows.push({
              id: win.id, wall_id: w.id,
              position_along_wall: wallLen > 0 ? win.position[0] / wallLen : 0.5,
              width: win.width, height: win.height,
              sill_height: Math.max(0, (win.position[1] ?? 0) - (win.height ?? 1.5) / 2),
              pane_count: (win.columnRatios?.length ?? 1) * (win.rowRatios?.length ?? 1),
            })
          }
        }
      }
    }
  }

  return {
    walls: allWalls,
    doors: allDoors,
    windows: allWindows,
    rooms: allRooms,
    floors,
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

/** Download JSON file */
export function downloadJSON() {
  const data = exportFloorPlanJSON()
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `floorplan_${Date.now()}.json`
  a.click()
  URL.revokeObjectURL(url)
}
