'use client'

import {
  type AnyNode,
  type AnyNodeId,
  type RoofSegmentNode,
  RoofSegmentNode as RoofSegmentNodeSchema,
  type RoofType,
  useScene,
} from '@ritn3d/core'
import { useViewer } from '@ritn3d/viewer'
import { Copy, Move, Trash2 } from 'lucide-react'
import { useCallback, useEffect } from 'react'
import { sfxEmitter } from '../../../lib/sfx-bus'
import useEditor from '../../../store/use-editor'
import { ActionButton, ActionGroup } from '../controls/action-button'
import { MetricControl } from '../controls/metric-control'
import { PanelSection } from '../controls/panel-section'
import { SegmentedControl } from '../controls/segmented-control'
import { SliderControl } from '../controls/slider-control'
import { PanelWrapper } from './panel-wrapper'

const ROOF_TYPE_OPTIONS: { label: string; value: RoofType }[] = [
  { label: 'Hip', value: 'hip' },
  { label: 'Gable', value: 'gable' },
  { label: 'Shed', value: 'shed' },
  { label: 'Flat', value: 'flat' },
]

// Gambrel / Dutch / Mansard are DEFERRED in blender_pipeline_dev/roof/scene.py
// — the backend raises NotImplementedError on those kinds, so the pipeline
// silently skips the roof and the user gets no roof at all. Hidden from the
// picker until the geometry code lands. Values still exist on the schema
// so plans that already carry one keep parsing.

// Ridge direction — explicit user choice, never inferred from width/depth
// after this control is touched. "Auto" keeps the width>=depth heuristic
// for anything the user hasn't set.
const RIDGE_AXIS_OPTIONS: { label: string; value: 'auto' | 'east-west' | 'north-south' }[] = [
  { label: 'Auto', value: 'auto' },
  { label: '↕ N–S', value: 'north-south' },
  { label: '↔ E–W', value: 'east-west' },
]

export function RoofSegmentPanel() {
  const selectedIds = useViewer((s) => s.selection.selectedIds)
  const setSelection = useViewer((s) => s.setSelection)
  const nodes = useScene((s) => s.nodes)
  const updateNode = useScene((s) => s.updateNode)
  const setMovingNode = useEditor((s) => s.setMovingNode)

  const selectedId = selectedIds[0]
  const node = selectedId
    ? (nodes[selectedId as AnyNode['id']] as RoofSegmentNode | undefined)
    : undefined

  const handleUpdate = useCallback(
    (updates: Partial<RoofSegmentNode>) => {
      if (!selectedId) return
      updateNode(selectedId as AnyNode['id'], updates)
    },
    [selectedId, updateNode],
  )

  // Auto-migrate roof segments that were saved with a deferred kind
  // (gambrel / dutch / mansard) — the backend rejects those and drops
  // the whole roof silently. Force to 'gable' the first time such a
  // segment is opened, so the user's existing plans don't render an
  // invisible roof forever.
  useEffect(() => {
    if (!node || node.type !== 'roof-segment') return
    const kind = node.roofType
    if (kind === 'gambrel' || kind === 'dutch' || kind === 'mansard') {
      updateNode(node.id as AnyNode['id'], { roofType: 'gable' })
    }
  }, [node?.id, node?.roofType, updateNode])

  const handleClose = useCallback(() => {
    setSelection({ selectedIds: [] })
  }, [setSelection])

  const handleBack = useCallback(() => {
    if (node?.parentId) {
      setSelection({ selectedIds: [node.parentId] })
    }
  }, [node?.parentId, setSelection])

  const handleDuplicate = useCallback(() => {
    if (!node?.parentId) return
    sfxEmitter.emit('sfx:item-pick')

    let duplicateInfo = structuredClone(node) as any
    delete duplicateInfo.id
    duplicateInfo.metadata = { ...duplicateInfo.metadata, isNew: true }
    // Offset slightly so it's visible
    duplicateInfo.position = [
      duplicateInfo.position[0] + 1,
      duplicateInfo.position[1],
      duplicateInfo.position[2] + 1,
    ]

    try {
      const duplicate = RoofSegmentNodeSchema.parse(duplicateInfo)
      useScene.getState().createNode(duplicate, duplicate.parentId as AnyNodeId)
      setSelection({ selectedIds: [] })
      setMovingNode(duplicate)
    } catch (e) {
      console.error('Failed to duplicate roof segment', e)
    }
  }, [node, setSelection, setMovingNode])

  const handleMove = useCallback(() => {
    if (node) {
      sfxEmitter.emit('sfx:item-pick')
      setMovingNode(node)
      setSelection({ selectedIds: [] })
    }
  }, [node, setMovingNode, setSelection])

  const handleDelete = useCallback(() => {
    if (!(selectedId && node)) return
    sfxEmitter.emit('sfx:item-delete')
    const parentId = node.parentId
    useScene.getState().deleteNode(selectedId as AnyNodeId)
    if (parentId) {
      useScene.getState().dirtyNodes.add(parentId as AnyNodeId)
      setSelection({ selectedIds: [parentId] })
    } else {
      setSelection({ selectedIds: [] })
    }
  }, [selectedId, node, setSelection])

  if (!node || node.type !== 'roof-segment' || selectedIds.length !== 1) return null

  return (
    <PanelWrapper
      icon="/icons/roof.png"
      onBack={handleBack}
      onClose={handleClose}
      title={node.name || 'Roof Segment'}
      width={300}
    >
      <PanelSection title="Roof Type">
        <SegmentedControl
          onChange={(v) => handleUpdate({ roofType: v })}
          options={ROOF_TYPE_OPTIONS}
          value={
            (['hip', 'gable', 'shed', 'flat'] as RoofType[]).includes(node.roofType)
              ? node.roofType
              : 'gable'
          }
        />
        <div className="px-1 pt-1 text-[10px] leading-tight text-neutral-500">
          Gambrel, Dutch and Mansard are coming soon.
        </div>
      </PanelSection>

      <PanelSection title="Ridge Direction">
        <SegmentedControl
          onChange={(v) => handleUpdate({ ridgeAxis: v })}
          options={RIDGE_AXIS_OPTIONS}
          value={node.ridgeAxis ?? 'auto'}
        />
      </PanelSection>

      <PanelSection title="Footprint">
        <SliderControl
          label="Width"
          max={25}
          min={0.5}
          onChange={(v) => handleUpdate({ width: v })}
          precision={2}
          step={0.5}
          unit="m"
          value={Math.round(node.width * 100) / 100}
        />
        <SliderControl
          label="Depth"
          max={25}
          min={0.5}
          onChange={(v) => handleUpdate({ depth: v })}
          precision={2}
          step={0.5}
          unit="m"
          value={Math.round(node.depth * 100) / 100}
        />
      </PanelSection>

      <PanelSection title="Heights">
        <SliderControl
          label="Wall"
          max={5}
          min={0}
          onChange={(v) => handleUpdate({ wallHeight: v })}
          precision={2}
          step={0.1}
          unit="m"
          value={Math.round(node.wallHeight * 100) / 100}
        />
        <SliderControl
          label="Roof"
          max={15}
          min={0}
          onChange={(v) => handleUpdate({ roofHeight: v })}
          precision={2}
          step={0.1}
          unit="m"
          value={Math.round(node.roofHeight * 100) / 100}
        />
      </PanelSection>

      {/* Structure — only Overhang is wired into blender_pipeline_dev/roof
          today. Wall Thick / Deck Thick / Shingle Thick sit on the schema
          (so plans that carry them keep round-tripping) but the multi-mass
          solids builder ignores them, so hiding them from the panel until
          they're implemented avoids the user tuning a slider that changes
          nothing in the render. */}
      <PanelSection title="Structure">
        <SliderControl
          label="Overhang"
          max={1}
          min={0}
          onChange={(v) => handleUpdate({ overhang: v })}
          precision={2}
          step={0.05}
          unit="m"
          value={Math.round(node.overhang * 100) / 100}
        />
      </PanelSection>

      <PanelSection title="Position">
        <MetricControl
          label="X"
          max={50}
          min={-50}
          onChange={(v) => {
            const pos = [...node.position] as [number, number, number]
            pos[0] = v
            handleUpdate({ position: pos })
          }}
          precision={2}
          step={0.05}
          unit="m"
          value={Math.round(node.position[0] * 100) / 100}
        />
        <MetricControl
          label="Y"
          max={50}
          min={-50}
          onChange={(v) => {
            const pos = [...node.position] as [number, number, number]
            pos[1] = v
            handleUpdate({ position: pos })
          }}
          precision={2}
          step={0.05}
          unit="m"
          value={Math.round(node.position[1] * 100) / 100}
        />
        <MetricControl
          label="Z"
          max={50}
          min={-50}
          onChange={(v) => {
            const pos = [...node.position] as [number, number, number]
            pos[2] = v
            handleUpdate({ position: pos })
          }}
          precision={2}
          step={0.05}
          unit="m"
          value={Math.round(node.position[2] * 100) / 100}
        />
        <SliderControl
          label="Rotation"
          max={180}
          min={-180}
          onChange={(degrees) => {
            handleUpdate({ rotation: (degrees * Math.PI) / 180 })
          }}
          precision={0}
          step={1}
          unit="°"
          value={Math.round((node.rotation * 180) / Math.PI)}
        />
        <div className="flex gap-1.5 px-1 pt-2 pb-1">
          <ActionButton
            label="-45°"
            onClick={() => {
              sfxEmitter.emit('sfx:item-rotate')
              handleUpdate({ rotation: node.rotation - Math.PI / 4 })
            }}
          />
          <ActionButton
            label="+45°"
            onClick={() => {
              sfxEmitter.emit('sfx:item-rotate')
              handleUpdate({ rotation: node.rotation + Math.PI / 4 })
            }}
          />
        </div>
      </PanelSection>

      <PanelSection title="Actions">
        <ActionGroup>
          <ActionButton icon={<Move className="h-3.5 w-3.5" />} label="Move" onClick={handleMove} />
          <ActionButton
            icon={<Copy className="h-3.5 w-3.5" />}
            label="Duplicate"
            onClick={handleDuplicate}
          />
          <ActionButton
            className="hover:bg-red-500/20"
            icon={<Trash2 className="h-3.5 w-3.5 text-red-400" />}
            label="Delete"
            onClick={handleDelete}
          />
        </ActionGroup>
      </PanelSection>
    </PanelWrapper>
  )
}
