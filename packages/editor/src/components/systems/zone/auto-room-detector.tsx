'use client'

/*
  Ritn3D 2026-07-24 rev2: Auto-detect closed rooms from the wall network
  and sync them as ZoneNodes on the active level.

  Rewritten from subscribe-based to POLLING. Reason: useScene.subscribe
  in this Zustand build passes only (state) not (state, prev), so the
  previous `s.nodes === prev.nodes` short-circuit was throwing and the
  detector never ran. Polling every 400 ms is cheap for our node counts
  and works regardless of the subscribe signature.

  Behaviour is otherwise unchanged:
    - Runs every 400 ms while the editor isn't in build mode
    - Detects every planar face in the wall graph via right-hand rule
    - Auto zones carry metadata.autoCreated so manual zones never get
      touched
    - Sliver faces (< 0.5 m^2) rejected
*/

import { type AnyNodeId, generateId, useScene, type WallNode, type ZoneNode } from '@ritn3d/core'
import { useViewer } from '@ritn3d/viewer'
import { useEffect, useRef } from 'react'
import useEditor from '../../../store/use-editor'
import { detectClosedRooms, type WallSegment } from '../../../lib/detect-rooms'

const POLL_MS = 400

// Snapshot of the wall network we last processed. Skip re-detection
// if walls haven't changed since the last poll.
function wallsSnapshot(nodes: Record<string, any>, levelId: string): string {
  const parts: string[] = []
  for (const n of Object.values(nodes)) {
    if (n.type !== 'wall') continue
    if (n.parentId !== levelId) continue
    parts.push(`${n.id}:${n.start[0].toFixed(3)},${n.start[1].toFixed(3)}-${n.end[0].toFixed(3)},${n.end[1].toFixed(3)}`)
  }
  parts.sort()
  return parts.join('|')
}

export function AutoRoomDetector() {
  const lastSnapshotRef = useRef<string>('')
  const roomCounterRef = useRef<number>(0)

  useEffect(() => {
    let cancelled = false

    const tick = () => {
      if (cancelled) return
      // Auto rooms are DERIVED state, not user edits, so they must not enter
      // undo history. Each room was a separate createNode, so importing a
      // plan with 10 rooms buried the user's actual work under 10 undo steps
      // they never performed -- and undoing one just made the next tick
      // recreate it, since this pass re-derives rooms from the walls anyway.
      //
      // Paused for the whole tick and resumed in finally, so an early return
      // or a throw can never leave history switched off; that would silently
      // stop recording every real edit afterwards.
      const temporal = useScene.temporal.getState()
      const wasTracking = temporal.isTracking !== false
      if (wasTracking) temporal.pause()
      try {
        const state = useScene.getState()
        const nodes = state.nodes
        const activeLevelId = useViewer.getState().selection.levelId
        if (!activeLevelId) return

        // Skip while user is mid-draw (build mode) to avoid churn.
        const mode = useEditor.getState().mode
        if (mode === 'build') return

        const snap = wallsSnapshot(nodes, activeLevelId as string)
        if (snap === lastSnapshotRef.current) return
        lastSnapshotRef.current = snap

        const walls: WallSegment[] = []
        for (const n of Object.values(nodes)) {
          if (n.type !== 'wall') continue
          const w = n as WallNode
          if (w.parentId !== activeLevelId) continue
          walls.push({ id: w.id, start: [w.start[0], w.start[1]], end: [w.end[0], w.end[1]] })
        }

        /* Every zone on this level is auto-derived, full stop.

           This used to filter on `metadata.autoCreated`, and that flag is the
           whole bug behind "this plan has 49 rooms". Nothing carries metadata
           across the sync wire — plan-scene.ts rebuilds each zone from
           { parentId, name, polygon, roomType } — so after any save/load
           every zone came back unflagged. Unflagged meant invisible to BOTH
           halves of this pass: not found when matching, so a duplicate was
           created; not seen when sweeping, so the original was never removed.
           One extra copy per room per open. Plan 36 reached 49 rooms from 8
           real ones over 117 revisions, and 10 of 131 live plans were
           affected.

           Filtering on a flag was the wrong idea, not a broken detail. Rooms
           are a pure function of the wall graph — there is no such thing as a
           hand-drawn one to protect. iOS and Flutter have always rebuilt the
           whole set from the detector and never grew a duplicate. */
        const existingZones: ZoneNode[] = []
        for (const n of Object.values(nodes)) {
          if (n.type !== 'zone') continue
          const z = n as ZoneNode
          if (z.parentId !== activeLevelId) continue
          existingZones.push(z)
        }

        if (walls.length < 3) {
          // Nothing can be enclosed, so nothing is a room.
          for (const z of existingZones) state.deleteNode(z.id as AnyNodeId)
          return
        }

        const detected = detectClosedRooms(walls)

        /* Ritn3D 2026-08-01: report what a pass actually produced.

           A user importing a 31-wall plan saw room numbering reach ~30 and
           every click landing on a room. Two very different causes look
           identical from outside: genuinely detecting ~30 faces (a wall-graph
           problem), or detecting ~10 and CHURNING them across passes so
           roomCounterRef keeps climbing (a stability problem).

           It was the second, and this log said so on every load — `detected`
           steady while `existing` climbed. Kept, because the count can now
           only disagree for the first reason, which makes it a much sharper
           signal than it was. */
        if (detected.length !== existingZones.length) {
          console.info('[auto-rooms]', {
            walls: walls.length,
            detected: detected.length,
            existing: existingZones.length,
            nameCounter: roomCounterRef.current,
          })
        }

        /* Carry each existing room's name and type onto the detected room it
           best matches, by shared-wall overlap.

           Wall ids, not polygons: move one wall and every vertex of the room
           changes, so a polygon match would read as "old room gone, new room
           appeared" and drop the name the user typed. The wall set barely
           moves. It also survives the sync wire, which a metadata flag does
           not — that is the point.

           The assignment MUST be one-to-one. Picking, for each detected room
           independently, the previous room with the greatest overlap lets
           several detected rooms all claim the SAME previous one and inherit
           its identity — draw a rectangle, add partitions, and every new room
           overlaps that first room. iOS hit exactly this and its fix is the
           shape copied here: score every pair, take the strongest first,
           retire both sides once used. */
        const pairs: { d: number; p: number; score: number }[] = []
        detected.forEach((d, di) => {
          const dSet = new Set(d.wallIds)
          existingZones.forEach((z, pi) => {
            const prev: string[] = ((z as any).metadata?.wallIds as string[]) ?? []
            if (prev.length === 0) return
            let inter = 0
            for (const w of prev) if (dSet.has(w)) inter += 1
            if (inter === 0) return
            const union = new Set([...dSet, ...prev]).size
            pairs.push({ d: di, p: pi, score: union === 0 ? 0 : inter / union })
          })
        })
        // Ties broken explicitly so two runs over the same plan agree.
        pairs.sort((a, b) =>
          a.score !== b.score ? b.score - a.score : a.d !== b.d ? a.d - b.d : a.p - b.p,
        )
        const matchFor = new Map<number, number>()
        const claimed = new Set<number>()
        for (const pr of pairs) {
          if (matchFor.has(pr.d) || claimed.has(pr.p)) continue
          matchFor.set(pr.d, pr.p)
          claimed.add(pr.p)
        }

        /* Replace the set rather than patching it. Every zone goes, then one
           is created per detected room — so the count is always exactly what
           the detector found and a duplicate cannot survive a pass, however
           this state was reached. That is what makes it self-healing on the
           plans already carrying duplicates. */
        for (const z of existingZones) state.deleteNode(z.id as AnyNodeId)

        detected.forEach((d, di) => {
          const prevIdx = matchFor.get(di)
          const prev = prevIdx === undefined ? undefined : existingZones[prevIdx]
          let name = prev?.name
          if (!name) {
            roomCounterRef.current += 1
            name = `Room ${roomCounterRef.current}`
          }
          const zone = {
            // A matched room keeps its id, so anything referring to it by id
            // still resolves after an edit.
            id: (prev?.id ?? generateId('zone')) as ZoneNode['id'],
            type: 'zone' as const,
            parentId: activeLevelId as any,
            visible: true,
            name,
            polygon: d.polygon,
            color: prev?.color ?? '#3b82f6',
            roomType: prev?.roomType ?? 'other',
            // wallIds is what the NEXT pass matches on, so it has to be
            // stored. autoCreated is kept only so an older build reading a
            // newer plan still recognises these as its own.
            metadata: { autoCreated: true, wallIds: d.wallIds },
          }
          state.createNode(zone as any, activeLevelId as any)
        })
      } catch (err) {
        console.error('[auto-rooms] tick failed', err)
      } finally {
        if (wasTracking) useScene.temporal.getState().resume()
      }
    }

    const timer = window.setInterval(tick, POLL_MS)
    // Run once immediately so scene reloads pick up existing walls.
    tick()

    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [])

  return null
}
