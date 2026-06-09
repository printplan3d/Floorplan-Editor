'use client'

import { type AnyNode, type AnyNodeId, DEFAULT_WALL_HEIGHT, type DoorNode, useScene, type WallNode } from '@pascal-app/core'
import { useViewer } from '@pascal-app/viewer'
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
            <div className="mx-1 mt-1 flex items-center gap-1 rounded-md bg-amber-500/15 px-2 py-1">
              <svg className="h-3 w-3 shrink-0 text-amber-400" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z" />
              </svg>
              <span className="text-[10px] text-amber-300">Exceeds wall height ({wallHeight}m)</span>
            </div>
          )}
        </div>
      </PanelSection>

      <PanelSection title="Swing">
        <div className="flex flex-col gap-2 px-1 pb-1">
          <div className="space-y-1">
            <span className="font-medium text-[10px] text-muted-foreground/80 uppercase tracking-wider">
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
            <span className="font-medium text-[10px] text-muted-foreground/80 uppercase tracking-wider">
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

      <PanelSection title="Actions">
        <ActionGroup>
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
