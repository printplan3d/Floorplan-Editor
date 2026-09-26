'use client'

import { type AnyNode, type AnyNodeId, resolveRoofContext, useScene, windowsUnderSegment } from '@ritn3d/core'
import { useViewer } from '@ritn3d/viewer'
import { useEffect } from 'react'
import { useDormerPick } from '../../../store/use-dormer-pick'

/** A new dormer that follows a window: placement and size come from the
 *  window (roof-scene's dormer overrides), so only the style is set. */
export function newWindowDormer(windowId: string): Record<string, unknown> {
  return {
    id: `dorm_${Math.random().toString(36).slice(2, 10)}`,
    parentFaceId: 0,
    footOnParent: [
      [0.35, 0.15],
      [0.55, 0.35],
    ],
    type: 'gable',
    ridgeHeight: 0.8,
    cheekWidth: 1.2,
    ridgeOrientation: 'orthogonal',
    windowId,
  }
}

/**
 * Finishes "Add dormer → pick a window". While a pick is running, the next
 * window the operator selects gets a dormer on the roof segment that
 * started it (or, if the window isn't under that one, on whichever roof
 * segment it is under), then the roof segment is selected again so its
 * panel shows the new dormer. Esc or Cancel stops it. Shows its own banner,
 * since the roof panel closes while a window is being picked.
 */
export function DormerWindowPicker() {
  const segId = useDormerPick((s) => s.segId)
  const roofLevelId = useDormerPick((s) => s.roofLevelId)
  const message = useDormerPick((s) => s.message)
  const cancel = useDormerPick((s) => s.cancel)
  const setMessage = useDormerPick((s) => s.setMessage)
  const selectedIds = useViewer((s) => s.selection.selectedIds)

  useEffect(() => {
    if (!segId) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') cancel()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [segId, cancel])

  useEffect(() => {
    if (!segId) return
    const picked = selectedIds[0]
    if (!picked) return
    const scene = useScene.getState()
    const nodes = scene.nodes as Record<string, AnyNode>
    const win = nodes[picked]
    if (!win || win.type !== 'window') return

    const ctx = resolveRoofContext(nodes)
    const under = (sid: string) => windowsUnderSegment(nodes, ctx, sid).some((w) => w.id === picked)
    // The roof that started the pick first; otherwise any roof over it.
    let target: string | null = under(segId) ? segId : null
    if (!target) {
      for (const sid of ctx.segments.keys()) {
        if (under(sid)) {
          target = sid
          break
        }
      }
    }
    if (!target) {
      setMessage("That window isn't under a roof (or sits below it). Pick another, or Esc.")
      return
    }
    const seg = nodes[target] as AnyNode & { dormers?: { windowId?: string }[]; parentId?: string }
    const dormers = seg.dormers ?? []
    if (!dormers.some((d) => d.windowId === picked)) {
      scene.updateNode(target as AnyNodeId, { dormers: [...dormers, newWindowDormer(picked)] } as never)
    }
    const roof = seg.parentId ? nodes[seg.parentId] : undefined
    const levelId = (roof as { parentId?: string } | undefined)?.parentId ?? roofLevelId
    cancel()
    useViewer.getState().setSelection((levelId ? { levelId, selectedIds: [target] } : { selectedIds: [target] }) as never)
  }, [segId, selectedIds, roofLevelId, cancel, setMessage])

  if (!segId) return null
  return (
    <div className="pointer-events-none fixed inset-x-0 top-16 z-[10001] flex justify-center">
      <div className="pointer-events-auto flex items-center gap-3 rounded-lg border border-amber-500/60 bg-neutral-900/95 px-4 py-2 text-sm text-neutral-100 shadow-lg">
        <div>
          <div>Click the window this dormer should sit on.</div>
          <div className="text-xs text-neutral-400">
            {message ?? 'Upper-floor windows: switch to that floor in the plan first.'}
          </div>
        </div>
        <button
          className="rounded border border-neutral-600 px-2 py-1 text-xs hover:bg-neutral-800"
          onClick={cancel}
          type="button"
        >
          Cancel
        </button>
      </div>
    </div>
  )
}
