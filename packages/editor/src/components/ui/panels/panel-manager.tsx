'use client'

import { type AnyNodeId, useScene } from '@ritn3d/core'
import { useViewer } from '@ritn3d/viewer'
import useEditor from '../../../store/use-editor'
import { CeilingPanel } from './ceiling-panel'
import { DoorPanel } from './door-panel'
import { ItemPanel } from './item-panel'
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
  const nodes = useScene((s) => s.nodes)

  // Show reference panel if a reference is selected
  if (selectedReferenceId) {
    return <ReferencePanel />
  }

  // 2026-07-27: zones are selected via `selection.zoneId` (not
  // selectedIds). Route to ZonePanel when a zone is selected so
  // auto-detected rooms surface the room-type chip picker.
  if (zoneId) {
    const node = nodes[zoneId as AnyNodeId]
    if (node?.type === 'zone') {
      return <ZonePanel />
    }
  }

  // Show appropriate panel based on selected node type
  if (selectedIds.length === 1) {
    const selectedNode = selectedIds[0]
    const node = nodes[selectedNode as AnyNodeId]
    if (node) {
      switch (node.type) {
        case 'item':
          return <ItemPanel />
        case 'roof':
          return <RoofPanel />
        case 'roof-segment':
          return <RoofSegmentPanel />
        case 'slab':
          return <SlabPanel />
        case 'ceiling':
          return <CeilingPanel />
        case 'wall':
          return <WallPanel />
        case 'door':
          return <DoorPanel />
        case 'window':
          return <WindowPanel />
        case 'zone':
          return <ZonePanel />
      }
    }
  }

  return null
}
