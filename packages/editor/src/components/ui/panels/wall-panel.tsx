'use client'

import { type AnyNode, type AnyNodeId, useScene, type WallNode } from '@ritn3d/core'
import { useViewer } from '@ritn3d/viewer'
import { useCallback } from 'react'
import { cn } from '../../../lib/utils'
import { PanelSection } from '../controls/panel-section'
import { SliderControl } from '../controls/slider-control'
import { PanelWrapper } from './panel-wrapper'

export function WallPanel() {
  const selectedIds = useViewer((s) => s.selection.selectedIds)
  const setSelection = useViewer((s) => s.setSelection)
  const nodes = useScene((s) => s.nodes)
  const updateNode = useScene((s) => s.updateNode)

  const selectedId = selectedIds[0]
  const node = selectedId ? (nodes[selectedId as AnyNode['id']] as WallNode | undefined) : undefined

  const handleUpdate = useCallback(
    (updates: Partial<WallNode>) => {
      if (!selectedId) return
      updateNode(selectedId as AnyNode['id'], updates)
      useScene.getState().dirtyNodes.add(selectedId as AnyNodeId)
    },
    [selectedId, updateNode],
  )

  // Função mágica para a Issue #191: Atualiza o comprimento via cálculo vetorial
  const handleUpdateLength = useCallback((newLength: number) => {
    if (!node || newLength <= 0) return

    const dx = node.end[0] - node.start[0]
    const dz = node.end[1] - node.start[1]
    const currentLength = Math.sqrt(dx * dx + dz * dz)

    if (currentLength === 0) return

    // Calcula a direção (vetor unitário)
    const dirX = dx / currentLength
    const dirZ = dz / currentLength

    // Define o novo ponto final baseado no novo comprimento
    const newEnd: [number, number] = [
      node.start[0] + dirX * newLength,
      node.start[1] + dirZ * newLength
    ]

    handleUpdate({ end: newEnd })
  }, [node, handleUpdate])

  const handleClose = useCallback(() => {
    setSelection({ selectedIds: [] })
  }, [setSelection])

  const handleDelete = useCallback(() => {
    if (!selectedId) return
    useScene.getState().deleteNode(selectedId as AnyNodeId)
    setSelection({ selectedIds: [] })
  }, [selectedId, setSelection])

  // Ritn3D 2026-07-24 iOS parity: interior/exterior toggle. The pipeline
  // decides `is_exterior` from the wall's backSide === 'exterior' (see
  // envelope classifier). We flip both sides together so the toggle is
  // a simple boolean the user understands.
  const isExterior = node?.backSide === 'exterior'
  const setWallType = useCallback(
    (exterior: boolean) => {
      handleUpdate({
        frontSide: 'interior',
        backSide: exterior ? 'exterior' : 'interior',
      })
    },
    [handleUpdate],
  )

  if (!node || node.type !== 'wall' || selectedIds.length !== 1) return null

  const dx = node.end[0] - node.start[0]
  const dz = node.end[1] - node.start[1]
  const length = Math.sqrt(dx * dx + dz * dz)

  const height = node.height ?? 2.5
  const thickness = node.thickness ?? 0.1

  // Ritn3D 2026-06-17: slider in DEPTH (sagitta) cm — the actual thing
  // architects care about. Sweep-angle slider failed because 95 % of real
  // curves live in the first 30° of a ±180° slider — too tiny to hit. Depth
  // is linear with bulge, so the slider gives uniform precision over the
  // full useful range.
  //   sagitta = chord * bulge / 2  →  bulge = 2 * sagitta / chord
  const bulge = node.bulge ?? 0
  const depthCm = Math.round((length * bulge) / 2 * 100)
  // Slider range = ±half-chord = exactly the semicircle apex. Beyond that
  // is geometrically impossible (the arc would have to wrap further than
  // 180°, which we hard-cap against). Floor (don't round up) so the slider
  // never lets you ask for a depth that exceeds the semicircle limit.
  const halfChordCm = Math.max(10, Math.floor((length * 100) / 2))
  const setDepthCm = (cm: number) => {
    if (length < 1e-9) return
    const nextBulge = (2 * (cm / 100)) / length
    // Hard cap at semicircle (±1). Never beyond.
    const safe = Math.max(-1, Math.min(1, nextBulge))
    handleUpdate({ bulge: Math.abs(safe) < 1e-5 ? 0 : safe })
  }
  const sweepDeg = Math.round((4 * Math.atan(bulge) * 180) / Math.PI)
  const radiusM = Math.abs(bulge) > 1e-5
    ? (length * (1 + bulge * bulge)) / (4 * Math.abs(bulge))
    : null

  return (
    <PanelWrapper
      icon="/icons/wall.png"
      onClose={handleClose}
      title={node.name || 'Wall'}
      width={280}
    >
      <PanelSection title="Curve">
        <SliderControl
          label="Depth"
          max={halfChordCm}
          min={-halfChordCm}
          onChange={setDepthCm}
          precision={0}
          step={1}
          unit="cm"
          value={depthCm}
        />
        <div className="flex items-center justify-between gap-2 px-1 pt-1 text-[11px]">
          <span className="text-zinc-400">
            Sweep <span className="font-mono text-zinc-200">{sweepDeg}°</span>
            {radiusM !== null && (
              <>
                {' · '}R <span className="font-mono text-zinc-200">{radiusM < 10 ? radiusM.toFixed(2) : radiusM.toFixed(1)} m</span>
              </>
            )}
          </span>
          <div className="flex gap-1.5">
            <button
              type="button"
              className="rounded border border-zinc-600 bg-zinc-700/40 px-2 py-0.5 text-zinc-200 hover:bg-zinc-700"
              onClick={() => setDepthCm(0)}
            >
              Straight
            </button>
            <button
              type="button"
              className="rounded border border-zinc-600 bg-zinc-700/40 px-2 py-0.5 text-zinc-200 hover:bg-zinc-700"
              onClick={() => setDepthCm(-depthCm)}
            >
              Flip
            </button>
          </div>
        </div>
      </PanelSection>

      <PanelSection title="Dimensions">
        {/* Adicionando o controle de Length solicitado na Issue #191 */}
        <SliderControl
          label="Length"
          max={20}
          min={0.1}
          onChange={handleUpdateLength}
          precision={2}
          step={0.01}
          unit="m"
          value={length}
        />
        <SliderControl
          label="Height"
          max={6}
          min={0.1}
          onChange={(v) => handleUpdate({ height: Math.max(0.1, v) })}
          precision={2}
          step={0.1}
          unit="m"
          value={Math.round(height * 100) / 100}
        />
        <SliderControl
          label="Thickness"
          max={1}
          min={0.05}
          onChange={(v) => handleUpdate({ thickness: Math.max(0.05, v) })}
          precision={3}
          step={0.01}
          unit="m"
          value={Math.round(thickness * 1000) / 1000}
        />
      </PanelSection>

      <PanelSection title="Type">
        <div className="flex gap-1 px-1">
          <button
            type="button"
            onClick={() => setWallType(false)}
            className={cn(
              'flex-1 rounded-md border px-3 py-1.5 text-[12px] font-medium transition-colors',
              !isExterior
                ? 'border-ink bg-ink text-paper'
                : 'border-hair text-ink/60 hover:bg-ink/[0.04] hover:text-ink',
            )}
          >
            Interior
          </button>
          <button
            type="button"
            onClick={() => setWallType(true)}
            className={cn(
              'flex-1 rounded-md border px-3 py-1.5 text-[12px] font-medium transition-colors',
              isExterior
                ? 'border-ink bg-ink text-paper'
                : 'border-hair text-ink/60 hover:bg-ink/[0.04] hover:text-ink',
            )}
          >
            Exterior
          </button>
        </div>
      </PanelSection>

      <PanelSection title="">
        <button
          type="button"
          onClick={handleDelete}
          className="w-full rounded-md border border-red-300/60 bg-red-50/40 px-3 py-1.5 text-[12px] font-medium text-red-700 transition-colors hover:bg-red-100/60"
        >
          Delete wall
        </button>
      </PanelSection>
    </PanelWrapper>
  )
}
