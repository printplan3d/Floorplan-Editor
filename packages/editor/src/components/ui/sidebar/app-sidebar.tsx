'use client'

import { emitter, useScene } from '@pascal-app/core'
import { useViewer } from '@pascal-app/viewer'
import NextImage from 'next/image'
import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react'
import { CommandPalette } from './../../../components/ui/command-palette'
import { EditorCommands } from './../../../components/ui/command-palette/editor-commands'
import {
  Sidebar,
  SidebarContent,
  SidebarHeader,
  useSidebarStore,
} from './../../../components/ui/primitives/sidebar'
import { cn } from './../../../lib/utils'
import useEditor, { type Mode, type StructureTool } from './../../../store/use-editor'
import { SymbolCatalog } from './../../../components/ui/symbol-catalog'
import { TEMPLATES } from './../../../lib/templates'
import { applySceneGraphToEditor } from './../../../lib/scene'
import { downloadJSON } from './../../../lib/export-json'
import { exportPDF } from './../../../lib/export-pdf'
import { exportSVG } from './../../../lib/export-svg'
import { IconRail, type PanelId } from './icon-rail'
import { SettingsPanel, type SettingsPanelProps } from './panels/settings-panel'
import { SitePanel, type SitePanelProps } from './panels/site-panel'

interface AppSidebarProps {
  appMenuButton?: ReactNode
  sidebarTop?: ReactNode
  settingsPanelProps?: SettingsPanelProps
  sitePanelProps?: SitePanelProps
}

const MODES: { id: Mode; label: string; shortcut: string; color: string; activeColor: string; icon?: string }[] = [
  { id: 'select', label: 'Select', shortcut: 'V', color: 'hover:bg-blue-500/20 hover:text-blue-400', activeColor: 'bg-blue-500/20 text-blue-400', icon: '/icons/select.png' },
  { id: 'build', label: 'Draw', shortcut: 'B', color: 'hover:bg-green-500/20 hover:text-green-400', activeColor: 'bg-green-500/20 text-green-400', icon: '/icons/build.png' },
  { id: 'delete', label: 'Delete', shortcut: 'D', color: 'hover:bg-red-500/20 hover:text-red-400', activeColor: 'bg-red-500/20 text-red-400' },
]

const TOOLS: { id: StructureTool; label: string; icon: string }[] = [
  { id: 'wall', label: 'Wall', icon: '/icons/wall.png' },
  { id: 'door', label: 'Door', icon: '/icons/door.png' },
  { id: 'window', label: 'Window', icon: '/icons/window.png' },
  { id: 'zone', label: 'Room', icon: '/icons/zone.png' },
]

function SidebarToolbar() {
  const mode = useEditor((s) => s.mode)
  const phase = useEditor((s) => s.phase)
  const tool = useEditor((s) => s.tool)
  const setMode = useEditor((s) => s.setMode)
  const setTool = useEditor((s) => s.setTool)
  const setPhase = useEditor((s) => s.setPhase)
  const isSiteEditing = phase === 'site' && mode === 'edit'
  const [showClearModal, setShowClearModal] = useState(false)
  const [isMarqueeActive, setIsMarqueeActive] = useState(false)
  const [showDownloadMenu, setShowDownloadMenu] = useState(false)
  const wallCount = useScene((s) => {
    const levelId = useViewer.getState().selection.levelId
    if (!levelId) return 0
    const level = s.nodes[levelId as any]
    if (!level || level.type !== 'level') return 0
    return ((level as any).children || [])
      .map((id: string) => s.nodes[id as any])
      .filter((n: any) => n?.type === 'wall').length
  })

  useEffect(() => {
    const handler = (data: { active: boolean }) => setIsMarqueeActive(data.active)
    emitter.on('floorplan:marquee-state' as any, handler)
    return () => { emitter.off('floorplan:marquee-state' as any, handler) }
  }, [])

  // Listen for clear canvas event from icon rail
  useEffect(() => {
    const handler = () => setShowClearModal(true)
    emitter.on('floorplan:clear-canvas' as any, handler)
    return () => { emitter.off('floorplan:clear-canvas' as any, handler) }
  }, [])

  const handleClearConfirm = useCallback(() => {
    const { levelId } = useViewer.getState().selection
    if (levelId) {
      const nodes = useScene.getState().nodes
      const levelNode = nodes[levelId as any]
      if (levelNode?.type === 'level') {
        const childIds = [...((levelNode as any).children || [])]
        for (const childId of childIds) {
          const child = nodes[childId as any]
          if (child?.type === 'wall') {
            useScene.getState().deleteNode(childId as any)
          }
        }
      }
    }
    useViewer.getState().setSelection({ selectedIds: [] })
    setShowClearModal(false)
  }, [])

  return (
    <div className="border-border/50 border-b px-3 py-2.5 space-y-2.5">
      {/* Mode buttons */}
      <div className="flex gap-1">
        {MODES.map((m) => {
          const isActive = mode === m.id
          return (
            <button
              key={m.id}
              className={cn(
                'flex flex-1 items-center justify-center gap-1.5 rounded-lg px-2 py-1.5 font-medium text-xs transition-all',
                isActive ? m.activeColor : 'text-muted-foreground ' + m.color,
              )}
              onClick={() => {
                setMode(m.id)
                if (m.id === 'build') {
                  useEditor.getState().setPhase('structure')
                  useEditor.getState().setStructureLayer('elements')
                }
              }}
              title={`${m.label} (${m.shortcut})`}
              type="button"
            >
              {m.icon ? (
                <NextImage
                  alt={m.label}
                  className={cn('h-4 w-4 object-contain', !isActive && 'opacity-60 grayscale')}
                  height={16}
                  src={m.icon}
                  width={16}
                />
              ) : (
                <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="3 6 5 6 21 6" /><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2" />
                </svg>
              )}
              {m.label}
            </button>
          )
        })}
      </div>

      {/* Selection type toggle — only in select mode */}
      {mode === 'select' && (
        <div className="flex gap-1">
          <button
            className={cn(
              'flex flex-1 items-center justify-center gap-1.5 rounded-lg px-2 py-1.5 font-medium text-[11px] transition-all border',
              isMarqueeActive
                ? 'border-blue-500/50 bg-blue-500/20 text-blue-300'
                : 'border-border/40 text-muted-foreground hover:bg-accent/40'
            )}
            onClick={() => emitter.emit('floorplan:toggle-marquee' as any)}
            title={isMarqueeActive ? 'Switch to click select' : 'Switch to marquee select (drag to select multiple)'}
            type="button"
          >
            <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="3" width="18" height="18" rx="1" strokeDasharray="4 2" />
            </svg>
            {isMarqueeActive ? 'Marquee On' : 'Marquee Select'}
          </button>
        </div>
      )}

      {/* Drawing tools — only visible in Draw mode */}
      {mode === 'build' && (
      <div className="flex gap-1">
          {TOOLS.map((t) => {
            const isActive = mode === 'build' && tool === t.id
            return (
              <button
                key={t.id}
                className={cn(
                  'flex flex-1 flex-col items-center gap-1 rounded-lg px-2 py-2 transition-all',
                  isActive
                    ? 'bg-accent text-foreground shadow-sm'
                    : 'text-muted-foreground opacity-70 grayscale hover:bg-accent/60 hover:opacity-100 hover:grayscale-0',
                )}
                onClick={() => {
                  useEditor.getState().setPhase('structure')
                  useEditor.getState().setStructureLayer(t.id === 'zone' ? 'zones' : 'elements')
                  useEditor.getState().setCatalogCategory(null)
                  setMode('build')
                  setTool(t.id)
                }}
                title={t.label}
                type="button"
              >
                <NextImage
                  alt={t.label}
                  className="h-5 w-5 object-contain"
                  height={20}
                  src={t.icon}
                  width={20}
                />
                <span className="text-[10px] font-medium">{t.label}</span>
              </button>
            )
          })}
        </div>
      )}



      {/* Symbol Catalog — grouped fixtures & furniture */}
      <div className="space-y-0.5">
        <span className="text-[10px] font-semibold text-muted-foreground/60 uppercase tracking-wider">Symbols</span>
        <SymbolCatalog />
      </div>

      {/* Generate 3D Model — primary action */}
      <button
        className="flex w-full items-center justify-center gap-1.5 rounded-lg border border-teal-500/40 bg-teal-500/10 px-2 py-2 font-semibold text-teal-300 text-xs transition-colors hover:bg-teal-500/20 hover:border-teal-500/50"
        onClick={downloadJSON}
        title="Generate 3D model from your floor plan"
        type="button"
      >
        <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 2L2 7l10 5 10-5-10-5z" />
          <path d="M2 17l10 5 10-5" />
          <path d="M2 12l10 5 10-5" />
        </svg>
        Generate 3D Model
      </button>

      {/* Download dropdown */}
      <div className="relative">
        <button
          className="flex w-full items-center justify-center gap-1.5 rounded-lg border border-border/40 bg-accent/30 px-2 py-1.5 font-medium text-muted-foreground text-xs transition-colors hover:bg-accent hover:text-foreground"
          onClick={() => setShowDownloadMenu(!showDownloadMenu)}
          title="Download floor plan"
          type="button"
        >
          <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" />
            <polyline points="7 10 12 15 17 10" />
            <line x1="12" y1="15" x2="12" y2="3" />
          </svg>
          Download
          <svg className={cn('h-3 w-3 transition-transform', showDownloadMenu && 'rotate-180')} fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
          </svg>
        </button>
        {showDownloadMenu && (
          <div className="mt-1 rounded-lg border border-border/50 bg-background/95 shadow-lg overflow-hidden">
            <button
              className="flex w-full items-center gap-2 px-3 py-2 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              onClick={() => { exportPDF(); setShowDownloadMenu(false) }}
              type="button"
            >
              <svg className="h-3.5 w-3.5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
                <polyline points="14 2 14 8 20 8" />
              </svg>
              PDF
              <span className="ml-auto text-[9px] text-muted-foreground/50">Print-ready</span>
            </button>
            <button
              className="flex w-full items-center gap-2 px-3 py-2 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              onClick={() => { exportSVG(); setShowDownloadMenu(false) }}
              type="button"
            >
              <svg className="h-3.5 w-3.5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="3" width="18" height="18" rx="2" />
                <path d="M7 12h10" />
              </svg>
              SVG
              <span className="ml-auto text-[9px] text-muted-foreground/50">Vector</span>
            </button>
            <button
              className="flex w-full items-center gap-2 px-3 py-2 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              onClick={() => { downloadJSON(); setShowDownloadMenu(false) }}
              type="button"
            >
              <svg className="h-3.5 w-3.5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                <path d="M16 18l2-2-2-2" /><path d="M8 18l-2-2 2-2" />
                <path d="M12 10v8" />
              </svg>
              JSON
              <span className="ml-auto text-[9px] text-muted-foreground/50">Data</span>
            </button>
          </div>
        )}
      </div>

      {/* Templates — only show when canvas is empty */}
      {wallCount === 0 && (
        <div className="space-y-1">
          <span className="text-[10px] font-semibold text-muted-foreground/60 uppercase tracking-wider">Start from template</span>
          <div className="grid grid-cols-2 gap-1">
            {TEMPLATES.map((t) => (
              <button
                key={t.id}
                className="flex flex-col items-start rounded-lg border border-border/30 bg-accent/20 px-2 py-1.5 text-left transition-colors hover:bg-accent/50 hover:border-border/50"
                onClick={() => {
                  const scene = t.build()
                  applySceneGraphToEditor(scene)
                  setTimeout(() => emitter.emit('floorplan:reset-view' as any), 300)
                }}
                title={`${t.name} — ${t.description} (${t.area})`}
                type="button"
              >
                <span className="font-medium text-foreground text-[11px]">{t.name}</span>
                <span className="text-[9px] text-muted-foreground/70">{t.area}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Keyboard Shortcuts */}
      <details className="group">
        <summary className="flex cursor-pointer items-center gap-1.5 text-[10px] font-semibold text-muted-foreground/60 uppercase tracking-wider hover:text-muted-foreground">
          <svg className="h-3 w-3 transition-transform group-open:rotate-90" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
          </svg>
          Keyboard Shortcuts
        </summary>
        <div className="mt-1.5 space-y-0.5 text-[10px]">
          {[
            ['V', 'Select mode'],
            ['B', 'Draw mode'],
            ['D', 'Delete mode'],
            ['R / T', 'Rotate CW / CCW'],
            ['Arrow keys', 'Nudge (1cm)'],
            ['Shift + Arrows', 'Nudge (10cm)'],
            ['Ctrl+Z', 'Undo'],
            ['Ctrl+Shift+Z', 'Redo'],
            ['Delete', 'Delete selected'],
            ['Escape', 'Cancel / deselect'],
            ['Shift (while drawing)', 'Free angle (no snap)'],
            ['Scroll', 'Zoom'],
            ['Right-click drag', 'Pan'],
          ].map(([key, action]) => (
            <div key={key} className="flex items-center justify-between px-1 py-0.5">
              <span className="text-muted-foreground/70">{action}</span>
              <kbd className="rounded border border-border/40 bg-accent/30 px-1.5 py-0.5 font-mono text-[9px] text-foreground/80">{key}</kbd>
            </div>
          ))}
        </div>
      </details>

      {showClearModal && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 backdrop-blur-sm">
          <div className="w-80 rounded-2xl border border-border/60 bg-background p-5 shadow-2xl">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-red-500/15 mx-auto mb-3">
              <svg className="h-5 w-5 text-red-400" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                <polyline points="3 6 5 6 21 6" /><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2" />
              </svg>
            </div>
            <h3 className="text-center font-semibold text-foreground text-sm">Clear Canvas?</h3>
            <p className="mt-1.5 text-center text-muted-foreground text-xs leading-relaxed">
              This will delete all walls, doors, and windows on the current level. This cannot be undone.
            </p>
            <div className="mt-4 flex gap-2">
              <button
                className="flex-1 rounded-lg border border-border/50 bg-accent/40 px-3 py-2 font-medium text-foreground text-xs transition-colors hover:bg-accent"
                onClick={() => setShowClearModal(false)}
                type="button"
              >
                Cancel
              </button>
              <button
                className="flex-1 rounded-lg bg-red-500 px-3 py-2 font-medium text-white text-xs transition-colors hover:bg-red-600"
                onClick={handleClearConfirm}
                type="button"
              >
                Yes, Clear All
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

export function AppSidebar({
  appMenuButton,
  sidebarTop,
  settingsPanelProps,
  sitePanelProps,
}: AppSidebarProps) {
  const [activePanel, setActivePanel] = useState<PanelId>('site')

  useEffect(() => {
    const store = useSidebarStore.getState()
    if (store.width <= 288) {
      store.setWidth(432)
    }
  }, [])

  const renderPanelContent = () => {
    switch (activePanel) {
      case 'site':
        return <SitePanel {...sitePanelProps} />
      case 'settings':
        return <SettingsPanel {...settingsPanelProps} />
      default:
        return null
    }
  }

  return (
    <>
      <Sidebar className={cn('dark text-white')} variant="floating">
        <div className="flex h-full">
          {/* Icon Rail */}
          <IconRail
            activePanel={activePanel}
            appMenuButton={appMenuButton}
            onPanelChange={setActivePanel}
          />

          {/* Panel Content */}
          <div className="flex flex-1 flex-col overflow-hidden">
            {sidebarTop && (
              <SidebarHeader className="relative flex-col items-start justify-center gap-1 border-border/50 border-b px-3 py-3">
                {sidebarTop}
              </SidebarHeader>
            )}

            {/* Drawing tools + Reset View */}
            <SidebarToolbar />

            <SidebarContent className={cn('no-scrollbar flex flex-1 flex-col overflow-hidden')}>
              {renderPanelContent()}
            </SidebarContent>
          </div>
        </div>
      </Sidebar>
      <EditorCommands />
      <CommandPalette />
    </>
  )
}
