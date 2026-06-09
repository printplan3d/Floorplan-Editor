'use client'

import { emitter, useScene } from '@pascal-app/core'
import { useViewer } from '@pascal-app/viewer'
import { Moon, Sun } from 'lucide-react'
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

const panels: { id: PanelId; iconSrc: string; label: string }[] = [
  { id: 'site', iconSrc: '/icons/level.png', label: 'Site' },
]

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
        'flex h-full w-14 flex-col items-center gap-1.5 border-border/50 border-r py-2',
        className,
      )}
    >
      {/* App menu slot */}
      {appMenuButton}

      {/* Divider */}
      <div className="mb-1 h-px w-10 bg-border/50" />

      {panels.map((panel) => {
        const isActive = activePanel === panel.id
        return (
          <Tooltip key={panel.id}>
            <TooltipTrigger asChild>
              <button
                className={cn(
                  'flex h-10 w-10 items-center justify-center rounded-lg transition-all',
                  isActive ? 'bg-accent' : 'hover:bg-accent',
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
            className="flex h-10 w-10 items-center justify-center rounded-lg border border-border/50 bg-accent/40 text-muted-foreground transition-all hover:bg-accent hover:text-foreground"
            onClick={() => emitter.emit('floorplan:reset-view' as any)}
            type="button"
          >
            <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
              <path d="M15 3h6v6" /><path d="M9 21H3v-6" /><path d="M21 3l-7 7" /><path d="M3 21l7-7" />
            </svg>
          </button>
        </TooltipTrigger>
        <TooltipContent side="right">Reset View</TooltipContent>
      </Tooltip>

      {/* Clear Canvas */}
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            className="flex h-10 w-10 items-center justify-center rounded-lg border border-border/50 bg-accent/40 text-muted-foreground transition-all hover:bg-red-500/20 hover:text-red-400 hover:border-red-500/30"
            onClick={() => emitter.emit('floorplan:clear-canvas' as any)}
            type="button"
          >
            <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
              <polyline points="3 6 5 6 21 6" /><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2" />
            </svg>
          </button>
        </TooltipTrigger>
        <TooltipContent side="right">Clear Canvas</TooltipContent>
      </Tooltip>

      {/* Unit Toggle — bigger segmented button */}
      {mounted && (
        <div className="flex w-10 flex-col rounded-lg border border-border/50 overflow-hidden">
          <button
            className={cn(
              'flex h-8 items-center justify-center font-semibold text-xs transition-all',
              unit === 'metric'
                ? 'bg-accent text-foreground'
                : 'text-muted-foreground/60 hover:text-muted-foreground hover:bg-accent/40',
            )}
            onClick={() => setUnit('metric')}
            type="button"
          >
            m
          </button>
          <div className="h-px bg-border/50" />
          <button
            className={cn(
              'flex h-8 items-center justify-center font-semibold text-xs transition-all',
              unit === 'imperial'
                ? 'bg-accent text-foreground'
                : 'text-muted-foreground/60 hover:text-muted-foreground hover:bg-accent/40',
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
              className="mb-2 mt-1.5 flex h-10 w-10 items-center justify-center rounded-lg border border-border/50 bg-accent/40 text-foreground transition-all hover:bg-accent"
              onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
              type="button"
            >
              <motion.div
                animate={{ rotate: 0, opacity: 1 }}
                initial={{ rotate: -90, opacity: 0 }}
                key={theme}
                transition={{ duration: 0.25, ease: 'easeOut' }}
              >
                {theme === 'dark' ? <Sun className="h-4.5 w-4.5" /> : <Moon className="h-4.5 w-4.5" />}
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
