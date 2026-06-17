'use client'

import { type AnyNode, type AnyNodeId, useScene, type WallNode } from '@pascal-app/core'
import { useViewer } from '@pascal-app/viewer'
import { useCallback } from 'react'
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

  if (!node || node.type !== 'wall' || selectedIds.length !== 1) return null

  const dx = node.end[0] - node.start[0]
  const dz = node.end[1] - node.start[1]
  const length = Math.sqrt(dx * dx + dz * dz)

  const height = node.height ?? 2.5
  const thickness = node.thickness ?? 0.1

  // Ritn3D 2026-06-17: curve slider. bulge<->sweep-angle conversion so the
  // user sees degrees (intuitive) instead of the raw -1..1 tangent value.
  //   sweep = 4 * atan(bulge)   (radians)
  //   bulge = tan(sweep / 4)
  // bulge -1 = -180°, 0 = straight, +1 = +180° (semicircle each side).
  // Drag UX kept fighting us — slider is the reliable path.
  const bulge = node.bulge ?? 0
  const sweepDeg = Math.round((4 * Math.atan(bulge) * 180) / Math.PI)
  const setSweepDeg = (deg: number) => {
    const clamped = Math.max(-179.9, Math.min(179.9, deg))
    const nextBulge = Math.tan((clamped * Math.PI) / 180 / 4)
    handleUpdate({ bulge: Math.abs(nextBulge) < 1e-5 ? 0 : nextBulge })
  }
  const sagittaCm = Math.round((length * Math.abs(bulge)) / 2 * 100)

  return (
    <PanelWrapper
      icon="/icons/wall.png"
      onClose={handleClose}
      title={node.name || 'Wall'}
      width={280}
    >
      <PanelSection title="Curve">
        <SliderControl
          label="Sweep"
          max={179}
          min={-179}
          onChange={setSweepDeg}
          precision={0}
          step={1}
          unit="°"
          value={sweepDeg}
        />
        <div className="flex items-center justify-between gap-2 px-1 pt-1 text-[11px]">
          <span className="text-zinc-400">
            Peak <span className="font-mono text-zinc-200">{sagittaCm} cm</span>
          </span>
          <div className="flex gap-1.5">
            <button
              type="button"
              className="rounded border border-zinc-600 bg-zinc-700/40 px-2 py-0.5 text-zinc-200 hover:bg-zinc-700"
              onClick={() => setSweepDeg(0)}
            >
              Straight
            </button>
            <button
              type="button"
              className="rounded border border-zinc-600 bg-zinc-700/40 px-2 py-0.5 text-zinc-200 hover:bg-zinc-700"
              onClick={() => setSweepDeg(-sweepDeg)}
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
    </PanelWrapper>
  )
}
