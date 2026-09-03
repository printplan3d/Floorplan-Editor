'use client'

/*
 * Ritn3D 2026-09-02: Material picker drawer (D5).
 * Slides in from the right when useEditor.materialPickerTarget is set.
 * Fetches the texture catalog from the backend (GET /api/textures/catalog)
 * once per session, filters by target slot (wall vs floor), applies the
 * user's pick to the scheme (or region — routed by target.kind).
 *
 * Non-blocking on purpose (decision #4 in the build plan) — the region
 * the user just drew stays visible on the wall while they browse.
 */

import { useScene } from '@ritn3d/core'
import { useEffect, useState } from 'react'
import useEditor from '../../../store/use-editor'

type CatalogItem = {
  id: string
  category: 'walls' | 'floors'
  name?: string
  path: string           // relative to CDN — the drawer only needs the thumb
  ext?: string
  tile?: number
  thumbUrl?: string      // absolute URL if the backend supplies one
}

type CatalogResponse = {
  version: string | number
  categories: unknown
  items: CatalogItem[]
  defaults?: { wall?: string; floor?: string }
}

/**
 * Reads the API base URL from the same place the rest of the webapp
 * does. Left as an env fallback so a dev without NEXT_PUBLIC_API_BASE
 * can still exercise the drawer against the dev backend.
 */
function apiBase(): string {
  if (typeof window === 'undefined') return ''
  return (
    (window as any).__RITN3D_API_BASE__ ??
    (process as any).env?.NEXT_PUBLIC_API_BASE ??
    ''
  )
}

let _catalogPromise: Promise<CatalogResponse | null> | null = null
async function fetchCatalog(): Promise<CatalogResponse | null> {
  if (_catalogPromise) return _catalogPromise
  _catalogPromise = (async () => {
    try {
      const r = await fetch(`${apiBase()}/api/textures/catalog`, { credentials: 'omit' })
      if (!r.ok) return null
      return (await r.json()) as CatalogResponse
    } catch {
      return null
    }
  })()
  return _catalogPromise
}

export function MaterialPickerDrawer() {
  const target = useEditor((s) => s.materialPickerTarget)
  const setTarget = useEditor((s) => s.setMaterialPickerTarget)

  const setSchemeGlobalWall = useScene((s) => s.setSchemeGlobalWall)
  const setSchemeGlobalFloor = useScene((s) => s.setSchemeGlobalFloor)
  const setSchemeOverride = useScene((s) => s.setSchemeOverride)
  const upsertRegion = useScene((s) => s.upsertRegion)
  const finishes = useScene((s) => s.finishes)

  const [catalog, setCatalog] = useState<CatalogResponse | null>(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!target) return
    if (catalog) return
    setLoading(true)
    fetchCatalog().then((c) => {
      setCatalog(c)
      setLoading(false)
    })
  }, [target, catalog])

  if (!target) return null

  const wantsFloor =
    target.kind === 'global-floor' ||
    (target.kind === 'region' && target.slotHint === 'floor') ||
    (target.kind === 'override' && target.slot.startsWith('floor_'))

  const items: CatalogItem[] = (catalog?.items ?? []).filter((it) =>
    wantsFloor ? it.category === 'floors' : it.category === 'walls',
  )

  const commit = (matId: string) => {
    if (target.kind === 'global-wall') {
      setSchemeGlobalWall(target.schemeId as any, matId)
    } else if (target.kind === 'global-floor') {
      setSchemeGlobalFloor(target.schemeId as any, matId)
    } else if (target.kind === 'override') {
      setSchemeOverride(target.schemeId as any, target.scope, target.slot, matId)
    } else if (target.kind === 'region') {
      const scheme = finishes.sets[target.schemeId as any]
      const region = scheme?.regions.find((r) => r.id === target.regionId)
      if (region) upsertRegion(target.schemeId as any, { ...region, material: matId })
    }
    setTarget(null)
  }

  return (
    <div
      className="pointer-events-auto fixed top-20 right-[360px] z-[60] flex max-h-[calc(100dvh-100px)] w-[280px] flex-col overflow-hidden rounded-md border border-hair bg-paper text-ink shadow-[0_8px_28px_rgba(22,24,28,0.08)]"
    >
      <div className="flex items-center justify-between border-b border-hair px-3 py-2.5">
        <h3 className="font-display text-[13px] font-semibold tracking-[-0.01em]">
          Pick {wantsFloor ? 'floor' : 'wall'} material
        </h3>
        <button
          className="rounded px-1.5 py-0.5 text-[11px] text-ink/60 hover:bg-ink/5 hover:text-ink"
          onClick={() => setTarget(null)}
          type="button"
        >
          Cancel
        </button>
      </div>
      <div className="flex-1 overflow-y-auto p-2">
        {loading && (
          <p className="p-3 text-[11px] text-ink/50">Loading catalog…</p>
        )}
        {!loading && items.length === 0 && (
          <p className="p-3 text-[11px] text-ink/50">
            No {wantsFloor ? 'floor' : 'wall'} materials in the catalog.
          </p>
        )}
        <div className="grid grid-cols-2 gap-2">
          {items.map((it) => (
            <button
              className="flex flex-col overflow-hidden rounded border border-hair bg-paper hover:border-ink/30"
              key={it.id}
              onClick={() => commit(it.id)}
              type="button"
            >
              <div className="aspect-square w-full bg-ink/5" />
              <div className="truncate px-1.5 py-1 text-left text-[10px]">
                {it.name || it.id}
              </div>
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}
