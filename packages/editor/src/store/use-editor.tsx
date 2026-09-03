'use client'

import type { AssetInput } from '@ritn3d/core'
import {
  type BuildingNode,
  type DoorNode,
  type ItemNode,
  type LevelNode,
  type RoofNode,
  type RoofSegmentNode,
  type SlabSurfaceType,
  type Space,
  useScene,
  type WindowNode,
} from '@ritn3d/core'
import { useViewer } from '@ritn3d/viewer'
import { create } from 'zustand'
import { persist } from 'zustand/middleware'

export type Phase = 'site' | 'structure' | 'furnish'

export type Mode = 'select' | 'edit' | 'delete' | 'build'

// Structure mode tools (building elements)
export type StructureTool =
  | 'wall'
  | 'arc-wall'
  | 'room'
  | 'custom-room'
  | 'slab'
  | 'ceiling'
  | 'roof'
  | 'column'
  | 'stair'
  | 'item'
  | 'zone'
  | 'window'
  | 'door'

// Furnish mode tools (items and decoration)
export type FurnishTool = 'item'

// Site mode tools
export type SiteTool = 'property-line'

// Catalog categories for furnish mode items
export type CatalogCategory =
  | 'furniture'
  | 'appliance'
  | 'bathroom'
  | 'kitchen'
  | 'outdoor'
  | 'window'
  | 'door'

export type StructureLayer = 'zones' | 'elements'

// Combined tool type
export type Tool = SiteTool | StructureTool | FurnishTool

type EditorState = {
  phase: Phase
  setPhase: (phase: Phase) => void
  mode: Mode
  setMode: (mode: Mode) => void
  tool: Tool | null
  setTool: (tool: Tool | null) => void
  structureLayer: StructureLayer
  setStructureLayer: (layer: StructureLayer) => void
  catalogCategory: CatalogCategory | null
  setCatalogCategory: (category: CatalogCategory | null) => void
  selectedItem: AssetInput | null
  setSelectedItem: (item: AssetInput) => void
  movingNode: ItemNode | WindowNode | DoorNode | RoofNode | RoofSegmentNode | null
  setMovingNode: (
    node: ItemNode | WindowNode | DoorNode | RoofNode | RoofSegmentNode | null,
  ) => void
  selectedReferenceId: string | null
  setSelectedReferenceId: (id: string | null) => void
  // Space detection for cutaway mode
  spaces: Record<string, Space>
  setSpaces: (spaces: Record<string, Space>) => void
  // Generic hole editing (works for slabs, ceilings, and any future polygon nodes)
  editingHole: { nodeId: string; holeIndex: number } | null
  setEditingHole: (hole: { nodeId: string; holeIndex: number } | null) => void
  // Preview mode (viewer-like experience inside the editor)
  isPreviewMode: boolean
  setPreviewMode: (preview: boolean) => void
  // Toggleable 2D floorplan overlay
  isFloorplanOpen: boolean
  setFloorplanOpen: (open: boolean) => void
  toggleFloorplanOpen: () => void
  isFloorplanHovered: boolean
  setFloorplanHovered: (hovered: boolean) => void
  // Development-only camera debug flag for inspecting underside geometry
  allowUndergroundCamera: boolean
  setAllowUndergroundCamera: (enabled: boolean) => void
  // Ritn3D 2026-06-18: surface type the next-created slab should adopt.
  // Outdoor surface tools (patio/deck/driveway/...) set this before
  // activating the slab tool. Reset to 'interior' on tool change.
  pendingSlabSurfaceType: SlabSurfaceType
  setPendingSlabSurfaceType: (t: SlabSurfaceType) => void
  // Ritn3D 2026-07-27: persistent grid-snap + ortho toggles. Shift key
  // still works as a per-instance override (XOR with the toggle) so
  // users can temporarily flip either during a single drag without
  // losing their preferred default. Both default true.
  gridSnapEnabled: boolean
  setGridSnapEnabled: (enabled: boolean) => void
  orthoEnabled: boolean
  setOrthoEnabled: (enabled: boolean) => void
  // Ritn3D 2026-09-02 (D1): Finishes panel visibility. When true, the
  // right-sidebar shows the FinishesPanel (per-surface finishes v2).
  // Persisted through the same UI-preferences store as the other panel
  // toggles.
  isFinishesPanelOpen: boolean
  setFinishesPanelOpen: (open: boolean) => void
  // Ritn3D 2026-09-02 (D5): material picker drawer state. Opens with the
  // slot the picker is picking for so the caller (region tool, scheme
  // panel) can wire the result. `null` = closed.
  materialPickerTarget:
    | null
    | { kind: 'global-wall'; schemeId: string }
    | { kind: 'global-floor'; schemeId: string }
    | { kind: 'region'; schemeId: string; regionId: string; slotHint: 'wall' | 'floor' }
    | { kind: 'override'; schemeId: string; scope: string; slot: string }
  setMaterialPickerTarget: (t: EditorState['materialPickerTarget']) => void
}

export type PersistedEditorUiState = Pick<
  EditorState,
  'phase' | 'mode' | 'tool' | 'structureLayer' | 'catalogCategory' | 'isFloorplanOpen'
  | 'gridSnapEnabled' | 'orthoEnabled'
>

export const DEFAULT_PERSISTED_EDITOR_UI_STATE: PersistedEditorUiState = {
  phase: 'site',
  mode: 'select',
  tool: null,
  structureLayer: 'elements',
  catalogCategory: null,
  isFloorplanOpen: true,
  gridSnapEnabled: true,
  orthoEnabled: true,
}

function normalizeModeForPhase(phase: Phase, mode: Mode | undefined): Mode {
  if (phase === 'site') {
    return mode === 'edit' ? 'edit' : 'select'
  }

  return mode === 'build' || mode === 'delete' ? mode : 'select'
}

export function normalizePersistedEditorUiState(
  state: Partial<PersistedEditorUiState> | null | undefined,
): PersistedEditorUiState {
  const phase = state?.phase === 'structure' || state?.phase === 'furnish' ? state.phase : 'site'
  const mode = normalizeModeForPhase(phase, state?.mode)
  const isFloorplanOpen = Boolean(state?.isFloorplanOpen)
  // 2026-07-27: default true when not stored (first-run + legacy users
  // both get the same on-by-default behavior as pre-toggle days).
  const gridSnapEnabled = state?.gridSnapEnabled ?? true
  const orthoEnabled = state?.orthoEnabled ?? true

  if (phase === 'site') {
    return {
      ...DEFAULT_PERSISTED_EDITOR_UI_STATE,
      phase,
      mode,
      isFloorplanOpen,
      gridSnapEnabled,
      orthoEnabled,
    }
  }

  if (phase === 'furnish') {
    return {
      phase,
      mode,
      tool: mode === 'build' ? 'item' : null,
      structureLayer: 'elements',
      catalogCategory: mode === 'build' ? (state?.catalogCategory ?? 'furniture') : null,
      isFloorplanOpen,
      gridSnapEnabled,
      orthoEnabled,
    }
  }

  const structureLayer = state?.structureLayer === 'zones' ? 'zones' : 'elements'

  if (mode !== 'build') {
    return {
      phase,
      mode,
      tool: null,
      structureLayer,
      catalogCategory: null,
      isFloorplanOpen,
      gridSnapEnabled,
      orthoEnabled,
    }
  }

  if (structureLayer === 'zones') {
    return {
      phase,
      mode,
      tool: 'zone',
      structureLayer,
      catalogCategory: null,
      isFloorplanOpen,
      gridSnapEnabled,
      orthoEnabled,
    }
  }

  return {
    phase,
    mode,
    tool:
      state?.tool && state.tool !== 'property-line' && state.tool !== 'zone' ? state.tool : 'wall',
    structureLayer,
    catalogCategory: state?.tool === 'item' ? (state.catalogCategory ?? null) : null,
    isFloorplanOpen,
    gridSnapEnabled,
    orthoEnabled,
  }
}

export function hasCustomPersistedEditorUiState(
  state: Partial<PersistedEditorUiState> | null | undefined,
): boolean {
  const normalizedState = normalizePersistedEditorUiState(state)

  return (
    normalizedState.phase !== DEFAULT_PERSISTED_EDITOR_UI_STATE.phase ||
    normalizedState.mode !== DEFAULT_PERSISTED_EDITOR_UI_STATE.mode ||
    normalizedState.tool !== DEFAULT_PERSISTED_EDITOR_UI_STATE.tool ||
    normalizedState.structureLayer !== DEFAULT_PERSISTED_EDITOR_UI_STATE.structureLayer ||
    normalizedState.catalogCategory !== DEFAULT_PERSISTED_EDITOR_UI_STATE.catalogCategory ||
    normalizedState.isFloorplanOpen !== DEFAULT_PERSISTED_EDITOR_UI_STATE.isFloorplanOpen ||
    normalizedState.gridSnapEnabled !== DEFAULT_PERSISTED_EDITOR_UI_STATE.gridSnapEnabled ||
    normalizedState.orthoEnabled !== DEFAULT_PERSISTED_EDITOR_UI_STATE.orthoEnabled
  )
}

const useEditor = create<EditorState>()(
  persist(
    (set, get) => ({
      phase: DEFAULT_PERSISTED_EDITOR_UI_STATE.phase,
      setPhase: (phase) => {
        const currentPhase = get().phase
        if (currentPhase === phase) return

        set({ phase })

        const { mode, structureLayer } = get()

        if (mode === 'build') {
          // Stay in build mode, select the first tool for the new phase
          if (phase === 'site') {
            set({ tool: 'property-line', catalogCategory: null })
          } else if (phase === 'structure' && structureLayer === 'zones') {
            set({ tool: 'zone', catalogCategory: null })
          } else if (phase === 'structure') {
            set({ tool: 'wall', catalogCategory: null })
          } else if (phase === 'furnish') {
            set({ tool: 'item', catalogCategory: 'furniture' })
          }
        } else {
          // Reset to select mode and clear tool/catalog when switching phases
          set({ mode: 'select', tool: null, catalogCategory: null })
        }

        const viewer = useViewer.getState()
        const scene = useScene.getState()

        // Helper to find building and level 0
        const selectBuildingAndLevel0 = () => {
          let buildingId = viewer.selection.buildingId

          // If no building selected, find the first one from site's children
          if (!buildingId) {
            const siteNode = scene.rootNodeIds[0] ? scene.nodes[scene.rootNodeIds[0]] : null
            if (siteNode?.type === 'site') {
              const firstBuilding = siteNode.children
                .map((child) => (typeof child === 'string' ? scene.nodes[child] : child))
                .find((node) => node?.type === 'building')
              if (firstBuilding) {
                buildingId = firstBuilding.id as BuildingNode['id']
                viewer.setSelection({ buildingId })
              }
            }
          }

          // If no level selected, find level 0 in the building
          if (buildingId && !viewer.selection.levelId) {
            const buildingNode = scene.nodes[buildingId] as BuildingNode
            const level0Id = buildingNode.children.find((childId) => {
              const levelNode = scene.nodes[childId] as LevelNode
              return levelNode?.type === 'level' && levelNode.level === 0
            })
            if (level0Id) {
              viewer.setSelection({ levelId: level0Id as LevelNode['id'] })
            } else if (buildingNode.children[0]) {
              // Fallback to first level if level 0 doesn't exist
              viewer.setSelection({ levelId: buildingNode.children[0] as LevelNode['id'] })
            }
          }
        }

        switch (phase) {
          case 'site':
            // Ritn3D 2026-07-13: intentionally DO NOT call
            // viewer.resetSelection() here. It used to zoom out + drop
            // the levelId when clicking the Site header — which made
            // sidebar wallCount fall to 0 and the "Start from template"
            // panel reappear, so the user believed their plan had been
            // wiped and couldn't find a way back. Keeping the level
            // selection means the walls stay drawn on the canvas while
            // the user browses the site tree; going back to structure
            // is now a no-op instead of a fresh building/level lookup.
            break

          case 'structure':
            selectBuildingAndLevel0()
            break

          case 'furnish':
            selectBuildingAndLevel0()
            // Furnish mode only supports elements layer, not zones
            set({ structureLayer: 'elements' })
            break
        }
      },
      mode: DEFAULT_PERSISTED_EDITOR_UI_STATE.mode,
      setMode: (mode) => {
        set({ mode })

        const { phase, structureLayer, tool } = get()

        if (mode === 'build') {
          // Ensure a tool is selected in build mode
          if (!tool) {
            if (phase === 'structure' && structureLayer === 'zones') {
              set({ tool: 'zone' })
            } else if (phase === 'structure' && structureLayer === 'elements') {
              set({ tool: 'wall' })
            } else if (phase === 'furnish') {
              set({ tool: 'item', catalogCategory: 'furniture' })
            }
          }
        }
        // When leaving build mode, clear tool
        else if (tool) {
          set({ tool: null })
        }
      },
      tool: DEFAULT_PERSISTED_EDITOR_UI_STATE.tool,
      setTool: (tool) => set({ tool }),
      structureLayer: DEFAULT_PERSISTED_EDITOR_UI_STATE.structureLayer,
      setStructureLayer: (layer) => {
        const { mode } = get()

        if (mode === 'build') {
          const tool = layer === 'zones' ? 'zone' : 'wall'
          set({ structureLayer: layer, tool })
        } else {
          set({ structureLayer: layer, mode: 'select', tool: null })
        }

        const viewer = useViewer.getState()
        viewer.setSelection({
          selectedIds: [],
          zoneId: null,
        })
      },
      catalogCategory: DEFAULT_PERSISTED_EDITOR_UI_STATE.catalogCategory,
      setCatalogCategory: (category) => set({ catalogCategory: category }),
      selectedItem: null,
      setSelectedItem: (item) => set({ selectedItem: item }),
      movingNode: null as ItemNode | WindowNode | DoorNode | RoofNode | RoofSegmentNode | null,
      setMovingNode: (node) => set({ movingNode: node }),
      selectedReferenceId: null,
      setSelectedReferenceId: (id) => set({ selectedReferenceId: id }),
      spaces: {},
      setSpaces: (spaces) => set({ spaces }),
      editingHole: null,
      setEditingHole: (hole) => set({ editingHole: hole }),
      isPreviewMode: false,
      setPreviewMode: (preview) => {
        if (preview) {
          set({ isPreviewMode: true, mode: 'select', tool: null, catalogCategory: null })
          // Clear zone/item selection for clean viewer drill-down hierarchy
          useViewer.getState().setSelection({ selectedIds: [], zoneId: null })
        } else {
          set({ isPreviewMode: false })
        }
      },
      isFloorplanOpen: DEFAULT_PERSISTED_EDITOR_UI_STATE.isFloorplanOpen,
      setFloorplanOpen: (open) => set({ isFloorplanOpen: open }),
      toggleFloorplanOpen: () => set((state) => ({ isFloorplanOpen: !state.isFloorplanOpen })),
      isFloorplanHovered: false,
      setFloorplanHovered: (hovered) => set({ isFloorplanHovered: hovered }),
      allowUndergroundCamera: false,
      setAllowUndergroundCamera: (enabled) => set({ allowUndergroundCamera: enabled }),
      pendingSlabSurfaceType: 'interior' as SlabSurfaceType,
      setPendingSlabSurfaceType: (t) => set({ pendingSlabSurfaceType: t }),

      // 2026-07-27: snap + ortho persistent toggles. Both default on.
      gridSnapEnabled: true,
      setGridSnapEnabled: (enabled) => set({ gridSnapEnabled: enabled }),
      orthoEnabled: true,
      setOrthoEnabled: (enabled) => set({ orthoEnabled: enabled }),

      // 2026-09-02: Finishes panel + material picker drawer.
      isFinishesPanelOpen: false,
      setFinishesPanelOpen: (open) => set({ isFinishesPanelOpen: open }),
      materialPickerTarget: null,
      setMaterialPickerTarget: (t) => set({ materialPickerTarget: t }),
    }),
    {
      name: 'pascal-editor-ui-preferences',
      merge: (persistedState, currentState) => ({
        ...currentState,
        ...normalizePersistedEditorUiState(persistedState as Partial<PersistedEditorUiState>),
      }),
      partialize: (state) => ({
        phase: state.phase,
        mode: state.mode,
        tool: state.tool,
        structureLayer: state.structureLayer,
        catalogCategory: state.catalogCategory,
        isFloorplanOpen: state.isFloorplanOpen,
        gridSnapEnabled: state.gridSnapEnabled,
        orthoEnabled: state.orthoEnabled,
        isFinishesPanelOpen: state.isFinishesPanelOpen,
      }),
    },
  ),
)

export default useEditor
