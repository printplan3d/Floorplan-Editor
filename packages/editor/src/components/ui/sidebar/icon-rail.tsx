'use client'

import { emitter, useScene } from '@ritn3d/core'
import { useViewer } from '@ritn3d/viewer'
import { MoonIcon, ResetViewIcon, SunIcon, TrashIcon } from '../primitives/sidebar-icons'
import { motion } from 'motion/react'
import { type ReactNode, useEffect, useState } from 'react'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from './../../../components/ui/primitives/tooltip'
import { cn } from './../../../lib/utils'

export type PanelId = 'site' | 'settings'

interface IconRailProps {
  activePanel: PanelId
  onPanelChange: (panel: PanelId) => void
  appMenuButton?: ReactNode
  className?: string
}

// Ritn3D 2026-07-13: 'Site' rail button removed — it was the only entry
// and served no purpose (activePanel defaults to 'site' anyway). Keeping
// the array shape so the rail can still host future panels without a
// refactor.
const panels: { id: PanelId; iconSrc: string; label: string }[] = []

export function IconRail({ activePanel, onPanelChange, appMenuButton, className }: IconRailProps) {
  const theme = useViewer((state) => state.theme)
  const setTheme = useViewer((state) => state.setTheme)
  const unit = useViewer((state) => state.unit)
  const setUnit = useViewer((state) => state.setUnit)
  const [mounted, setMounted] = useState(false)

  useEffect(() => {
    setMounted(true)
  }, [])

  return (
    <div
      className={cn(
        'flex h-full w-14 flex-col items-center gap-1.5 border-r border-hair bg-paper py-2',
        className,
      )}
    >
      {/* App menu slot */}
      {appMenuButton}

      {/* Divider — only when there's something above it worth dividing from */}
      {(appMenuButton || panels.length > 0) && (
        <div className="mb-1 h-px w-10 bg-hair" />
      )}

      {panels.map((panel) => {
        const isActive = activePanel === panel.id
        return (
          <Tooltip key={panel.id}>
            <TooltipTrigger asChild>
              <button
                className={cn(
                  'flex h-10 w-10 items-center justify-center rounded-md transition-all',
                  isActive ? 'bg-ink/[0.06] text-[var(--color-accent)]' : 'text-ink/55 hover:bg-ink/[0.04] hover:text-ink',
                )}
                onClick={() => onPanelChange(panel.id)}
                type="button"
              >
                <img
                  alt={panel.label}
                  className={cn(
                    'h-6 w-6 object-contain transition-all',
                    !isActive && 'opacity-50 saturate-0',
                  )}
                  src={panel.iconSrc}
                />
              </button>
            </TooltipTrigger>
            <TooltipContent side="right">{panel.label}</TooltipContent>
          </Tooltip>
        )
      })}

      {/* Spacer */}
      <div className="flex-1" />

      {/* Reset View */}
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            className="flex h-10 w-10 items-center justify-center rounded-md border border-hair bg-paper text-ink/60 transition-all hover:bg-ink/[0.04] hover:text-ink"
            onClick={() => emitter.emit('floorplan:reset-view' as any)}
            type="button"
          >
            <ResetViewIcon size={15} />
          </button>
        </TooltipTrigger>
        <TooltipContent side="right">Reset View</TooltipContent>
      </Tooltip>

      {/* Clear Canvas */}
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            className="flex h-10 w-10 items-center justify-center rounded-md border border-hair bg-paper text-ink/60 transition-all hover:bg-red-50 hover:text-red-700 hover:border-red-200"
            onClick={() => emitter.emit('floorplan:clear-canvas' as any)}
            type="button"
          >
            <TrashIcon size={15} />
          </button>
        </TooltipTrigger>
        <TooltipContent side="right">Clear Canvas</TooltipContent>
      </Tooltip>

      {/* Unit Toggle — bigger segmented button */}
      {mounted && (
        <div className="flex w-10 flex-col rounded-md border border-hair overflow-hidden">
          <button
            className={cn(
              'flex h-8 items-center justify-center font-semibold text-xs transition-all',
              unit === 'metric'
                ? 'bg-ink text-paper'
                : 'text-ink/50 hover:text-ink hover:bg-ink/[0.04]',
            )}
            onClick={() => setUnit('metric')}
            type="button"
          >
            m
          </button>
          <div className="h-px bg-hair" />
          <button
            className={cn(
              'flex h-8 items-center justify-center font-semibold text-xs transition-all',
              unit === 'imperial'
                ? 'bg-ink text-paper'
                : 'text-ink/50 hover:text-ink hover:bg-ink/[0.04]',
            )}
            onClick={() => setUnit('imperial')}
            type="button"
          >
            ft
          </button>
        </div>
      )}

      {/* Theme Toggle */}
      {mounted && (
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              className="mb-2 mt-1.5 flex h-10 w-10 items-center justify-center rounded-md border border-hair bg-paper text-ink/65 transition-all hover:bg-ink/[0.04] hover:text-ink"
              onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
              type="button"
            >
              <motion.div
                animate={{ rotate: 0, opacity: 1 }}
                initial={{ rotate: -90, opacity: 0 }}
                key={theme}
                transition={{ duration: 0.25, ease: 'easeOut' }}
              >
                {theme === 'dark' ? <SunIcon size={16} /> : <MoonIcon size={16} />}
              </motion.div>
            </button>
          </TooltipTrigger>
          <TooltipContent side="right">Toggle theme</TooltipContent>
        </Tooltip>
      )}
    </div>
  )
}

export { panels }
