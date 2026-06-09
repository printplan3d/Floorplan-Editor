'use client'

import { useState } from 'react'
import { cn } from '../../lib/utils'

type Symbol = {
  id: string
  label: string
  src: string
}

type SymbolGroup = {
  id: string
  label: string
  symbols: Symbol[]
}

const SYMBOL_GROUPS: SymbolGroup[] = [
  {
    id: 'bathroom',
    label: 'Bathroom',
    symbols: [
      { id: 'toilet', label: 'Toilet', src: '/symbols/bathroom/toilet.svg' },
      { id: 'sink', label: 'Sink', src: '/symbols/bathroom/sink.svg' },
      { id: 'bathtub', label: 'Bathtub', src: '/symbols/bathroom/bathtub.svg' },
      { id: 'shower', label: 'Shower', src: '/symbols/bathroom/shower.svg' },
    ],
  },
  {
    id: 'kitchen',
    label: 'Kitchen',
    symbols: [
      { id: 'stove', label: 'Stove', src: '/symbols/kitchen/stove.svg' },
      { id: 'oven', label: 'Oven', src: '/symbols/kitchen/oven.svg' },
      { id: 'fridge', label: 'Fridge', src: '/symbols/kitchen/fridge.svg' },
      { id: 'counter', label: 'Counter', src: '/symbols/kitchen/counter.svg' },
    ],
  },
  {
    id: 'bedroom',
    label: 'Bedroom',
    symbols: [
      { id: 'bed', label: 'Bed', src: '/symbols/bedroom/bed.svg' },
      { id: 'wardrobe', label: 'Wardrobe', src: '/symbols/bedroom/wardrobe.svg' },
    ],
  },
  {
    id: 'living',
    label: 'Living Room',
    symbols: [
      { id: 'sofa', label: 'Sofa', src: '/symbols/living/sofa.svg' },
      { id: 'l_sofa', label: 'L-Sofa', src: '/symbols/living/l_sofa.svg' },
      { id: 'coffee_table', label: 'Coffee Table', src: '/symbols/living/coffee_table.svg' },
      { id: 'tv_console', label: 'TV Console', src: '/symbols/living/tv_console.svg' },
      { id: 'bookshelf', label: 'Bookshelf', src: '/symbols/living/bookshelf.svg' },
      { id: 'floor_lamp', label: 'Floor Lamp', src: '/symbols/living/floor_lamp.svg' },
    ],
  },
  {
    id: 'dining',
    label: 'Dining',
    symbols: [
      { id: 'table', label: 'Table', src: '/symbols/dining/table.svg' },
      { id: 'round_table', label: 'Round Table', src: '/symbols/dining/round_table.svg' },
      { id: 'chair', label: 'Chair', src: '/symbols/dining/chair.svg' },
    ],
  },
  {
    id: 'office',
    label: 'Office',
    symbols: [
      { id: 'desk', label: 'Desk', src: '/symbols/office/desk.svg' },
      { id: 'office_chair', label: 'Chair', src: '/symbols/office/office_chair.svg' },
      { id: 'filing_cabinet', label: 'Filing Cabinet', src: '/symbols/office/filing_cabinet.svg' },
      { id: 'conference_table', label: 'Conference', src: '/symbols/office/conference_table.svg' },
    ],
  },
  {
    id: 'stairs',
    label: 'Stairs',
    symbols: [
      { id: 'staircase', label: 'Straight', src: '/symbols/stairs/staircase.svg' },
      { id: 'spiral_staircase', label: 'Spiral', src: '/symbols/stairs/spiral_staircase.svg' },
    ],
  },
  {
    id: 'outdoor',
    label: 'Outdoor',
    symbols: [
      { id: 'balcony', label: 'Balcony', src: '/symbols/outdoor/balcony.svg' },
      { id: 'deck', label: 'Deck', src: '/symbols/outdoor/deck.svg' },
      { id: 'porch', label: 'Porch', src: '/symbols/outdoor/porch.svg' },
      { id: 'fence', label: 'Fence', src: '/symbols/outdoor/fence.svg' },
      { id: 'railing', label: 'Railing', src: '/symbols/outdoor/railing.svg' },
    ],
  },
]

export function SymbolCatalog() {
  const [expandedGroup, setExpandedGroup] = useState<string | null>(null)
  const [dragSymbol, setDragSymbol] = useState<Symbol | null>(null)

  return (
    <div className="space-y-0.5">
      {SYMBOL_GROUPS.map((group) => {
        const isExpanded = expandedGroup === group.id
        return (
          <div key={group.id}>
            <button
              className={cn(
                'flex w-full items-center justify-between rounded-lg px-2 py-1.5 text-[11px] font-medium transition-colors',
                isExpanded
                  ? 'bg-accent/60 text-foreground'
                  : 'text-muted-foreground hover:bg-accent/30 hover:text-foreground',
              )}
              onClick={() => setExpandedGroup(isExpanded ? null : group.id)}
              type="button"
            >
              <span>{group.label}</span>
              <div className="flex items-center gap-1.5">
                <span className="text-[9px] text-muted-foreground/50">{group.symbols.length}</span>
                <svg
                  className={cn('h-3 w-3 transition-transform', isExpanded && 'rotate-90')}
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                  strokeWidth={2}
                >
                  <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
                </svg>
              </div>
            </button>

            {isExpanded && (
              <div className="grid grid-cols-3 gap-1 px-1 py-1.5">
                {group.symbols.map((symbol) => (
                  <button
                    key={symbol.id}
                    className="flex flex-col items-center gap-1 rounded-lg border border-border/30 bg-accent/15 p-1.5 transition-all hover:bg-accent/40 hover:border-border/50 active:scale-95 cursor-grab"
                    draggable
                    onDragStart={(e) => {
                      setDragSymbol(symbol)
                      e.dataTransfer.setData('text/plain', JSON.stringify(symbol))
                      e.dataTransfer.effectAllowed = 'copy'
                    }}
                    onDragEnd={() => setDragSymbol(null)}
                    title={`Drag "${symbol.label}" onto the canvas`}
                    type="button"
                  >
                    <div className="flex h-8 w-8 items-center justify-center">
                      <img
                        alt={symbol.label}
                        className="max-h-8 max-w-8 object-contain"
                        draggable={false}
                        src={symbol.src}
                        style={{ filter: 'invert(0.8)' }}
                      />
                    </div>
                    <span className="text-[8px] text-muted-foreground/70 leading-tight text-center truncate w-full">
                      {symbol.label}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

export { SYMBOL_GROUPS }
