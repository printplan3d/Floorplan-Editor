'use client'

import { type AnyNode, type AnyNodeId, DEFAULT_WALL_HEIGHT, type DoorNode, useScene, type WallNode } from '@ritn3d/core'
import { useViewer } from '@ritn3d/viewer'
import { Trash2 } from 'lucide-react'
import { useCallback, useMemo } from 'react'
import { sfxEmitter } from '../../../lib/sfx-bus'
import { ActionButton, ActionGroup } from '../controls/action-button'
import { PanelSection } from '../controls/panel-section'
import { SegmentedControl } from '../controls/segmented-control'
import { SliderControl } from '../controls/slider-control'
import { PanelWrapper } from './panel-wrapper'

export function DoorPanel() {
  const selectedIds = useViewer((s) => s.selection.selectedIds)
  const setSelection = useViewer((s) => s.setSelection)
  const nodes = useScene((s) => s.nodes)
  const updateNode = useScene((s) => s.updateNode)
  const deleteNode = useScene((s) => s.deleteNode)

  const selectedId = selectedIds[0]
  const node = selectedId ? (nodes[selectedId as AnyNode['id']] as DoorNode | undefined) : undefined

  // Get parent wall height
  const parentWall = useMemo(() => {
    if (!node?.parentId) return null
    const parent = nodes[node.parentId as AnyNode['id']]
    return parent?.type === 'wall' ? (parent as WallNode) : null
  }, [node?.parentId, nodes])
  const wallHeight = parentWall?.height ?? DEFAULT_WALL_HEIGHT
  const isOverHeight = (node?.height ?? 0) > wallHeight
  // Ritn3D 2026-06-18: wall length so the Position slider can clamp the door
  // inside the wall (door.position[0] is distance-along-wall in metres).
  const wallLength = useMemo(() => {
    if (!parentWall) return 0
    return Math.hypot(
      parentWall.end[0] - parentWall.start[0],
      parentWall.end[1] - parentWall.start[1],
    )
  }, [parentWall])

  const handleUpdate = useCallback(
    (updates: Partial<DoorNode>) => {
      if (!selectedId) return
      updateNode(selectedId as AnyNode['id'], updates)
      useScene.getState().dirtyNodes.add(selectedId as AnyNodeId)
    },
    [selectedId, updateNode],
  )

  const handleClose = useCallback(() => {
    setSelection({ selectedIds: [] })
  }, [setSelection])

  const handleDelete = useCallback(() => {
    if (!(selectedId && node)) return
    sfxEmitter.emit('sfx:item-delete')
    deleteNode(selectedId as AnyNode['id'])
    if (node.parentId) useScene.getState().dirtyNodes.add(node.parentId as AnyNodeId)
    setSelection({ selectedIds: [] })
  }, [selectedId, node, deleteNode, setSelection])

  if (!node || node.type !== 'door' || selectedIds.length !== 1) return null

  return (
    <PanelWrapper
      icon="/icons/door.png"
      onClose={handleClose}
      title="Door"
      width={260}
    >
      {wallLength > 0 && (
        <PanelSection title="Position">
          <SliderControl
            label="From start"
            max={Math.max(0, wallLength - node.width / 2)}
            min={node.width / 2}
            onChange={(v) => {
              const clamped = Math.max(node.width / 2, Math.min(v, wallLength - node.width / 2))
              handleUpdate({ position: [clamped, node.position[1], node.position[2]] })
            }}
            precision={2}
            step={0.01}
            unit="m"
            value={Math.round(node.position[0] * 100) / 100}
          />
          <SliderControl
            label="From end"
            max={Math.max(0, wallLength - node.width / 2)}
            min={node.width / 2}
            onChange={(v) => {
              const posFromStart = wallLength - v
              const clamped = Math.max(node.width / 2, Math.min(posFromStart, wallLength - node.width / 2))
              handleUpdate({ position: [clamped, node.position[1], node.position[2]] })
            }}
            precision={2}
            step={0.01}
            unit="m"
            value={Math.round((wallLength - node.position[0]) * 100) / 100}
          />
        </PanelSection>
      )}

      {/* Ritn3D 2026-07-16 (Tier 2): Style picker. Values map 1:1 to
          DoorStyle enum; labels are user-facing. 'Normal' = pedestrian
          wooden slab door (renamed for clarity; enum stays as
          'pedestrian' for scene backwards-compat). */}
      <PanelSection title="Style">
        <SegmentedControl
          onChange={(v) => handleUpdate({ style: v })}
          options={[
            { label: 'Normal', value: 'pedestrian' as const },
            { label: 'Double', value: 'double' as const },
            { label: 'Glass', value: 'glass' as const },
            { label: 'Patio', value: 'patio' as const },
            { label: 'Sliding', value: 'sliding' as const },
            { label: 'Garage', value: 'garage' as const },
          ]}
          value={node.style ?? 'pedestrian'}
        />
      </PanelSection>

      <PanelSection title="Dimensions">
        <SliderControl
          label="Width"
          max={3}
          min={0.5}
          onChange={(v) => handleUpdate({ width: v })}
          precision={2}
          step={0.05}
          unit="m"
          value={Math.round(node.width * 100) / 100}
        />
        <div>
          <SliderControl
            label="Height"
            max={wallHeight}
            min={1.0}
            onChange={(v) => {
              const clamped = Math.min(v, wallHeight)
              handleUpdate({ height: clamped, position: [node.position[0], clamped / 2, node.position[2]] })
            }}
            precision={2}
            step={0.05}
            unit="m"
            value={Math.round(node.height * 100) / 100}
          />
          {isOverHeight && (
            <div className="mx-1 mt-1 flex items-center gap-1 rounded-md border border-amber-600/20 bg-amber-500/10 px-2 py-1">
              <svg className="h-3 w-3 shrink-0 text-amber-600" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z" />
              </svg>
              <span className="text-[10px] font-medium text-amber-700">Exceeds wall height ({wallHeight}m)</span>
            </div>
          )}
        </div>
      </PanelSection>

      <PanelSection title="Swing">
        <div className="flex flex-col gap-2 px-1 pb-1">
          <div className="space-y-1">
            <span className="font-mono text-[10px] text-ink/50 uppercase tracking-[0.06em]">
              Hinges
            </span>
            <SegmentedControl
              onChange={(v) => handleUpdate({ hingesSide: v })}
              options={[
                { label: 'Left', value: 'left' },
                { label: 'Right', value: 'right' },
              ]}
              value={node.hingesSide}
            />
          </div>
          <div className="space-y-1">
            <span className="font-mono text-[10px] text-ink/50 uppercase tracking-[0.06em]">
              Direction
            </span>
            <SegmentedControl
              onChange={(v) => handleUpdate({ swingDirection: v })}
              options={[
                { label: 'Inward', value: 'inward' },
                { label: 'Outward', value: 'outward' },
              ]}
              value={node.swingDirection}
            />
          </div>
        </div>
      </PanelSection>

      {/* Ritn3D 2026-07-19: Handle + Threshold controls removed from the
          panel per user request for the minimal launch. Schema still
          carries the fields (defaults: handle=true, threshold=true) and
          the Blender pipeline still renders both. Controls will be
          reintroduced when door variety expands beyond normal/glass/patio. */}

      <PanelSection title="Actions">
        <ActionGroup>
          <ActionButton
            className="hover:bg-red-50 hover:border-red-200 hover:text-red-700"
            icon={<Trash2 className="h-3.5 w-3.5 text-red-600" />}
            label="Delete"
            onClick={handleDelete}
          />
        </ActionGroup>
      </PanelSection>
    </PanelWrapper>
  )
}
