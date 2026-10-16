'use client'

import { type AnyNode, type AnyNodeId, emitter, generateId, useScene } from '@ritn3d/core'
import { useViewer } from '@ritn3d/viewer'
import { useState } from 'react'
import { usePlanDetect } from '../../store/use-plan-detect'

/**
 * "Detect plan" on a level (multi-storey AI detection, 2026-10-16).
 *
 * Upload an image or a PDF page while on a level -> the host's detector turns
 * it into walls, doors and windows on THAT level -> "Align to floor below"
 * opens so the new storey can be laid over the one beneath it. No wall-review
 * step: anything detection got wrong is fixed in the editor.
 *
 * startPlanDetect() is the entry point (the Detect rail button calls it);
 * this component renders the questions, the progress and errors.
 */
export async function startPlanDetect(file: File, levelId: string) {
  const { setDialog } = usePlanDetect.getState()
  const isPdf = file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf')
  if (!isPdf && !file.type.startsWith('image/')) {
    setDialog({ step: 'error', levelId, message: 'Use a JPG, PNG or PDF of the floor plan.' })
    return
  }
  let pages = 1
  if (isPdf) {
    setDialog({ step: 'working', levelId, message: 'Reading PDF…' })
    try {
      const { pdfPageCount } = await import('../../lib/pdf-to-image')
      pages = await pdfPageCount(file)
    } catch (err) {
      setDialog({ step: 'error', levelId, message: errorMessage(err) })
      return
    }
  }
  const hasWalls = levelChildren(levelId).some((n) => n.type === 'wall')
  if (pages > 1 || hasWalls) {
    setDialog({ step: 'setup', levelId, file, pages, hasWalls })
    return
  }
  await runPlanDetect(file, levelId, 1, false)
}

function levelChildren(levelId: string): AnyNode[] {
  const nodes = useScene.getState().nodes as Record<string, AnyNode>
  const level = nodes[levelId] as any
  return ((level?.children ?? []) as string[]).map((id) => nodes[id]).filter(Boolean) as AnyNode[]
}

function errorMessage(err: unknown): string {
  return err instanceof Error && err.message ? err.message : "Couldn't detect this plan. Try a clearer image."
}

function readAsDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(String(r.result))
    r.onerror = () => reject(r.error)
    r.readAsDataURL(blob)
  })
}

function dataUrlToBlob(dataUrl: string): Blob {
  const comma = dataUrl.indexOf(',')
  const mime = /^data:([^;,]+)/.exec(dataUrl)?.[1] ?? 'image/jpeg'
  const bin = atob(dataUrl.slice(comma + 1))
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return new Blob([bytes], { type: mime })
}

async function runPlanDetect(file: File, levelId: string, page: number, replace: boolean) {
  const { setDialog, detector } = usePlanDetect.getState()
  if (!detector) {
    setDialog({ step: 'error', levelId, message: 'Plan detection is not available here.' })
    return
  }
  try {
    // One image feeds detection AND the guide, so the two line up exactly.
    // PDF pages go out at 2000 px JPEG -- the size the webapp upload flow and
    // the mobile app (2048) already detect well at.
    setDialog({ step: 'working', levelId, message: 'Preparing image…' })
    let image: Blob
    let guideUrl: string
    const isPdf = file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf')
    if (isPdf) {
      const { pdfFileToImageDataUrl } = await import('../../lib/pdf-to-image')
      const { dataUrl } = await pdfFileToImageDataUrl(file, { page, maxEdge: 2000, mime: 'image/jpeg' })
      guideUrl = dataUrl
      image = dataUrlToBlob(dataUrl)
    } else {
      image = file
      guideUrl = await readAsDataUrl(file)
    }

    setDialog({ step: 'working', levelId, message: 'Detecting walls, doors and windows…' })
    const result = await detector(image, levelId)
    const wallCount = result.nodes.filter((n) => n.type === 'wall').length
    if (wallCount === 0) {
      setDialog({
        step: 'error',
        levelId,
        message: "No walls found. Use a clear plan drawing (not a photo of a room) and try again.",
      })
      return
    }

    // The level may have gone (undo, delete) while detection ran.
    const scene = useScene.getState()
    if ((scene.nodes as Record<string, AnyNode>)[levelId]?.type !== 'level') {
      setDialog({ step: 'closed' })
      return
    }

    if (replace) {
      // Walls (their doors and windows go with them), rooms and the old
      // plan image. The floor slab, stairs, roofs and furniture stay.
      const ids = levelChildren(levelId)
        .filter((n) => n.type === 'wall' || n.type === 'zone' || n.type === 'guide')
        .map((n) => n.id as AnyNodeId)
      if (ids.length) scene.deleteNodes(ids)
    }

    const ops: { node: AnyNode; parentId?: AnyNodeId }[] = []
    if (result.guide) {
      // Image first so it sits under the geometry in child order.
      ops.push({
        node: {
          id: generateId('guide'),
          type: 'guide',
          object: 'node',
          parentId: levelId,
          visible: true,
          url: guideUrl,
          position: result.guide.position,
          rotation: [0, 0, 0],
          scale: result.guide.scale,
          // Same as the wall-review import: a cross-check behind real
          // geometry, not something to trace over.
          opacity: 25,
        } as unknown as AnyNode,
        parentId: levelId as AnyNodeId,
      })
    }
    for (const n of result.nodes) {
      const node = { ...(n as any) }
      if (!Array.isArray(node.children)) node.children = []
      ops.push({ node: node as AnyNode, parentId: (node.parentId ?? levelId) as AnyNodeId })
    }
    useScene.getState().createNodes(ops)

    useViewer.getState().setSelection({ levelId: levelId as any, selectedIds: [] })
    setDialog({ step: 'closed' })
    window.setTimeout(() => {
      emitter.emit('floorplan:reset-view' as any)
      emitter.emit('floorplan:align-level' as any, { levelId, auto: true })
    }, 80)
  } catch (err) {
    console.warn('[ritn3d] plan detection failed', err)
    setDialog({ step: 'error', levelId, message: errorMessage(err) })
  }
}

export function DetectPlanDialog() {
  const dialog = usePlanDetect((s) => s.dialog)
  const setDialog = usePlanDetect((s) => s.setDialog)
  const [page, setPage] = useState(1)
  const [replace, setReplace] = useState(true)

  if (dialog.step === 'closed') return null
  const close = () => setDialog({ step: 'closed' })

  return (
    <div className="fixed inset-0 z-[90] flex items-center justify-center bg-ink/20 p-4">
      <div className="w-full max-w-sm rounded-xl border border-hair bg-paper p-5 text-ink shadow-[0_8px_28px_rgba(22,24,28,0.16)]">
        <h2 className="font-semibold text-[15px]">Detect plan on this level</h2>

        {dialog.step === 'working' && (
          <div className="mt-4 flex items-center gap-3 text-[13px] text-ink/70">
            <span className="h-4 w-4 animate-spin rounded-full border-2 border-ink/20 border-t-[var(--color-accent)]" />
            {dialog.message}
          </div>
        )}

        {dialog.step === 'error' && (
          <>
            <p className="mt-3 text-[13px] text-ink/75">{dialog.message}</p>
            <div className="mt-5 flex justify-end">
              <button
                className="rounded-md bg-ink px-3 py-1.5 font-medium text-[12.5px] text-paper"
                onClick={close}
                type="button"
              >
                OK
              </button>
            </div>
          </>
        )}

        {dialog.step === 'setup' && (
          <>
            {dialog.pages > 1 && (
              <label className="mt-4 flex items-center justify-between gap-3 text-[13px]">
                <span>
                  PDF page <span className="text-ink/50">(of {dialog.pages})</span>
                </span>
                <select
                  className="rounded border border-hair bg-paper px-2 py-1 text-[13px]"
                  onChange={(e) => setPage(Number(e.target.value))}
                  value={Math.min(page, dialog.pages)}
                >
                  {Array.from({ length: dialog.pages }, (_, i) => (
                    <option key={i + 1} value={i + 1}>
                      Page {i + 1}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {dialog.hasWalls && (
              <div className="mt-4 space-y-2 text-[13px]">
                <p className="text-ink/70">This level already has walls.</p>
                <label className="flex items-center gap-2">
                  <input checked={replace} onChange={() => setReplace(true)} type="radio" />
                  Replace them with the detected plan
                </label>
                <label className="flex items-center gap-2">
                  <input checked={!replace} onChange={() => setReplace(false)} type="radio" />
                  Keep them and add the detected plan
                </label>
              </div>
            )}
            <div className="mt-5 flex justify-end gap-2">
              <button
                className="rounded-md px-3 py-1.5 text-[12.5px] text-ink/70 hover:bg-ink/[0.05]"
                onClick={close}
                type="button"
              >
                Cancel
              </button>
              <button
                className="rounded-md bg-[var(--color-accent)] px-3 py-1.5 font-semibold text-[12.5px] text-white hover:opacity-90"
                onClick={() =>
                  void runPlanDetect(
                    dialog.file,
                    dialog.levelId,
                    Math.min(page, dialog.pages),
                    dialog.hasWalls && replace,
                  )
                }
                type="button"
              >
                Detect
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
