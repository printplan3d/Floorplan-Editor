'use client'

import type { TemporalState } from 'zundo'
import { temporal } from 'zundo'
import { create, type StoreApi, type UseBoundStore } from 'zustand'
import { BuildingNode } from '../schema'
import type { Collection, CollectionId } from '../schema/collections'
import { generateCollectionId } from '../schema/collections'
import {
  type FinishesState,
  type Region,
  type RegionId,
  type Scheme,
  type SchemeId,
  makeDefaultFinishes,
  makeEmptyScheme,
} from '../schema/finishes'
import { LevelNode } from '../schema/nodes/level'
import { SiteNode } from '../schema/nodes/site'
import type { AnyNode, AnyNodeId } from '../schema/types'
import * as nodeActions from './actions/node-actions'

function migrateNodes(nodes: Record<string, any>): Record<string, AnyNode> {
  const patchedNodes = { ...nodes }
  for (const [id, node] of Object.entries(patchedNodes)) {
    // 1. Item scale migration
    if (node.type === 'item' && !('scale' in node)) {
      patchedNodes[id] = { ...node, scale: [1, 1, 1] }
    }
    // 2. Old roof to new roof + segment migration
    if (node.type === 'roof' && !('children' in node)) {
      const oldRoof = node
      const suffix = id.includes('_') ? id.split('_')[1] : Math.random().toString(36).slice(2)
      const segmentId = `rseg_${suffix}`

      const segment = {
        object: 'node',
        id: segmentId,
        type: 'roof-segment',
        parentId: id,
        visible: oldRoof.visible ?? true,
        metadata: {},
        position: [0, 0, 0],
        rotation: 0,
        roofType: 'gable',
        width: oldRoof.length ?? 8,
        depth: (oldRoof.leftWidth ?? 2.2) + (oldRoof.rightWidth ?? 2.2),
        wallHeight: 0,
        roofHeight: oldRoof.height ?? 2.5,
        wallThickness: 0.1,
        deckThickness: 0.1,
        overhang: 0.3,
        shingleThickness: 0.05,
      }

      patchedNodes[segmentId] = segment
      patchedNodes[id] = {
        ...oldRoof,
        children: [segmentId],
      }
    }
  }
  return patchedNodes as Record<string, AnyNode>
}

export type SceneState = {
  // 1. The Data: A flat dictionary of all nodes
  nodes: Record<AnyNodeId, AnyNode>

  // 2. The Root: Which nodes are at the top level?
  rootNodeIds: AnyNodeId[]

  // 3. The "Dirty" Set: For the Wall/Physics systems
  dirtyNodes: Set<AnyNodeId>

  // 4. Relational metadata — not nodes
  collections: Record<CollectionId, Collection>

  // 5. Per-surface finishes (D2). Not nodes — parallel metadata that
  // maps to Project.furniture_scene.schemes on the backend. Shape frozen
  // in D:/Planprint3d Cursor/PER_SURFACE_FINISHES_STORAGE_SPEC.md.
  finishes: FinishesState

  // Actions
  loadScene: () => void
  clearScene: () => void
  unloadScene: () => void
  setScene: (nodes: Record<AnyNodeId, AnyNode>, rootNodeIds: AnyNodeId[]) => void
  setFinishes: (finishes: FinishesState) => void

  markDirty: (id: AnyNodeId) => void
  clearDirty: (id: AnyNodeId) => void

  createNode: (node: AnyNode, parentId?: AnyNodeId) => void
  createNodes: (ops: { node: AnyNode; parentId?: AnyNodeId }[]) => void

  updateNode: (id: AnyNodeId, data: Partial<AnyNode>) => void
  updateNodes: (updates: { id: AnyNodeId; data: Partial<AnyNode> }[]) => void

  deleteNode: (id: AnyNodeId) => void
  deleteNodes: (ids: AnyNodeId[]) => void

  // Collection actions
  createCollection: (name: string, nodeIds?: AnyNodeId[]) => CollectionId
  deleteCollection: (id: CollectionId) => void
  updateCollection: (id: CollectionId, data: Partial<Omit<Collection, 'id'>>) => void
  addToCollection: (id: CollectionId, nodeId: AnyNodeId) => void
  removeFromCollection: (id: CollectionId, nodeId: AnyNodeId) => void

  // Finishes actions (D2). Non-destructive on legacy plans: a scene
  // loaded with no `finishes` state gets a synthesised 'default' scheme
  // via setScene / loadScene.
  setActiveScheme: (id: SchemeId) => void
  createScheme: (name: string, fromSchemeId?: SchemeId) => SchemeId
  renameScheme: (id: SchemeId, name: string) => void
  deleteScheme: (id: SchemeId) => void
  setSchemeGlobalWall: (id: SchemeId, materialId: string | null) => void
  setSchemeGlobalFloor: (id: SchemeId, materialId: string | null) => void
  setSchemeOverride: (
    id: SchemeId,
    scope: string,      // "obj:<name>" or "room:<id>"
    slot: string,       // "wall_interior" | "floor_default" | ...
    materialId: string | null,
  ) => void
  upsertRegion: (schemeId: SchemeId, region: Region) => void
  deleteRegion: (schemeId: SchemeId, regionId: RegionId) => void
}

// type PartializedStoreState = Pick<SceneState, 'rootNodeIds' | 'nodes'>;

type UseSceneStore = UseBoundStore<StoreApi<SceneState>> & {
  temporal: StoreApi<TemporalState<Pick<SceneState, 'nodes' | 'rootNodeIds' | 'collections'>>>
}

const useScene: UseSceneStore = create<SceneState>()(
  temporal(
    (set, get) => ({
      // 1. Flat dictionary of all nodes
      nodes: {},

      // 2. Root node IDs
      rootNodeIds: [],

      // 3. Dirty set
      dirtyNodes: new Set<AnyNodeId>(),

      // 4. Collections
      collections: {} as Record<CollectionId, Collection>,

      // 5. Finishes (D2)
      finishes: makeDefaultFinishes(),

      unloadScene: () => {
        // Clear temporal tracking to prevent memory leaks from stale node references
        prevPastLength = 0
        prevFutureLength = 0
        prevNodesSnapshot = null

        set({
          nodes: {},
          rootNodeIds: [],
          dirtyNodes: new Set<AnyNodeId>(),
          collections: {},
          finishes: makeDefaultFinishes(),
        })
      },

      clearScene: () => {
        get().unloadScene()
        get().loadScene() // Default scene
      },

      setScene: (nodes, rootNodeIds) => {
        // Apply backward compatibility migrations
        const patchedNodes = migrateNodes(nodes)

        set({
          nodes: patchedNodes,
          rootNodeIds,
          dirtyNodes: new Set<AnyNodeId>(),
          collections: {},
          // Reset finishes on new scene load — the plan being loaded
          // brings its own via setFinishes if it has any (called after
          // setScene by the loader).
          finishes: makeDefaultFinishes(),
        })
        // Mark all nodes as dirty to trigger re-validation
        Object.values(patchedNodes).forEach((node) => {
          get().markDirty(node.id)
        })
      },

      setFinishes: (finishes) => {
        // Sanity: ensure `active` refers to an existing set; fall back
        // to the first key, then to a fresh default.
        const setsKeys = Object.keys(finishes.sets) as SchemeId[]
        if (setsKeys.length === 0) {
          set({ finishes: makeDefaultFinishes() })
          return
        }
        const active = setsKeys.includes(finishes.active) ? finishes.active : setsKeys[0]!
        set({ finishes: { active, sets: finishes.sets } })
      },

      loadScene: () => {
        if (get().rootNodeIds.length > 0) {
          // Assign all nodes as dirty to force re-validation
          Object.values(get().nodes).forEach((node) => {
            get().markDirty(node.id)
          })
          return // Scene already loaded
        }

        // Create hierarchy: Site → Building → Level
        const level0 = LevelNode.parse({
          level: 0,
          children: [],
        })

        const building = BuildingNode.parse({
          children: [level0.id],
        })

        const site = SiteNode.parse({
          children: [building],
        })

        // Define all nodes flat
        const nodes: Record<AnyNodeId, AnyNode> = {
          [site.id]: site,
          [building.id]: building,
          [level0.id]: level0,
        }

        // Site is the root
        const rootNodeIds = [site.id]

        set({ nodes, rootNodeIds })
      },

      markDirty: (id) => {
        get().dirtyNodes.add(id)
      },

      clearDirty: (id) => {
        get().dirtyNodes.delete(id)
      },

      createNodes: (ops) => nodeActions.createNodesAction(set, get, ops),
      createNode: (node, parentId) => nodeActions.createNodesAction(set, get, [{ node, parentId }]),

      updateNodes: (updates) => nodeActions.updateNodesAction(set, get, updates),
      updateNode: (id, data) => nodeActions.updateNodesAction(set, get, [{ id, data }]),

      // --- DELETE ---

      deleteNodes: (ids) => nodeActions.deleteNodesAction(set, get, ids),

      deleteNode: (id) => nodeActions.deleteNodesAction(set, get, [id]),

      // --- COLLECTIONS ---

      createCollection: (name, nodeIds = []) => {
        const id = generateCollectionId()
        const collection: Collection = { id, name, nodeIds }
        set((state) => {
          const nextCollections = { ...state.collections, [id]: collection }
          // Denormalize: stamp collectionId onto each node
          const nextNodes = { ...state.nodes }
          for (const nodeId of nodeIds) {
            const node = nextNodes[nodeId]
            if (!node) continue
            const existing =
              ('collectionIds' in node ? (node.collectionIds as CollectionId[]) : undefined) ?? []
            nextNodes[nodeId] = { ...node, collectionIds: [...existing, id] } as AnyNode
          }
          return { collections: nextCollections, nodes: nextNodes }
        })
        return id
      },

      deleteCollection: (id) => {
        set((state) => {
          const col = state.collections[id]
          const nextCollections = { ...state.collections }
          delete nextCollections[id]
          // Remove collectionId from all member nodes
          const nextNodes = { ...state.nodes }
          for (const nodeId of col?.nodeIds ?? []) {
            const node = nextNodes[nodeId]
            if (!(node && 'collectionIds' in node)) continue
            nextNodes[nodeId] = {
              ...node,
              collectionIds: (node.collectionIds as CollectionId[]).filter((cid) => cid !== id),
            } as AnyNode
          }
          return { collections: nextCollections, nodes: nextNodes }
        })
      },

      updateCollection: (id, data) => {
        set((state) => {
          const col = state.collections[id]
          if (!col) return state
          return { collections: { ...state.collections, [id]: { ...col, ...data } } }
        })
      },

      addToCollection: (id, nodeId) => {
        set((state) => {
          const col = state.collections[id]
          if (!col || col.nodeIds.includes(nodeId)) return state
          const nextCollections = {
            ...state.collections,
            [id]: { ...col, nodeIds: [...col.nodeIds, nodeId] },
          }
          const node = state.nodes[nodeId]
          if (!node) return { collections: nextCollections }
          const existing =
            ('collectionIds' in node ? (node.collectionIds as CollectionId[]) : undefined) ?? []
          const nextNodes = {
            ...state.nodes,
            [nodeId]: { ...node, collectionIds: [...existing, id] } as AnyNode,
          }
          return { collections: nextCollections, nodes: nextNodes }
        })
      },

      removeFromCollection: (id, nodeId) => {
        set((state) => {
          const col = state.collections[id]
          if (!col) return state
          const nextCollections = {
            ...state.collections,
            [id]: { ...col, nodeIds: col.nodeIds.filter((n) => n !== nodeId) },
          }
          const node = state.nodes[nodeId]
          if (!(node && 'collectionIds' in node)) return { collections: nextCollections }
          const nextNodes = {
            ...state.nodes,
            [nodeId]: {
              ...node,
              collectionIds: (node.collectionIds as CollectionId[]).filter((cid) => cid !== id),
            } as AnyNode,
          }
          return { collections: nextCollections, nodes: nextNodes }
        })
      },

      // ── Finishes actions (D2) ────────────────────────────────────────
      // All mutations are immutable clones so React re-renders pick them
      // up and the temporal middleware (undo/redo) can snapshot them.
      // `finishes` is deliberately NOT in the temporal partialize list
      // below in this first cut — undo/redo on regions is a v2 feature.

      setActiveScheme: (id) => set((state) => {
        if (!state.finishes.sets[id]) return state
        return { finishes: { ...state.finishes, active: id } }
      }),

      createScheme: (name, fromSchemeId) => {
        const state = get()
        const source = fromSchemeId ? state.finishes.sets[fromSchemeId] : undefined
        const cloned: Scheme = source
          ? { ...source, name, regions: source.regions.map(r => ({ ...r })), overrides: { ...source.overrides } }
          : makeEmptyScheme(name)
        const newId = `scheme_${Math.random().toString(36).slice(2, 10)}` as SchemeId
        set({
          finishes: {
            active: newId,
            sets: { ...state.finishes.sets, [newId]: cloned },
          },
        })
        return newId
      },

      renameScheme: (id, name) => set((state) => {
        const s = state.finishes.sets[id]
        if (!s) return state
        return {
          finishes: {
            ...state.finishes,
            sets: { ...state.finishes.sets, [id]: { ...s, name } },
          },
        }
      }),

      deleteScheme: (id) => set((state) => {
        if (id === 'default') return state // can't delete the default
        if (!state.finishes.sets[id]) return state
        const nextSets = { ...state.finishes.sets }
        delete nextSets[id]
        const active = state.finishes.active === id
          ? (Object.keys(nextSets)[0] as SchemeId ?? 'default')
          : state.finishes.active
        return { finishes: { active, sets: nextSets } }
      }),

      setSchemeGlobalWall: (id, materialId) => set((state) => {
        const s = state.finishes.sets[id]
        if (!s) return state
        return {
          finishes: {
            ...state.finishes,
            sets: { ...state.finishes.sets, [id]: { ...s, wall: materialId } },
          },
        }
      }),

      setSchemeGlobalFloor: (id, materialId) => set((state) => {
        const s = state.finishes.sets[id]
        if (!s) return state
        return {
          finishes: {
            ...state.finishes,
            sets: { ...state.finishes.sets, [id]: { ...s, floor: materialId } },
          },
        }
      }),

      setSchemeOverride: (id, scope, slot, materialId) => set((state) => {
        const s = state.finishes.sets[id]
        if (!s) return state
        const nextOverrides = { ...s.overrides }
        const scopeMap = { ...(nextOverrides[scope] || {}) }
        if (materialId == null) {
          delete scopeMap[slot]
        } else {
          scopeMap[slot] = materialId
        }
        if (Object.keys(scopeMap).length === 0) {
          delete nextOverrides[scope]
        } else {
          nextOverrides[scope] = scopeMap
        }
        return {
          finishes: {
            ...state.finishes,
            sets: { ...state.finishes.sets, [id]: { ...s, overrides: nextOverrides } },
          },
        }
      }),

      upsertRegion: (schemeId, region) => set((state) => {
        const s = state.finishes.sets[schemeId]
        if (!s) return state
        const idx = s.regions.findIndex(r => r.id === region.id)
        const nextRegions = idx >= 0
          ? [...s.regions.slice(0, idx), region, ...s.regions.slice(idx + 1)]
          : [...s.regions, region]
        return {
          finishes: {
            ...state.finishes,
            sets: { ...state.finishes.sets, [schemeId]: { ...s, regions: nextRegions } },
          },
        }
      }),

      deleteRegion: (schemeId, regionId) => set((state) => {
        const s = state.finishes.sets[schemeId]
        if (!s) return state
        return {
          finishes: {
            ...state.finishes,
            sets: {
              ...state.finishes.sets,
              [schemeId]: { ...s, regions: s.regions.filter(r => r.id !== regionId) },
            },
          },
        }
      }),
    }),
    {
      partialize: (state) => {
        const { nodes, rootNodeIds, collections } = state
        return { nodes, rootNodeIds, collections }
      },
      limit: 50, // Limit to last 50 actions
    },
  ),
)

export default useScene

// Track previous temporal state lengths and node snapshot for diffing
let prevPastLength = 0
let prevFutureLength = 0
let prevNodesSnapshot: Record<AnyNodeId, AnyNode> | null = null

/**
 * Clears temporal history tracking variables to prevent memory leaks.
 * Should be called when unloading a scene to release node references.
 */
export function clearTemporalTracking() {
  prevPastLength = 0
  prevFutureLength = 0
  prevNodesSnapshot = null
}

export function clearSceneHistory() {
  useScene.temporal.getState().clear()
  clearTemporalTracking()
}

// Subscribe to the temporal store (Undo/Redo events)
useScene.temporal.subscribe((state) => {
  const currentPastLength = state.pastStates.length
  const currentFutureLength = state.futureStates.length

  // Undo: futureStates increases (state moved from past to future)
  // Redo: pastStates increases while futureStates decreases (state moved from future to past)
  const didUndo = currentFutureLength > prevFutureLength
  const didRedo = currentPastLength > prevPastLength && currentFutureLength < prevFutureLength

  if (didUndo || didRedo) {
    // Capture the previous snapshot before RAF fires
    const snapshotBefore = prevNodesSnapshot

    // Use RAF to ensure all middleware and store updates are complete
    requestAnimationFrame(() => {
      const currentNodes = useScene.getState().nodes
      const { markDirty } = useScene.getState()

      if (snapshotBefore) {
        // Diff: only mark nodes that actually changed
        for (const [id, node] of Object.entries(currentNodes) as [AnyNodeId, AnyNode][]) {
          if (snapshotBefore[id] !== node) {
            markDirty(id)
            // Also mark parent so merged geometries update
            if (node.parentId) markDirty(node.parentId as AnyNodeId)
          }
        }
        // Nodes that were deleted (exist in prev but not current)
        for (const [id, node] of Object.entries(snapshotBefore) as [AnyNodeId, AnyNode][]) {
          if (!currentNodes[id]) {
            const parentId = node.parentId as AnyNodeId | undefined
            if (parentId) {
              markDirty(parentId)
              // Mark sibling nodes dirty so they can update their geometry
              // (e.g. adjacent walls need to recalculate miter/junction geometry)
              const parent = currentNodes[parentId]
              if (parent && 'children' in parent) {
                for (const childId of (parent as AnyNode & { children: string[] }).children) {
                  markDirty(childId as AnyNodeId)
                }
              }
            }
          }
        }
      } else {
        // No snapshot to diff against — fall back to marking all
        for (const node of Object.values(currentNodes)) {
          markDirty(node.id)
        }
      }
    })
  }

  // Update tracked lengths and snapshot
  prevPastLength = currentPastLength
  prevFutureLength = currentFutureLength
  prevNodesSnapshot = useScene.getState().nodes
})
