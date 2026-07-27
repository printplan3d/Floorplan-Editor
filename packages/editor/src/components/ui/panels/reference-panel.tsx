'use client'

import { type AnyNode, emitter, type GuideNode, useScene } from '@ritn3d/core'
import { Box, Image as ImageIcon } from 'lucide-react'
import { useCallback } from 'react'
import useEditor from '../../../store/use-editor'
import { ActionButton, ActionGroup } from '../controls/action-button'
import { MetricControl } from '../controls/metric-control'
import { PanelSection } from '../controls/panel-section'
import { SliderControl } from '../controls/slider-control'
import { PanelWrapper } from './panel-wrapper'

// Ritn3D cleanup 2026-06-10: ScanNode removed; only GuideNode remains as a
// reference asset (image/PDF overlay for tracing). `isScan` branches kept
// as `false` literals for now so the diff stays minimal — they tree-shake.
type ReferenceNode = GuideNode

export function ReferencePanel() {
  const selectedReferenceId = useEditor((s) => s.selectedReferenceId)
  const setSelectedReferenceId = useEditor((s) => s.setSelectedReferenceId)
  const nodes = useScene((s) => s.nodes)
  const updateNode = useScene((s) => s.updateNode)

  const node = selectedReferenceId
    ? (nodes[selectedReferenceId as AnyNode['id']] as ReferenceNode | undefined)
    : undefined

  const handleUpdate = useCallback(
    (updates: Partial<ReferenceNode>) => {
      if (!selectedReferenceId) return
      updateNode(selectedReferenceId as AnyNode['id'], updates)
    },
    [selectedReferenceId, updateNode],
  )

  const handleClose = useCallback(() => {
    setSelectedReferenceId(null)
  }, [setSelectedReferenceId])

  if (!node || node.type !== 'guide') return null

  // Ritn3D cleanup 2026-06-10: scans removed. `isScan` always false now —
  // kept as a literal so the conditional rendering below works unchanged
  // and a future ScanNode re-introduction is a one-line tweak. Tree-shakes
  // the unused branches.
  const isScan = false

  return (
    <PanelWrapper
      icon={isScan ? undefined : undefined}
      onClose={handleClose}
      title={node.name || (isScan ? '3D Scan' : 'Guide Image')}
      width={300}
    >
      {/* Scale calibration trigger — emits the same event auto-fired on
          upload. Useful when the user dismissed the initial banner or wants
          to redo. */}
      {!isScan && (
        <PanelSection title="Scale">
          <button
            type="button"
            onClick={() => {
              if (selectedReferenceId) {
                // 2026-07-28: emit calibrate event, THEN close the panel
                // and deselect the reference. Two reasons:
                //   1. Selected guide renders large SVG handles that
                //      swallow the user's 2-point clicks. Deselecting
                //      leaves the image visible but non-interactive.
                //   2. Panel takes up sidebar width -- closing gives
                //      the user the full canvas to click on their
                //      reference distance.
                const gid = selectedReferenceId
                setSelectedReferenceId(null)
                emitter.emit(
                  'floorplan:calibrate-scale' as any,
                  { guideId: gid },
                )
              }
            }}
            className="flex w-full items-center justify-center gap-2 rounded-md border-2 border-amber-500 bg-amber-500 px-3 py-2.5 font-semibold text-black text-[12.5px] uppercase tracking-[0.08em] shadow-[0_0_0_3px_rgba(245,158,11,0.25)] transition-all hover:bg-amber-400 hover:shadow-[0_0_0_5px_rgba(245,158,11,0.3)]"
          >
            <span className="inline-block w-1.5 h-1.5 rounded-full bg-black animate-pulse"/>
            Set scale — click 2 points
          </button>
        </PanelSection>
      )}

      <PanelSection title="Position">
        <SliderControl
          label={
            <>
              X<sub className="ml-[1px] text-[11px] opacity-70">pos</sub>
            </>
          }
          max={50}
          min={-50}
          onChange={(value) => {
            const pos = [...node.position] as [number, number, number]
            pos[0] = value
            handleUpdate({ position: pos })
          }}
          precision={2}
          step={0.1}
          unit="m"
          value={Math.round(node.position[0] * 100) / 100}
        />
        <SliderControl
          label={
            <>
              Y<sub className="ml-[1px] text-[11px] opacity-70">pos</sub>
            </>
          }
          max={50}
          min={-50}
          onChange={(value) => {
            const pos = [...node.position] as [number, number, number]
            pos[1] = value
            handleUpdate({ position: pos })
          }}
          precision={2}
          step={0.1}
          unit="m"
          value={Math.round(node.position[1] * 100) / 100}
        />
        <SliderControl
          label={
            <>
              Z<sub className="ml-[1px] text-[11px] opacity-70">pos</sub>
            </>
          }
          max={50}
          min={-50}
          onChange={(value) => {
            const pos = [...node.position] as [number, number, number]
            pos[2] = value
            handleUpdate({ position: pos })
          }}
          precision={2}
          step={0.1}
          unit="m"
          value={Math.round(node.position[2] * 100) / 100}
        />
      </PanelSection>

      <PanelSection title="Rotation">
        <SliderControl
          label={
            <>
              Y<sub className="ml-[1px] text-[11px] opacity-70">rot</sub>
            </>
          }
          max={180}
          min={-180}
          onChange={(degrees) => {
            const radians = (degrees * Math.PI) / 180
            handleUpdate({
              rotation: [node.rotation[0], radians, node.rotation[2]],
            })
          }}
          precision={0}
          step={1}
          unit="°"
          value={Math.round((node.rotation[1] * 180) / Math.PI)}
        />
        <div className="flex gap-1.5 px-1 pt-2 pb-1">
          <ActionButton
            label="-45°"
            onClick={() =>
              handleUpdate({
                rotation: [node.rotation[0], node.rotation[1] - Math.PI / 4, node.rotation[2]],
              })
            }
          />
          <ActionButton
            label="+45°"
            onClick={() =>
              handleUpdate({
                rotation: [node.rotation[0], node.rotation[1] + Math.PI / 4, node.rotation[2]],
              })
            }
          />
        </div>
      </PanelSection>

      <PanelSection title="Scale & Opacity">
        <SliderControl
          label={
            <>
              XYZ<sub className="ml-[1px] text-[11px] opacity-70">scale</sub>
            </>
          }
          max={10}
          min={0.01}
          onChange={(value) => {
            if (value > 0) {
              handleUpdate({ scale: value })
            }
          }}
          precision={2}
          step={0.1}
          value={Math.round(node.scale * 100) / 100}
        />

        <SliderControl
          label="Opacity"
          max={100}
          min={0}
          onChange={(v) => handleUpdate({ opacity: v })}
          precision={0}
          step={1}
          unit="%"
          value={node.opacity}
        />
      </PanelSection>
    </PanelWrapper>
  )
}
