import { type AnyNodeId, arcLength, DEFAULT_WALL_HEIGHT, DEFAULT_WALL_THICKNESS, type DoorNode, type WallNode, type WindowNode, type ZoneNode, useScene } from '@ritn3d/core'
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
        // Ritn3D 2026-07-19: pre-flip X (and bulge sign) client-side to
        // match the mobile Flutter editor's `maybeFlip(p) => [-p[0], p[1]]`.
        // The pascal-editor stores planPoint = -svgClick (toSvgX = -value),
        // so a wall drawn on-screen-right has stored X negative. The
        // backend translator's [-x, -y] would then leave X negative in
        // Blender -> viewer shows the wall on the LEFT -> left-right
        // flipped for the user. Flipping X here (and the bulge sign to
        // keep arcs curving the correct way after mirror) lines webapp's
        // POST body up with mobile's, which the translator handles
        // correctly. Bulge sign follows the same rule the mobile editor
        // uses at [editor_scene.dart:250].
        const flipX = ([x, y]: [number, number]): [number, number] => [-x, y]
        const flipBulge = (b: number) => -b
        const wallExport = {
          id: w.id,
          start: flipX(w.start as any),
          end: flipX(w.end as any),
          thickness: w.thickness ?? DEFAULT_WALL_THICKNESS,
          height: w.height ?? DEFAULT_WALL_HEIGHT,
          type: w.frontSide === 'exterior' || w.backSide === 'exterior' ? 'exterior' : 'interior',
          // Ritn3D arc walls (DXF bulge: tan(arc_angle/4); 0 = straight).
          // Omitted from JSON when bulge is 0 so the Blender pipeline can
          // keep a simpler straight-wall code path for legacy plans.
          ...(w.bulge && w.bulge !== 0 ? { bulge: flipBulge(w.bulge) } : {}),
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
            // Ritn3D 2026-07-16 (Tier 2): export style + frame dims +
            // handle metadata so the Blender pipeline can render an
            // actual leaf (flush slab / glass / patio sliding) instead
            // of just a doorway.
            levelDoors.push({
              id: d.id,
              wall_id: w.id,
              position_along_wall: wallLen > 0 ? d.position[0] / wallLen : 0.5,
              width: d.width,
              height: d.height,
              door_type: 'single',
              style: d.style ?? 'pedestrian',
              swing_direction: d.hingesSide === 'left' ? 'left' : 'right',
              hinges_side: d.hingesSide ?? 'left',
              frame_thickness: d.frameThickness ?? 0.05,
              frame_depth: d.frameDepth ?? 0.07,
              threshold: d.threshold ?? true,
              handle: d.handle ?? true,
              handle_side: d.handleSide ?? 'right',
              handle_height: d.handleHeight ?? 1.05,
            })
          }
          if (wc.type === 'window') {
            const win = wc as WindowNode
            // For curved walls, "position_along_wall" is parametric over arc
            // length, not chord. For straight walls bulge=0 so arcLength
            // collapses to chord length — same answer as before.
            const wallLen = arcLength(w.start, w.end, w.bulge ?? 0)
            const sillHeight = Math.max(0, (win.position[1] ?? 0) - (win.height ?? 1.5) / 2)
            // Ritn3D 2026-07-16 (Tier 2): export the actual pane grid
            // ratios + frame dims + sill toggle so Blender stops
            // auto-computing them and respects the user's design.
            levelWindows.push({
              id: win.id,
              wall_id: w.id,
              position_along_wall: wallLen > 0 ? win.position[0] / wallLen : 0.5,
              width: win.width,
              height: win.height,
              sill_height: sillHeight,
              pane_count: (win.columnRatios?.length ?? 1) * (win.rowRatios?.length ?? 1),
              column_ratios: win.columnRatios ?? [1],
              row_ratios: win.rowRatios ?? [1],
              column_divider_thickness: win.columnDividerThickness ?? 0.03,
              row_divider_thickness: win.rowDividerThickness ?? 0.03,
              frame_thickness: win.frameThickness ?? 0.05,
              frame_depth: win.frameDepth ?? 0.07,
              sill: win.sill ?? true,
              sill_depth: win.sillDepth ?? 0.08,
              sill_thickness: win.sillThickness ?? 0.03,
            })
          }
        }
      }

      if (child.type === 'zone') {
        const z = child as ZoneNode
        // 2026-07-28: pipe the ZonePanel's roomType through to the
        // pipeline so Blender picks the right floor material
        // (bathroom -> tiles, kitchen -> laminate, etc.). Was
        // hardcoded 'other' so every room got the default material
        // regardless of the type the user selected in the picker.
        levelRooms.push({
          id: z.id,
          label: z.name || 'Room',
          type: (z as any).roomType || 'other',
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
        // D6: per-surface finishes (schemes + regions). Empty when the
        // user hasn't drawn anything — the backend synthesises a
        // 'default' scheme from legacy Project.furniture_scene.textures
        // so consumer projects without regions still render as before.
        finishes: exportFinishes(),
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
          thickness: w.thickness ?? DEFAULT_WALL_THICKNESS,
          height: w.height ?? DEFAULT_WALL_HEIGHT,
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
    finishes: exportFinishes(),
    metadata: {
      unit: 'meters',
      scale: 1.0,
      created_at: new Date().toISOString(),
      source: 'web_editor',
      version: '1.0',
    },
  }
}

/**
 * Extract the per-surface finishes payload from useScene for
 * embedding in the exported plan JSON (D6).
 *
 * Shape is a subset of what the backend expects on
 * Project.furniture_scene.schemes — see
 * PER_SURFACE_FINISHES_STORAGE_SPEC.md. Returned as-is; the backend
 * mirror-copies it into furniture_scene during save.
 */
function exportFinishes(): object | undefined {
  const { finishes } = useScene.getState()
  if (!finishes) return undefined
  // Skip when the scheme is a completely-empty default (fresh plan with
  // no user interaction) — cleaner to omit the key entirely.
  const anyRegions = Object.values(finishes.sets).some(s => s.regions.length > 0)
  const anyOverrides = Object.values(finishes.sets).some(s => Object.keys(s.overrides).length > 0)
  const anyGlobal = Object.values(finishes.sets).some(s => s.wall || s.floor)
  if (!(anyRegions || anyOverrides || anyGlobal)) return undefined
  return {
    schemes: {
      active: finishes.active,
      sets: finishes.sets,
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
