'use client'

import { emitter, generateId, useScene } from '@ritn3d/core'
import { useViewer } from '@ritn3d/viewer'
import { MoonIcon, ResetViewIcon, SunIcon, TrashIcon } from '../primitives/sidebar-icons'
import { motion } from 'motion/react'
import { type ReactNode, useEffect, useRef, useState } from 'react'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from './../../../components/ui/primitives/tooltip'
import { cn } from './../../../lib/utils'
import { useStore } from 'zustand'
import useEditor, { type StructureTool } from './../../../store/use-editor'

// Ritn3D 2026-07-19: undo/redo state from the temporal middleware
// (zundo). useScene.temporal is a StoreApi, not a hook -- wrap it in
// zustand's `useStore(...)` to subscribe reactively so the buttons
// enable/disable in real time as the user makes changes.
function useUndoRedo() {
  const pastLen = useStore(useScene.temporal, (s: any) => s.pastStates.length)
  const futureLen = useStore(useScene.temporal, (s: any) => s.futureStates.length)
  return {
    canUndo: pastLen > 0,
    canRedo: futureLen > 0,
    undo: () => useScene.temporal.getState().undo(),
    redo: () => useScene.temporal.getState().redo(),
  }
}

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

// Ritn3D 2026-07-19: minimal-mode tool rail. Wall / Arc Wall / Door /
// Window. Room / outdoor surfaces / symbols / buildings / templates are
// intentionally OFF for the first-story-only launch and will come back
// in a later version. Icon path convention matches the existing horizontal
// TOOLS row so no new asset copies are needed.
const ArcWallIconNodeIR = (
  <svg viewBox="0 0 24 24" width="20" height="20" fill="none" aria-hidden>
    <path d="M4 20 Q 12 4 20 20" stroke="currentColor" strokeWidth="2"
          strokeLinecap="round" fill="none"/>
  </svg>
)
const MINIMAL_TOOLS: {
  id: StructureTool
  label: string
  icon?: string
  iconNode?: ReactNode
}[] = [
  { id: 'wall',     label: 'Wall',     icon: '/icons/wall.png' },
  { id: 'arc-wall', label: 'Arc Wall', iconNode: ArcWallIconNodeIR },
  { id: 'door',     label: 'Door',     icon: '/icons/door.png' },
  { id: 'window',   label: 'Window',   icon: '/icons/window.png' },
]

// Ritn3D 2026-07-19: Select-mode icon (arrow cursor). Distinct from
// build-mode tools -- Select doesn't draw, it manipulates existing
// elements. Icon: standard 8-pixel cursor arrow.
const SelectIconNode = (
  <svg viewBox="0 0 24 24" width="18" height="18" fill="none" aria-hidden>
    <path d="M4 3 L4 17 L8 14 L11 20 L13 19 L10 13 L15 13 Z"
          stroke="currentColor" strokeWidth="1.6"
          strokeLinejoin="round" fill="currentColor" fillOpacity="0.15"/>
  </svg>
)
const UndoIconNode = (
  <svg viewBox="0 0 24 24" width="16" height="16" fill="none" aria-hidden>
    <path d="M9 6 L4 11 L9 16" stroke="currentColor" strokeWidth="1.8"
          strokeLinecap="round" strokeLinejoin="round"/>
    <path d="M4 11 H14 A5 5 0 0 1 19 16 V19"
          stroke="currentColor" strokeWidth="1.8"
          strokeLinecap="round" strokeLinejoin="round" fill="none"/>
  </svg>
)

// Ritn3D 2026-07-24 iOS parity: Calibrate + Trace as first-class rail
// tools (iOS `PlanTool.swift` surfaces them in ToolPalette). Calibrate
// fires the existing floorplan:calibrate-scale event -- user then
// clicks two known-distance points on the canvas to set scale. Trace
// opens the site panel where the guide/reference upload UI lives.
const CalibrateIconNode = (
  <svg viewBox="0 0 24 24" width="18" height="18" fill="none" aria-hidden>
    <path d="M3 12 H21" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
    <path d="M6 9 V15 M12 9 V15 M18 9 V15" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
    <path d="M4 6 L5 5 L5 6 M20 6 L19 5 L19 6" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/>
  </svg>
)
const TraceIconNode = (
  <svg viewBox="0 0 24 24" width="18" height="18" fill="none" aria-hidden>
    <rect x="4" y="4" width="16" height="16" rx="1.5" stroke="currentColor" strokeWidth="1.4" fill="none" strokeDasharray="2.5 2"/>
    <path d="M8 10 L11 15 L14 12 L16 16" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" fill="none"/>
  </svg>
)
const RedoIconNode = (
  <svg viewBox="0 0 24 24" width="16" height="16" fill="none" aria-hidden>
    <path d="M15 6 L20 11 L15 16" stroke="currentColor" strokeWidth="1.8"
          strokeLinecap="round" strokeLinejoin="round"/>
    <path d="M20 11 H10 A5 5 0 0 0 5 16 V19"
          stroke="currentColor" strokeWidth="1.8"
          strokeLinecap="round" strokeLinejoin="round" fill="none"/>
  </svg>
)
const GridSnapIconNode = (
  <svg viewBox="0 0 24 24" width="18" height="18" fill="none" aria-hidden>
    <path d="M4 4h16v16H4z" stroke="currentColor" strokeWidth="1.2" strokeOpacity="0.35" fill="none"/>
    <path d="M9 4v16 M15 4v16 M4 9h16 M4 15h16" stroke="currentColor" strokeWidth="1" strokeOpacity="0.35"/>
    <circle cx="9" cy="9" r="1.4" fill="currentColor"/>
    <circle cx="15" cy="9" r="1.4" fill="currentColor"/>
    <circle cx="9" cy="15" r="1.4" fill="currentColor"/>
    <circle cx="15" cy="15" r="1.4" fill="currentColor"/>
  </svg>
)
const OrthoIconNode = (
  <svg viewBox="0 0 24 24" width="18" height="18" fill="none" aria-hidden>
    <path d="M6 18 V6 H18" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
    <path d="M6 18 L18 18" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeOpacity="0.35"/>
  </svg>
)

export function IconRail({ activePanel, onPanelChange, appMenuButton, className }: IconRailProps) {
  const theme = useViewer((state) => state.theme)
  const setTheme = useViewer((state) => state.setTheme)
  const unit = useViewer((state) => state.unit)
  const setUnit = useViewer((state) => state.setUnit)
  const mode = useEditor((s) => s.mode)
  const tool = useEditor((s) => s.tool)
  const setMode = useEditor((s) => s.setMode)
  const gridSnapEnabled = useEditor((s) => s.gridSnapEnabled)
  const setGridSnapEnabled = useEditor((s) => s.setGridSnapEnabled)
  const orthoEnabled = useEditor((s) => s.orthoEnabled)
  const setOrthoEnabled = useEditor((s) => s.setOrthoEnabled)
  const { canUndo, canRedo, undo, redo } = useUndoRedo()
  const [mounted, setMounted] = useState(false)
  const traceInputRef = useRef<HTMLInputElement>(null)

  // Ritn3D 2026-07-27: Trace tool now opens a file picker directly and
  // creates a GuideNode from the chosen image on the active level.
  // Previously it opened the Site panel which required extra clicks.
  const handleTraceFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    const isImage = file.type.startsWith('image/')
    if (!isImage) {
      // Fall back to opening the site panel for PDF uploads -- that
      // path already handles pdf.js rendering.
      onPanelChange('site')
      return
    }
    const reader = new FileReader()
    reader.onload = () => {
      const dataUrl = reader.result as string
      const state = useScene.getState() as any
      const nodes = state.nodes as Record<string, any>
      const level = Object.values(nodes).find((n: any) => n.type === 'level')
      if (!level) return
      const guide = {
        id: generateId('guide'),
        type: 'guide' as const,
        parentId: level.id,
        visible: true,
        url: dataUrl,
        position: [0, 0, 0] as [number, number, number],
        rotation: [0, 0, 0] as [number, number, number],
        scale: 5,
        opacity: 40,
      }
      state.createNode(guide, level.id)
      // 2026-07-28: auto-start scale calibration right after upload.
      // Without this, first-time users don't discover the calibrate
      // flow and their trace ends up at editor-default scale (1 unit
      // = 5m, way off). Small delay so the guide has time to render
      // before the calibration overlay banner appears.
      setTimeout(() => {
        emitter.emit('floorplan:calibrate-scale' as any, { guideId: guide.id })
      }, 200)
    }
    reader.readAsDataURL(file)
  }

  useEffect(() => {
    setMounted(true)
  }, [])

  const pickTool = (id: StructureTool) => {
    // Match what the (now-hidden) horizontal tools row did: enter build
    // mode on the structure/elements layer with the chosen tool.
    useEditor.getState().setPhase('structure')
    useEditor.getState().setStructureLayer('elements')
    useEditor.getState().setCatalogCategory(null)
    useEditor.getState().setMode('build')
    useEditor.getState().setTool(id)
  }

  const pickSelect = () => {
    useEditor.getState().setMode('select')
  }

  // Small helper for consistent styling of the icon+label buttons.
  const RailButton = ({
    isActive, onClick, disabled, label, iconNode, imgSrc,
  }: {
    isActive: boolean
    onClick: () => void
    disabled?: boolean
    label: string
    iconNode?: ReactNode
    imgSrc?: string
  }) => (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        // 2026-07-28: tighter vertical rhythm so all icons fit on a
        // typical laptop viewport without scrolling. py-1 + gap-0
        // saves ~5 px per row across 15+ buttons.
        'flex w-full flex-col items-center gap-0 px-1 py-1 transition-all',
        disabled
          ? 'opacity-35 cursor-not-allowed'
          : isActive
            ? 'bg-[var(--color-accent)]/12 text-[var(--color-accent)]'
            : 'text-ink/70 hover:bg-ink/[0.04] hover:text-ink',
      )}
    >
      {imgSrc ? (
        <img alt={label} src={imgSrc}
             className={cn('h-[18px] w-[18px] object-contain',
                           !isActive && !disabled && 'opacity-60 saturate-0')} />
      ) : (
        <span className="flex h-[18px] w-[18px] items-center justify-center">{iconNode}</span>
      )}
      <span className="font-medium text-[9px] leading-[1.05]">{label}</span>
    </button>
  )

  return (
    <div
      className={cn(
        // w-16 (64 px) gives room for the 5-char labels ("Arc W…" gets
        // truncated at 5 chars, "Wall"/"Door"/"Win" fit comfortably).
        // 2026-07-28: overflow-y-auto so the rail scrolls when too many
        // toggles push the theme + unit buttons off-screen (had this
        // problem after adding grid-snap + ortho toggles).
        'flex h-full w-16 flex-col items-stretch overflow-y-auto border-r border-hair bg-paper py-1 scrollbar-thin',
        className,
      )}
    >
      {/* App menu slot */}
      {appMenuButton}

      {/* Divider — only when there's something above it worth dividing from */}
      {(appMenuButton || panels.length > 0) && (
        <div className="mb-1 h-px w-full bg-hair" />
      )}

      {/* Select tool -- always at the very top so it's the default
          "back to safe mode" shortcut after any build action. */}
      <RailButton
        isActive={mode === 'select'}
        onClick={pickSelect}
        label="Select"
        iconNode={SelectIconNode}
      />

      {/* Ritn3D 2026-07-19: minimal build tools with labels under each. */}
      {MINIMAL_TOOLS.map((t) => (
        <RailButton
          key={t.id}
          isActive={mode === 'build' && tool === t.id}
          onClick={() => pickTool(t.id)}
          label={t.label}
          imgSrc={t.icon}
          iconNode={t.iconNode}
        />
      ))}

      {/* Ritn3D 2026-07-24 iOS parity: Calibrate + Trace rail tools.
          2026-07-27: Calibrate must fire with a guideId or the panel
          handler noops. Auto-pick the first guide (underlay image) on
          the active level; alert if none is loaded so users know they
          need to upload a trace first. */}
      <RailButton
        isActive={false}
        onClick={() => {
          const state = useScene.getState()
          const activeLevelId = useViewer.getState().selection.levelId
          const guide = Object.values(state.nodes).find(
            (n: any) => n.type === 'guide' && n.parentId === activeLevelId,
          ) as any
          if (!guide) {
            alert(
              'No trace image to calibrate. Click the Trace button and pick a photo first, then calibrate its scale.',
            )
            return
          }
          // Also select the guide so the ReferencePanel opens with the
          // Set-Scale button visible and highlighted -- confirms the
          // click did something even before the user places the 2 points.
          useViewer.getState().setSelection({ selectedIds: [guide.id] })
          emitter.emit('floorplan:calibrate-scale' as any, { guideId: guide.id })
        }}
        label="Calibrate"
        iconNode={CalibrateIconNode}
      />
      <RailButton
        isActive={false}
        onClick={() => traceInputRef.current?.click()}
        label="Trace"
        iconNode={TraceIconNode}
      />
      <input
        ref={traceInputRef}
        type="file"
        accept="image/*,application/pdf"
        className="hidden"
        onChange={handleTraceFile}
      />

      {/* 2026-07-27/28: persistent snap / ortho toggles. Compact labels
          (just 'Grid' / 'Ortho') so the rail doesn't push the theme +
          unit toggles off-screen. Shift key still overrides per-drag
          -- tooltip shows current state on hover. */}
      <div className="my-0.5 h-px w-full bg-hair" />
      <RailButton
        isActive={gridSnapEnabled}
        onClick={() => setGridSnapEnabled(!gridSnapEnabled)}
        label={gridSnapEnabled ? 'Grid snap on' : 'Grid snap off'}
        iconNode={GridSnapIconNode}
      />
      <RailButton
        isActive={orthoEnabled}
        onClick={() => setOrthoEnabled(!orthoEnabled)}
        label={orthoEnabled ? 'Ortho on' : 'Ortho off'}
        iconNode={OrthoIconNode}
      />

      {/* Undo / Redo — grouped just below the build tools */}
      <div className="my-0.5 h-px w-full bg-hair" />
      <RailButton
        isActive={false}
        onClick={undo}
        disabled={!canUndo}
        label="Undo"
        iconNode={UndoIconNode}
      />
      <RailButton
        isActive={false}
        onClick={redo}
        disabled={!canRedo}
        label="Redo"
        iconNode={RedoIconNode}
      />

      {/* Divider between tools and utility icons below */}
      <div className="my-0.5 h-px w-full bg-hair" />

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

      {/* Utility icons at bottom -- Reset View, Clear, Units, Theme. */}
      <RailButton
        isActive={false}
        onClick={() => emitter.emit('floorplan:reset-view' as any)}
        label="Fit"
        iconNode={<ResetViewIcon size={16} />}
      />
      <RailButton
        isActive={false}
        onClick={() => {
          // Ritn3D 2026-07-27: previous emit('floorplan:clear-canvas') went to
          // AppSidebar which is hidden in minimal-launch mode -> the listener
          // never fired. Inline the clear logic so it works from the rail alone.
          const ok = window.confirm(
            'Clear the whole canvas?\n\n' +
            'This deletes every wall, door, window, room, guide, and item on ' +
            'the active level. You can undo with Ctrl+Z.'
          )
          if (!ok) return
          const { levelId } = useViewer.getState().selection
          if (!levelId) return
          const nodes = useScene.getState().nodes as any
          const levelNode = nodes[levelId as any]
          if (levelNode?.type !== 'level') return
          const childIds = [...((levelNode as any).children || [])]
          for (const cid of childIds) {
            useScene.getState().deleteNode(cid as any)
          }
          useViewer.getState().setSelection({ selectedIds: [] })
        }}
        label="Clear"
        iconNode={<TrashIcon size={15} />}
      />

      {/* Unit Toggle — segmented pair labelled m / ft */}
      {mounted && (
        <div className="mx-2 my-1 flex flex-col rounded-md border border-hair overflow-hidden">
          <button
            className={cn(
              'flex h-7 items-center justify-center font-semibold text-[11px] transition-all',
              unit === 'metric'
                ? 'bg-ink text-paper'
                : 'text-ink/60 hover:text-ink hover:bg-ink/[0.04]',
            )}
            onClick={() => setUnit('metric')}
            type="button"
          >
            m
          </button>
          <div className="h-px bg-hair" />
          <button
            className={cn(
              'flex h-7 items-center justify-center font-semibold text-[11px] transition-all',
              unit === 'imperial'
                ? 'bg-ink text-paper'
                : 'text-ink/60 hover:text-ink hover:bg-ink/[0.04]',
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
        <RailButton
          isActive={false}
          onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
          label={theme === 'dark' ? 'Light' : 'Dark'}
          iconNode={
            <motion.div
              animate={{ rotate: 0, opacity: 1 }}
              initial={{ rotate: -90, opacity: 0 }}
              key={theme}
              transition={{ duration: 0.25, ease: 'easeOut' }}
            >
              {theme === 'dark' ? <SunIcon size={15} /> : <MoonIcon size={15} />}
            </motion.div>
          }
        />
      )}
    </div>
  )
}

export { panels }
