'use client'

import {
  type AnyNode,
  type AnyNodeId,
  DEFAULT_WALL_HEIGHT,
  type DoorNode,
  type DoorStyle,
  useScene,
  type WallNode,
} from '@ritn3d/core'
import { useViewer } from '@ritn3d/viewer'
import { Trash2 } from 'lucide-react'
import { useCallback, useMemo } from 'react'
import { sfxEmitter } from '../../../lib/sfx-bus'
import { ActionButton, ActionGroup } from '../controls/action-button'
import { PanelSection } from '../controls/panel-section'
import { SegmentedControl } from '../controls/segmented-control'
import { SliderControl } from '../controls/slider-control'
import { PanelWrapper } from './panel-wrapper'

/* Values map 1:1 to the DoorStyle enum; labels are user-facing. 'Normal' is
   'pedestrian' in the schema — renamed for clarity, enum kept for scene
   backwards-compat. Hints say how each one READS ON THE PLAN, because that is
   the feedback the user gets after choosing. */
const DOOR_STYLES: { value: DoorStyle; label: string; hint: string }[] = [
  { value: 'pedestrian', label: 'Normal', hint: 'One leaf with a swing arc.' },
  { value: 'double', label: 'Double', hint: 'Two leaves hinged at opposite ends.' },
  { value: 'glass', label: 'Glass', hint: 'One leaf, tinted, with a swing arc.' },
  { value: 'patio', label: 'Patio', hint: 'Two sliding panels, no swing.' },
  { value: 'sliding', label: 'Sliding', hint: 'One panel that slides aside, no swing.' },
  { value: 'garage', label: 'Garage', hint: 'Sectional — lifts, so no leaf or arc.' },
]

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
          {/* Ritn3D 2026-07-24: single "Position on wall" slider (iOS
              parity). Prior double slider (From start + From end) was
              redundant and confusing -- one axis is enough. */}
          <SliderControl
            label="Position on wall"
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
        </PanelSection>
      )}

      {/* Ritn3D 2026-07-16 (Tier 2): Style picker. Values map 1:1 to
          DoorStyle enum; labels are user-facing. 'Normal' = pedestrian
          wooden slab door (renamed for clarity; enum stays as
          'pedestrian' for scene backwards-compat). */}
      {/* Ritn3D 2026-08-07: a 2x3 button grid, not a SegmentedControl.
          Six options in one horizontal strip squeezed every label to a few
          overlapping pixels — "Normal|Double|Glass|Patio|Sliding|Garage" ran
          together and none of them was readable or reliably tappable.

          Same shape as the stair variant picker so the two panels feel like
          one editor. */}
      <PanelSection title="Style">
        <div className="grid grid-cols-3 gap-1 px-1 pb-1">
          {DOOR_STYLES.map((opt) => {
            const isActive = (node.style ?? 'pedestrian') === opt.value
            return (
              <button
                className={`rounded-md border px-2 py-2 text-[11px] font-medium transition-colors ${
                  isActive
                    ? 'border-amber-500/50 bg-amber-500/20 text-amber-100'
                    : 'border-border/30 text-muted-foreground hover:bg-accent/40 hover:text-foreground'
                }`}
                key={opt.value}
                onClick={() => handleUpdate({ style: opt.value })}
                title={opt.hint}
                type="button"
              >
                {opt.label}
              </button>
            )
          })}
        </div>
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
