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

function polygonSignatureFrom(polygon: [number, number][]): string {
  if (polygon.length === 0) return ''
  let minIdx = 0
  for (let i = 1; i < polygon.length; i++) {
    const p = polygon[i]!
    const m = polygon[minIdx]!
    if (p[0] < m[0] - 1e-6 || (Math.abs(p[0] - m[0]) < 1e-6 && p[1] < m[1] - 1e-6)) minIdx = i
  }
  const rotated: [number, number][] = []
  for (let i = 0; i < polygon.length; i++) {
    rotated.push(polygon[(minIdx + i) % polygon.length]!)
  }
  return rotated.map((p) => `${Math.round(p[0] * 100)},${Math.round(p[1] * 100)}`).join('|')
}

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

        // Existing auto zones on this level, keyed by signature.
        const existingAutoIds = new Map<string, string>()
        const existingAutoAll: ZoneNode[] = []
        for (const n of Object.values(nodes)) {
          if (n.type !== 'zone') continue
          const z = n as ZoneNode
          if (z.parentId !== activeLevelId) continue
          if (!(z as any).metadata?.autoCreated) continue
          existingAutoAll.push(z)
          existingAutoIds.set(polygonSignatureFrom(z.polygon), z.id)
        }

        if (walls.length < 3) {
          // Clear all auto zones -- nothing to enclose.
          for (const z of existingAutoAll) state.deleteNode(z.id as AnyNodeId)
          return
        }

        const detected = detectClosedRooms(walls)
        const detectedSigs = new Set(detected.map((d) => d.signature))

        // Ritn3D 2026-08-01: report what a pass actually produced.
        // A user importing a 31-wall plan saw room numbering reach ~30 and
        // every click landing on a room. Two very different causes look
        // identical from outside: genuinely detecting ~30 faces (a wall-graph
        // problem), or detecting ~10 and CHURNING them across passes so
        // roomCounterRef keeps climbing (a stability problem). The counter
        // only ever increments, so room NAMES are not a count. Log the three
        // numbers that separate the cases rather than inferring again.
        if (detected.length !== existingAutoAll.length) {
          console.info('[auto-rooms]', {
            walls: walls.length,
            detected: detected.length,
            existingAuto: existingAutoAll.length,
            nameCounter: roomCounterRef.current,
          })
        }

        // Delete stale auto zones.
        for (const z of existingAutoAll) {
          const sig = polygonSignatureFrom(z.polygon)
          if (!detectedSigs.has(sig)) {
            state.deleteNode(z.id as AnyNodeId)
          }
        }

        // Create zones for new signatures.
        for (const d of detected) {
          if (existingAutoIds.has(d.signature)) continue
          roomCounterRef.current += 1
          const zone = {
            id: generateId('zone') as ZoneNode['id'],
            type: 'zone' as const,
            parentId: activeLevelId as any,
            visible: true,
            name: `Room ${roomCounterRef.current}`,
            polygon: d.polygon,
            color: '#3b82f6',
            roomType: 'other',
            metadata: { autoCreated: true },
          }
          state.createNode(zone as any, activeLevelId as any)
        }
      } catch (err) {
        console.error('[auto-rooms] tick failed', err)
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
