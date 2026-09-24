'use client'

import type { AnyNode, BaseNode, BuildingNode, LevelNode, ZoneNode } from '@ritn3d/core'
import type { Object3D } from 'three'

import { create } from 'zustand'
import { persist } from 'zustand/middleware'

type SelectionPath = {
  buildingId: BuildingNode['id'] | null
  levelId: LevelNode['id'] | null
  zoneId: ZoneNode['id'] | null
  selectedIds: BaseNode['id'][] // For items/assets (multi-select)
}

type Outliner = {
  selectedObjects: Object3D[]
  hoveredObjects: Object3D[]
}

type ViewerState = {
  selection: SelectionPath
  hoveredId: AnyNode['id'] | ZoneNode['id'] | null
  setHoveredId: (id: AnyNode['id'] | ZoneNode['id'] | null) => void

  cameraMode: 'perspective' | 'orthographic'
  setCameraMode: (mode: 'perspective' | 'orthographic') => void

  /**
   * Set the camera mode for real, bypassing the 2D lock that
   * setCameraMode applies.
   *
   * setCameraMode is deliberately pinned to 'orthographic' so the 2D
   * drawing surface can never be tipped into perspective by the view
   * toggles. The 3D preview is the one place that legitimately wants
   * perspective: orthographic has no depth, so "zooming" only scales
   * the picture instead of moving you through the scene, which reads
   * as zoom being tight no matter how wide the limits are.
   *
   * Only the editor's preview toggle should call this, and it must
   * set 'orthographic' back on exit — cameraMode is persisted, so a
   * stray 'perspective' would survive a reload into the 2D editor.
   */
  forceCameraMode: (mode: 'perspective' | 'orthographic') => void

  theme: 'light' | 'dark'
  setTheme: (theme: 'light' | 'dark') => void

  unit: 'metric' | 'imperial'
  setUnit: (unit: 'metric' | 'imperial') => void

  levelMode: 'stacked' | 'exploded' | 'solo' | 'manual'
  setLevelMode: (mode: 'stacked' | 'exploded' | 'solo' | 'manual') => void

  wallMode: 'up' | 'cutaway' | 'down'
  setWallMode: (mode: 'up' | 'cutaway' | 'down') => void

  showScans: boolean
  setShowScans: (show: boolean) => void

  showGuides: boolean
  setShowGuides: (show: boolean) => void

  showGrid: boolean
  setShowGrid: (show: boolean) => void

  projectId: string | null
  setProjectId: (id: string | null) => void
  projectPreferences: Record<
    string,
    { showScans?: boolean; showGuides?: boolean; showGrid?: boolean }
  >

  // Smart selection update
  setSelection: (updates: Partial<SelectionPath>) => void
  resetSelection: () => void

  outliner: Outliner // No setter as we will manipulate directly the arrays

  // Export functionality
  exportScene: ((format?: 'glb' | 'stl' | 'obj') => Promise<void>) | null
  setExportScene: (fn: ((format?: 'glb' | 'stl' | 'obj') => Promise<void>) | null) => void

  debugColors: boolean
  setDebugColors: (enabled: boolean) => void

  /**
   * Render the floating "Room N" name pins over each zone. Default
   * true — share links and the public viewer keep them.
   *
   * The editor's 3D preview turns them off: it's an editing surface,
   * and eight DOM pins sit on top of the geometry you're trying to
   * look at. Gated here rather than deleted from zone-renderer so
   * other surfaces are unaffected.
   */
  showZoneLabels: boolean
  setShowZoneLabels: (enabled: boolean) => void

  cameraDragging: boolean
  setCameraDragging: (dragging: boolean) => void
}

const useViewer = create<ViewerState>()(
  persist(
    (set) => ({
      selection: { buildingId: null, levelId: null, zoneId: null, selectedIds: [] },
      hoveredId: null,
      setHoveredId: (id) => set({ hoveredId: id }),

      cameraMode: 'orthographic',
      setCameraMode: (_mode) => set({ cameraMode: 'orthographic' }), // Ritn3D: locked to 2D top-down
      forceCameraMode: (mode) => set({ cameraMode: mode }),

      theme: 'light',
      setTheme: (theme) => set({ theme }),

      unit: 'metric',
      setUnit: (unit) => set({ unit }),

      levelMode: 'stacked',
      setLevelMode: (mode) => set({ levelMode: mode }),

      wallMode: 'down',
      setWallMode: (_mode) => set({ wallMode: 'down' }), // Ritn3D: 2D floor plan view

      showScans: true,
      setShowScans: (show) =>
        set((state) => {
          const projectPreferences = { ...(state.projectPreferences || {}) }
          if (state.projectId) {
            projectPreferences[state.projectId] = {
              ...(projectPreferences[state.projectId] || {}),
              showScans: show,
            }
          }
          return { showScans: show, projectPreferences }
        }),

      showGuides: true,
      setShowGuides: (show) =>
        set((state) => {
          const projectPreferences = { ...(state.projectPreferences || {}) }
          if (state.projectId) {
            projectPreferences[state.projectId] = {
              ...(projectPreferences[state.projectId] || {}),
              showGuides: show,
            }
          }
          return { showGuides: show, projectPreferences }
        }),

      showGrid: true,
      setShowGrid: (show) =>
        set((state) => {
          const projectPreferences = { ...(state.projectPreferences || {}) }
          if (state.projectId) {
            projectPreferences[state.projectId] = {
              ...(projectPreferences[state.projectId] || {}),
              showGrid: show,
            }
          }
          return { showGrid: show, projectPreferences }
        }),

      projectId: null,
      setProjectId: (id) =>
        set((state) => {
          if (!id) return { projectId: id }
          const prefs = state.projectPreferences?.[id] || {}
          return {
            projectId: id,
            showScans: prefs.showScans ?? true,
            showGuides: prefs.showGuides ?? true,
            showGrid: prefs.showGrid ?? true,
          }
        }),
      projectPreferences: {},

      setSelection: (updates) =>
        set((state) => {
          const newSelection = { ...state.selection, ...updates }

          // Hierarchy Guard: If we change a high-level parent, reset the children unless explicitly provided
          if (updates.buildingId !== undefined) {
            if (updates.levelId === undefined) newSelection.levelId = null
            if (updates.zoneId === undefined) newSelection.zoneId = null
            if (updates.selectedIds === undefined) newSelection.selectedIds = []
          }
          if (updates.levelId !== undefined) {
            if (updates.zoneId === undefined) newSelection.zoneId = null
            if (updates.selectedIds === undefined) newSelection.selectedIds = []
          }
          if (updates.zoneId !== undefined) {
            if (updates.selectedIds === undefined) newSelection.selectedIds = []
          }

          return { selection: newSelection }
        }),

      resetSelection: () =>
        set({
          selection: {
            buildingId: null,
            levelId: null,
            zoneId: null,
            selectedIds: [],
          },
        }),

      outliner: { selectedObjects: [], hoveredObjects: [] },

      exportScene: null,
      setExportScene: (fn) => set({ exportScene: fn }),

      debugColors: false,
      setDebugColors: (enabled) => set({ debugColors: enabled }),

      showZoneLabels: true,
      setShowZoneLabels: (enabled) => set({ showZoneLabels: enabled }),

      cameraDragging: false,
      setCameraDragging: (dragging) => set({ cameraDragging: dragging }),
    }),
    {
      name: 'viewer-preferences',
      partialize: (state) => ({
        cameraMode: state.cameraMode,
        theme: state.theme,
        unit: state.unit,
        levelMode: state.levelMode,
        wallMode: state.wallMode,
        projectPreferences: state.projectPreferences,
      }),
    },
  ),
)

export default useViewer
