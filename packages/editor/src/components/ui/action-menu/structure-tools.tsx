'use client'

import NextImage from 'next/image'
import type { ReactNode } from 'react'
import { useContextualTools } from '../../../hooks/use-contextual-tools'

import { cn } from '../../../lib/utils'
import useEditor, {
  type CatalogCategory,
  type StructureTool,
  type Tool,
} from '../../../store/use-editor'
import { ActionButton } from './action-button'

export type ToolConfig = {
  id: StructureTool
  // Pascal default: image asset. Ritn3D extension: optional iconNode for tools
  // that don't have a dedicated PNG yet (e.g. arc-wall). One of iconSrc / iconNode
  // must be set.
  iconSrc?: string
  iconNode?: ReactNode
  label: string
  catalogCategory?: CatalogCategory
}

// Inline arc-wall icon — a high-contrast arc + two endpoint dots. Was using
// currentColor + thin stroke and disappeared into the dark toolbar at the 18px
// rendered size; hard-coded #6cb4ff (matches the bulge handle's accent) +
// thicker stroke + bigger dots so it's unmistakable. Replace with a designed
// PNG when we get one.
const ArcWallIcon = (
  <svg
    viewBox="0 0 28 28"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
    style={{ width: '100%', height: '100%', display: 'block' }}
    aria-hidden="true"
  >
    <path
      d="M5 22 Q 14 2 23 22"
      stroke="#6cb4ff"
      strokeWidth="3"
      strokeLinecap="round"
      fill="none"
    />
    <circle cx="5" cy="22" r="3" fill="#6cb4ff" />
    <circle cx="23" cy="22" r="3" fill="#6cb4ff" />
  </svg>
)

export const tools: ToolConfig[] = [
  { id: 'wall', iconSrc: '/icons/wall.png', label: 'Wall' },
  { id: 'arc-wall', iconNode: ArcWallIcon, label: 'Arc Wall' },
  { id: 'door', iconSrc: '/icons/door.png', label: 'Door' },
  { id: 'window', iconSrc: '/icons/window.png', label: 'Window' },
  { id: 'zone', iconSrc: '/icons/zone.png', label: 'Room' },
]

export function StructureTools() {
  const activeTool = useEditor((state) => state.tool)
  const catalogCategory = useEditor((state) => state.catalogCategory)
  const structureLayer = useEditor((state) => state.structureLayer)
  const setTool = useEditor((state) => state.setTool)
  const setCatalogCategory = useEditor((state) => state.setCatalogCategory)

  const contextualTools = useContextualTools()

  // Filter tools based on structureLayer
  const visibleTools =
    structureLayer === 'zones'
      ? tools.filter((t) => t.id === 'zone')
      : tools.filter((t) => t.id !== 'zone')

  const hasActiveTool = visibleTools.some(
    (t) =>
      activeTool === t.id && (t.catalogCategory ? catalogCategory === t.catalogCategory : true),
  )

  return (
    <div className="flex items-center gap-1.5 px-1">
      {visibleTools.map((tool, index) => {
        // For item tools with catalog category, check both tool and category match
        const isActive =
          activeTool === tool.id &&
          (tool.catalogCategory ? catalogCategory === tool.catalogCategory : true)

        const isContextual = contextualTools.includes(tool.id)

        return (
          <ActionButton
            className={cn(
              'rounded-lg duration-300',
              isActive
                ? 'z-10 scale-110 bg-black/40 hover:bg-black/40'
                : 'scale-95 bg-transparent opacity-60 grayscale hover:bg-black/20 hover:opacity-100 hover:grayscale-0',
            )}
            key={`${tool.id}-${tool.catalogCategory ?? index}`}
            label={tool.label}
            onClick={() => {
              if (!isActive) {
                setTool(tool.id)
                setCatalogCategory(tool.catalogCategory ?? null)

                // Automatically switch to build mode if we select a tool
                if (useEditor.getState().mode !== 'build') {
                  useEditor.getState().setMode('build')
                }
              }
            }}
            size="icon"
            variant="ghost"
          >
            {tool.iconSrc ? (
              <NextImage
                alt={tool.label}
                className="size-full object-contain"
                height={28}
                src={tool.iconSrc}
                width={28}
              />
            ) : (
              <span aria-label={tool.label} className="block size-full">
                {tool.iconNode}
              </span>
            )}
          </ActionButton>
        )
      })}
    </div>
  )
}
