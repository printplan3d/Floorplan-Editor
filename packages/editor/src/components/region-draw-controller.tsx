'use client'

/*
 * Ritn3D 2026-09-02 (D3): Region draw controller.
 *
 * Rendered once inside the editor tree. Subscribes to wall click events
 * from the viewer emitter. When the 'region' tool is active:
 *
 *   1. First click on a wall → startRegionDraw(wallId, side)
 *   2. Each subsequent click on THE SAME wall → addRegionPoint(along, up)
 *   3. Click on a different wall → cancels draft, starts a new one
 *   4. Panel's "Finish" button → commit region + open material picker
 *
 * Arc-wall guard (D7): if bulge != 0 on the wall, refuse the click and
 * console.warn a tooltip-shaped message.
 *
 * Coord conversion: takes the click's world position, projects into the
 * wall's local (along, up) frame using the wall's start/end + height.
 * The wall's local space's X is stored as its plan XY vector; we build
 * the frame the same way as viewer/_finishes.js buildWallFrame.
 */

import { arcLength, emitter, useScene, type WallEvent, type WallNode } from '@ritn3d/core'
import { useEffect } from 'react'
import useEditor from '../store/use-editor'

export function RegionDrawController() {
  const tool = useEditor((s) => s.tool)
  const draft = useEditor((s) => s.regionDraft)
  const startRegionDraw = useEditor((s) => s.startRegionDraw)
  const addRegionPoint = useEditor((s) => s.addRegionPoint)

  useEffect(() => {
    if (tool !== 'region') return

    const onClick = (e: WallEvent) => {
      const w = e.node as WallNode
      // D7 — arc walls disabled in v1 (sub-wall UV continuity is v1.5).
      if (w.bulge && Math.abs(w.bulge) > 1e-6) {
        console.warn(
          '[finishes] Regions on curved walls are not yet supported. ' +
          'Straight walls only in v1.',
        )
        return
      }
      // Compute wall-local (along, up) from the click's world position.
      const sx = w.start[0], sy = w.start[1]
      const ex = w.end[0], ey = w.end[1]
      const len = arcLength(w.start, w.end, w.bulge ?? 0)
      const dx = ex - sx, dy = ey - sy
      const norm = Math.hypot(dx, dy) || 1
      const alongX = dx / norm, alongY = dy / norm
      // 3D scene coord frame: X == plan X, Z == -plan Y (Y-up world).
      // click.position is [x, y, z] in world space.
      const wx = e.position[0]
      const wz = e.position[2]
      // Recover plan XY from world XZ:
      const planClickX = wx
      const planClickY = -wz
      // Project on the wall along-axis:
      const along = (planClickX - sx) * alongX + (planClickY - sy) * alongY
      // `up` is directly the world Y:
      const up = e.position[1]

      // Decide side from the normal component: which side of the wall
      // did the click land on? Right of the along vector = normalOut.
      // Fallback to 'interior' if degenerate.
      const relX = planClickX - sx, relY = planClickY - sy
      const normalDot = relX * alongY + relY * (-alongX)  // dot with rot(along, -90)
      const side: 'interior' | 'exterior' = normalDot > 0 ? 'exterior' : 'interior'

      // Clamp to the wall footprint so a slightly-off click doesn't
      // stray outside [0, length] × [0, height].
      const clAlong = Math.max(0, Math.min(len, along))
      const clUp = Math.max(0, Math.min(w.height ?? 2.7, up))

      if (!draft || draft.wallId !== w.id) {
        // Different wall / no draft → start fresh.
        useEditor.getState().startRegionDraw(w.id, side)
        useEditor.getState().addRegionPoint(clAlong, clUp)
      } else {
        addRegionPoint(clAlong, clUp)
      }
    }

    emitter.on('wall:click', onClick)
    return () => {
      emitter.off('wall:click', onClick)
    }
  }, [tool, draft, addRegionPoint])

  return null
}
