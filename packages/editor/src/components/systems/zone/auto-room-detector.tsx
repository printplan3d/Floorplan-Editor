'use client'

/*
  Ritn3D 2026-07-24: Auto-detect closed rooms from the wall network and
  sync them as ZoneNodes on the active level.

  Behaviour:
    - Subscribes to scene node changes (Zustand). On every wall create /
      update / delete, debounces ~350 ms and re-runs detectClosedRooms().
    - For each detected face polygon:
        * hash the polygon (rotation-invariant signature) and match against
          existing zones on the level whose metadata.autoCreated === true
        * new signature => create a "Room N" zone with metadata.autoCreated
        * disappearing signature => delete the auto-created zone
    - Zones the user created MANUALLY (no metadata.autoCreated flag) are
      never touched, so drawing over them or adding rooms next to them
      is safe.

  Runs only when at least one wall exists on the active level and the
  editor isn't in the middle of a build-tool interaction (to avoid churn
  during drag drawing).
*/

import { type AnyNodeId, generateId, useScene, type WallNode, type ZoneNode } from '@ritn3d/core'
import { useViewer } from '@ritn3d/viewer'
import { useEffect, useRef } from 'react'
import useEditor from '../../../store/use-editor'
import { detectClosedRooms, type WallSegment } from '../../../lib/detect-rooms'

const DEBOUNCE_MS = 350

interface ExistingAutoZone {
  id: string
  signature: string
}

function polygonSignatureFrom(polygon: [number, number][]): string {
  if (polygon.length === 0) return ''
  let minIdx = 0
  for (let i = 1; i < polygon.length; i++) {
    const [px, py] = polygon[i]
    const [mx, my] = polygon[minIdx]
    if (px < mx - 1e-6 || (Math.abs(px - mx) < 1e-6 && py < my - 1e-6)) minIdx = i
  }
  const rotated: [number, number][] = []
  for (let i = 0; i < polygon.length; i++) {
    rotated.push(polygon[(minIdx + i) % polygon.length])
  }
  return rotated.map(([x, y]) => `${Math.round(x * 100)},${Math.round(y * 100)}`).join('|')
}

export function AutoRoomDetector() {
  const timerRef = useRef<number | null>(null)
  const roomCounterRef = useRef<number>(0)

  useEffect(() => {
    const run = () => {
      const state = useScene.getState()
      const nodes = state.nodes
      const activeLevelId = useViewer.getState().selection.levelId
      if (!activeLevelId) return

      // Skip while a build tool is active (user is mid-draw); wait until
      // they return to select mode so we don't churn zones per drag frame.
      const mode = useEditor.getState().mode
      if (mode === 'build') return

      // Collect walls on the active level.
      const walls: WallSegment[] = []
      for (const n of Object.values(nodes)) {
        if (n.type !== 'wall') continue
        const w = n as WallNode
        if (w.parentId !== activeLevelId) continue
        walls.push({
          id: w.id,
          start: [w.start[0], w.start[1]],
          end: [w.end[0], w.end[1]],
        })
      }
      if (walls.length < 3) {
        // Not enough walls to enclose anything -- also delete any leftover
        // auto zones so the panel doesn't stale.
        const staleAuto = Object.values(nodes).filter(
          (n): n is ZoneNode =>
            n.type === 'zone' && n.parentId === activeLevelId &&
            !!(n as any).metadata?.autoCreated,
        )
        for (const z of staleAuto) state.deleteNode(z.id as AnyNodeId)
        return
      }

      const detected = detectClosedRooms(walls)
      const detectedBySig = new Map(detected.map((d) => [d.signature, d]))

      // Snapshot existing auto zones (keyed by signature).
      const existing: ExistingAutoZone[] = []
      for (const n of Object.values(nodes)) {
        if (n.type !== 'zone') continue
        const z = n as ZoneNode
        if (z.parentId !== activeLevelId) continue
        if (!(z as any).metadata?.autoCreated) continue
        existing.push({ id: z.id, signature: polygonSignatureFrom(z.polygon) })
      }
      const existingBySig = new Map(existing.map((e) => [e.signature, e.id]))

      // Delete auto zones whose signature no longer matches a detected room.
      for (const e of existing) {
        if (!detectedBySig.has(e.signature)) {
          state.deleteNode(e.id as AnyNodeId)
        }
      }

      // Create auto zones for new signatures.
      for (const d of detected) {
        if (existingBySig.has(d.signature)) continue
        roomCounterRef.current += 1
        const zone: ZoneNode = {
          id: generateId('zone') as ZoneNode['id'],
          type: 'zone',
          parentId: activeLevelId as any,
          visible: true,
          name: `Room ${roomCounterRef.current}`,
          polygon: d.polygon,
          color: '#3b82f6',
          roomType: 'other' as any,
          metadata: { autoCreated: true } as any,
        } as any
        state.createNode(zone as any, activeLevelId as any)
      }
    }

    const schedule = () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current)
      timerRef.current = window.setTimeout(() => {
        timerRef.current = null
        run()
      }, DEBOUNCE_MS)
    }

    // Subscribe to any scene node change. run() itself filters to walls.
    const unsub = useScene.subscribe((s, prev) => {
      if (s.nodes === prev.nodes) return
      schedule()
    })
    // Also re-run when the editor mode leaves 'build' (user finished a
    // wall drag) so the debounce doesn't sit forever.
    const unsubEditor = useEditor.subscribe((s, prev) => {
      if (s.mode !== prev.mode && s.mode !== 'build') schedule()
    })
    // Initial run for scenes loaded with existing walls.
    schedule()

    return () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current)
      unsub()
      unsubEditor()
    }
  }, [])

  return null
}
