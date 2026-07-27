'use client'

/*
  Ritn3D 2026-07-24: Zone panel with iOS-parity room type chip picker.
  Matches iOS FloorPlanEditor Inspectors.swift zone section: 12+ typed
  room chips with icon glyphs, plus area readout in m² and sq ft.
*/

import { type AnyNode, type AnyNodeId, useScene, type ZoneNode } from '@ritn3d/core'

// Local type mirror of core's RoomType enum -- avoids a cross-package
// type re-export quirk with Zod schemas. Values MUST stay in sync with
// packages/core/src/schema/nodes/zone.ts.
type RoomType =
  | 'living' | 'kitchen' | 'dining' | 'bedroom' | 'bathroom'
  | 'office' | 'hallway' | 'entryway' | 'closet' | 'laundry'
  | 'garage' | 'outdoor' | 'other'
import { useViewer } from '@ritn3d/viewer'
import { useCallback } from 'react'
import { cn } from '../../../lib/utils'
import { PanelSection } from '../controls/panel-section'
import { PanelWrapper } from './panel-wrapper'

// SF-symbol-ish room glyphs. Kept lightweight (single-path where possible)
// to avoid dependency on a new icon set.
function RoomIcon({ type, size = 16 }: { type: RoomType; size?: number }) {
  const s = size
  const stroke = 'currentColor'
  switch (type) {
    case 'living':
      return (
        <svg width={s} height={s} viewBox="0 0 24 24" fill="none" aria-hidden>
          <path d="M4 12 V18 M20 12 V18 M4 14 H20 M6 14 V10 H18 V14 M8 10 V8 H16 V10" stroke={stroke} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
        </svg>
      )
    case 'kitchen':
      return (
        <svg width={s} height={s} viewBox="0 0 24 24" fill="none" aria-hidden>
          <rect x="4" y="6" width="16" height="14" rx="1.5" stroke={stroke} strokeWidth="1.5"/>
          <path d="M4 11 H20 M9 6 V10 M15 6 V10" stroke={stroke} strokeWidth="1.5" strokeLinecap="round"/>
        </svg>
      )
    case 'dining':
      return (
        <svg width={s} height={s} viewBox="0 0 24 24" fill="none" aria-hidden>
          <path d="M6 5 V11 M18 5 V11 M4 11 H20 M8 11 V19 M16 11 V19" stroke={stroke} strokeWidth="1.5" strokeLinecap="round"/>
        </svg>
      )
    case 'bedroom':
      return (
        <svg width={s} height={s} viewBox="0 0 24 24" fill="none" aria-hidden>
          <path d="M3 18 V12 A2 2 0 0 1 5 10 H19 A2 2 0 0 1 21 12 V18 M3 18 H21 M3 18 V20 M21 18 V20 M7 10 V6 H12 V10" stroke={stroke} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
        </svg>
      )
    case 'bathroom':
      return (
        <svg width={s} height={s} viewBox="0 0 24 24" fill="none" aria-hidden>
          <path d="M4 12 H20 M5 12 V16 A3 3 0 0 0 8 19 H16 A3 3 0 0 0 19 16 V12 M8 12 V5 A2 2 0 0 1 10 3 H10.5 A2 2 0 0 1 12.5 5 V6" stroke={stroke} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
        </svg>
      )
    case 'office':
      return (
        <svg width={s} height={s} viewBox="0 0 24 24" fill="none" aria-hidden>
          <rect x="3" y="6" width="18" height="10" rx="1" stroke={stroke} strokeWidth="1.5"/>
          <path d="M3 12 H21 M12 16 V20 M8 20 H16" stroke={stroke} strokeWidth="1.5" strokeLinecap="round"/>
        </svg>
      )
    case 'hallway':
      return (
        <svg width={s} height={s} viewBox="0 0 24 24" fill="none" aria-hidden>
          <path d="M8 3 V21 M16 3 V21 M8 12 H16" stroke={stroke} strokeWidth="1.5" strokeLinecap="round"/>
        </svg>
      )
    case 'entryway':
      return (
        <svg width={s} height={s} viewBox="0 0 24 24" fill="none" aria-hidden>
          <path d="M5 21 V6 A2 2 0 0 1 7 4 H17 A2 2 0 0 1 19 6 V21 M12 12 V13" stroke={stroke} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
        </svg>
      )
    case 'closet':
      return (
        <svg width={s} height={s} viewBox="0 0 24 24" fill="none" aria-hidden>
          <rect x="5" y="3" width="14" height="18" stroke={stroke} strokeWidth="1.5"/>
          <path d="M12 3 V21" stroke={stroke} strokeWidth="1.5"/>
          <circle cx="10" cy="12" r="0.6" fill={stroke}/>
          <circle cx="14" cy="12" r="0.6" fill={stroke}/>
        </svg>
      )
    case 'laundry':
      return (
        <svg width={s} height={s} viewBox="0 0 24 24" fill="none" aria-hidden>
          <rect x="4" y="4" width="16" height="16" rx="1.5" stroke={stroke} strokeWidth="1.5"/>
          <circle cx="12" cy="13" r="4" stroke={stroke} strokeWidth="1.5"/>
          <path d="M7 7 H9 M15 7 H17" stroke={stroke} strokeWidth="1.5" strokeLinecap="round"/>
        </svg>
      )
    case 'garage':
      return (
        <svg width={s} height={s} viewBox="0 0 24 24" fill="none" aria-hidden>
          <path d="M3 20 V10 L12 4 L21 10 V20 M3 20 H21 M6 20 V13 H18 V20 M6 16 H18" stroke={stroke} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
        </svg>
      )
    case 'outdoor':
      return (
        <svg width={s} height={s} viewBox="0 0 24 24" fill="none" aria-hidden>
          <circle cx="12" cy="12" r="4" stroke={stroke} strokeWidth="1.5"/>
          <path d="M12 3 V6 M12 18 V21 M3 12 H6 M18 12 H21 M5.5 5.5 L7.5 7.5 M16.5 16.5 L18.5 18.5 M5.5 18.5 L7.5 16.5 M16.5 7.5 L18.5 5.5" stroke={stroke} strokeWidth="1.5" strokeLinecap="round"/>
        </svg>
      )
    case 'other':
    default:
      return (
        <svg width={s} height={s} viewBox="0 0 24 24" fill="none" aria-hidden>
          <rect x="4" y="4" width="16" height="16" rx="1.5" stroke={stroke} strokeWidth="1.5"/>
          <path d="M9 12 H15" stroke={stroke} strokeWidth="1.5" strokeLinecap="round"/>
        </svg>
      )
  }
}

const ROOM_TYPES: { value: RoomType; label: string }[] = [
  { value: 'living', label: 'Living' },
  { value: 'kitchen', label: 'Kitchen' },
  { value: 'dining', label: 'Dining' },
  { value: 'bedroom', label: 'Bedroom' },
  { value: 'bathroom', label: 'Bathroom' },
  { value: 'office', label: 'Office' },
  { value: 'hallway', label: 'Hallway' },
  { value: 'entryway', label: 'Entryway' },
  { value: 'closet', label: 'Closet' },
  { value: 'laundry', label: 'Laundry' },
  { value: 'garage', label: 'Garage' },
  { value: 'outdoor', label: 'Outdoor' },
  { value: 'other', label: 'Other' },
]

// Shoelace formula on the polygon (in metres).
function polygonAreaM2(polygon: [number, number][]): number {
  const n = polygon.length
  if (n < 3) return 0
  let a = 0
  for (let i = 0; i < n; i++) {
    const p = polygon[i]!
    const q = polygon[(i + 1) % n]!
    a += p[0] * q[1] - q[0] * p[1]
  }
  return Math.abs(a) * 0.5
}

export function ZonePanel() {
  // 2026-07-27: zones are selected via `selection.zoneId`, NOT
  // `selection.selectedIds` (see floorplan-panel setSelection({ zoneId })
  // at line 6523). Was reading from selectedIds -- panel never rendered
  // for auto-detected rooms so users couldn't change room type. Read
  // from zoneId instead. panel-manager also updated to check zoneId.
  const zoneId = useViewer((s) => s.selection.zoneId)
  const setSelection = useViewer((s) => s.setSelection)
  const nodes = useScene((s) => s.nodes)
  const updateNode = useScene((s) => s.updateNode)

  const selectedId = zoneId
  const node = selectedId ? (nodes[selectedId as AnyNode['id']] as ZoneNode | undefined) : undefined

  const handleUpdate = useCallback(
    (updates: Partial<ZoneNode>) => {
      if (!selectedId) return
      updateNode(selectedId as AnyNode['id'], updates)
    },
    [selectedId, updateNode],
  )

  const handleClose = useCallback(() => setSelection({ zoneId: null }), [setSelection])

  const handleDelete = useCallback(() => {
    if (!selectedId) return
    useScene.getState().deleteNode(selectedId as AnyNodeId)
    setSelection({ zoneId: null })
  }, [selectedId, setSelection])

  if (!node || node.type !== 'zone') return null

  const currentType = (node as any).roomType ?? 'other'
  const areaM2 = polygonAreaM2(node.polygon)
  const areaFt2 = areaM2 * 10.7639

  return (
    <PanelWrapper icon="/icons/wall.png" onClose={handleClose} title={node.name || 'Room'} width={280}>
      <PanelSection title="Name">
        <input
          type="text"
          value={node.name || ''}
          onChange={(e) => handleUpdate({ name: e.target.value })}
          className="w-full rounded-md border border-hair bg-transparent px-2 py-1 text-[12px] text-ink outline-none focus:border-ink/40"
          placeholder="Room name"
        />
      </PanelSection>

      <PanelSection title="Room type">
        <div className="grid grid-cols-3 gap-1.5">
          {ROOM_TYPES.map((rt) => {
            const active = currentType === rt.value
            return (
              <button
                key={rt.value}
                type="button"
                onClick={() => handleUpdate({ roomType: rt.value } as any)}
                className={cn(
                  'flex flex-col items-center gap-1 rounded-md border py-2 text-[10.5px] font-medium transition-colors',
                  active
                    ? 'border-ink bg-ink text-paper'
                    : 'border-hair text-ink/60 hover:bg-ink/[0.04] hover:text-ink',
                )}
              >
                <RoomIcon type={rt.value} />
                <span>{rt.label}</span>
              </button>
            )
          })}
        </div>
      </PanelSection>

      <PanelSection title="Area">
        <div className="flex items-baseline justify-between px-1 text-[12px]">
          <span className="text-ink/60">Metric</span>
          <span className="font-mono tabular-nums text-ink">{areaM2.toFixed(2)} m²</span>
        </div>
        <div className="flex items-baseline justify-between px-1 pt-0.5 text-[12px]">
          <span className="text-ink/60">Imperial</span>
          <span className="font-mono tabular-nums text-ink">{areaFt2.toFixed(0)} sq ft</span>
        </div>
      </PanelSection>

      <PanelSection title="">
        <button
          type="button"
          onClick={handleDelete}
          className="w-full rounded-md border border-red-300/60 bg-red-50/40 px-3 py-1.5 text-[12px] font-medium text-red-700 transition-colors hover:bg-red-100/60"
        >
          Delete room
        </button>
      </PanelSection>
    </PanelWrapper>
  )
}
