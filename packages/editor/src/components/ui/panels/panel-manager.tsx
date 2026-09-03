'use client'

import { type AnyNodeId, useScene } from '@ritn3d/core'
import { useViewer } from '@ritn3d/viewer'
import useEditor from '../../../store/use-editor'
import { CeilingPanel } from './ceiling-panel'
import { DoorPanel } from './door-panel'
import { FinishesPanel } from './finishes-panel'
import { ItemPanel } from './item-panel'
import { MaterialPickerDrawer } from './material-picker-drawer'
import { ReferencePanel } from './reference-panel'
import { RoofPanel } from './roof-panel'
import { RoofSegmentPanel } from './roof-segment-panel'
import { SlabPanel } from './slab-panel'
import { WallPanel } from './wall-panel'
import { WindowPanel } from './window-panel'
import { ZonePanel } from './zone-panel'

export function PanelManager() {
  const selectedIds = useViewer((s) => s.selection.selectedIds)
  const zoneId = useViewer((s) => s.selection.zoneId)
  const selectedReferenceId = useEditor((s) => s.selectedReferenceId)
  const isFinishesPanelOpen = useEditor((s) => s.isFinishesPanelOpen)
  const nodes = useScene((s) => s.nodes)

  const pickerDrawer = <MaterialPickerDrawer />

  // 2026-09-02: Finishes panel is toggled independently of node
  // selection — it lives on top of whichever selection panel is up.
  // Rendered first so the picker drawer sits alongside it.
  const finishesLayer = isFinishesPanelOpen
    ? (<>
        <FinishesPanel />
        {pickerDrawer}
      </>)
    : null

  // Show reference panel if a reference is selected
  if (selectedReferenceId) {
    return <>{finishesLayer}<ReferencePanel /></>
  }

  // 2026-07-27: zones are selected via `selection.zoneId` (not
  // selectedIds). Route to ZonePanel when a zone is selected so
  // auto-detected rooms surface the room-type chip picker.
  if (zoneId) {
    const node = nodes[zoneId as AnyNodeId]
    if (node?.type === 'zone') {
      return <>{finishesLayer}<ZonePanel /></>
    }
  }

  // Show appropriate panel based on selected node type
  if (selectedIds.length === 1) {
    const selectedNode = selectedIds[0]
    const node = nodes[selectedNode as AnyNodeId]
    if (node) {
      switch (node.type) {
        case 'item':
          return <>{finishesLayer}<ItemPanel /></>
        case 'roof':
          return <>{finishesLayer}<RoofPanel /></>
        case 'roof-segment':
          return <>{finishesLayer}<RoofSegmentPanel /></>
        case 'slab':
          return <>{finishesLayer}<SlabPanel /></>
        case 'ceiling':
          return <>{finishesLayer}<CeilingPanel /></>
        case 'wall':
          return <>{finishesLayer}<WallPanel /></>
        case 'door':
          return <>{finishesLayer}<DoorPanel /></>
        case 'window':
          return <>{finishesLayer}<WindowPanel /></>
        case 'zone':
          return <>{finishesLayer}<ZonePanel /></>
      }
    }
  }

  return finishesLayer
}
