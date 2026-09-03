'use client'

/*
 * Ritn3D 2026-09-02: Finishes panel (D1).
 * Right-sidebar panel for per-surface finishes v2 — shows the active
 * scheme, global wall + floor material, per-object / per-room override
 * list, and per-scheme region count. Reveal for all Pro users (decision
 * #2 in PER_SURFACE_FINISHES_BUILD_PLAN.md).
 *
 * Companion: MaterialPickerDrawer for the actual material choice UI.
 */

import { useScene, type Scheme, type SchemeId } from '@ritn3d/core'
import useEditor from '../../../store/use-editor'
import { PanelWrapper } from './panel-wrapper'

export function FinishesPanel() {
  const finishes = useScene((s) => s.finishes)
  const setActiveScheme = useScene((s) => s.setActiveScheme)
  const createScheme = useScene((s) => s.createScheme)
  const renameScheme = useScene((s) => s.renameScheme)
  const deleteScheme = useScene((s) => s.deleteScheme)
  const deleteRegion = useScene((s) => s.deleteRegion)

  const setPanelOpen = useEditor((s) => s.setFinishesPanelOpen)
  const setPickerTarget = useEditor((s) => s.setMaterialPickerTarget)

  const activeId = finishes.active
  const active: Scheme | undefined = finishes.sets[activeId]

  if (!active) return null

  const schemeIds = Object.keys(finishes.sets) as SchemeId[]

  return (
    <PanelWrapper
      title="Finishes"
      onClose={() => setPanelOpen(false)}
      width={340}
    >
      <div className="flex flex-col gap-4 p-3 text-[13px]">

        {/* Scheme switcher */}
        <div>
          <div className="mb-1 flex items-center justify-between">
            <label className="text-[11px] font-medium uppercase tracking-wider text-ink/60">
              Scheme
            </label>
            <button
              className="text-[11px] text-ink/70 hover:text-ink"
              onClick={() => createScheme(`Scheme ${schemeIds.length + 1}`, activeId)}
              type="button"
              title="Duplicate active scheme"
            >
              + New
            </button>
          </div>
          <select
            className="w-full rounded border border-hair bg-paper px-2 py-1.5 text-ink"
            onChange={(e) => setActiveScheme(e.target.value as SchemeId)}
            value={activeId}
          >
            {schemeIds.map((id) => (
              <option key={id} value={id}>
                {finishes.sets[id]?.name ?? id}
              </option>
            ))}
          </select>
          <div className="mt-2 flex items-center gap-2">
            <input
              className="flex-1 rounded border border-hair bg-paper px-2 py-1 text-[12px]"
              onChange={(e) => renameScheme(activeId, e.target.value)}
              placeholder="Scheme name"
              value={active.name}
            />
            {activeId !== 'default' && (
              <button
                className="rounded px-2 py-1 text-[11px] text-ink/60 hover:bg-ink/5 hover:text-ink"
                onClick={() => deleteScheme(activeId)}
                type="button"
              >
                Delete
              </button>
            )}
          </div>
        </div>

        {/* Global wall + floor */}
        <div>
          <label className="mb-1 block text-[11px] font-medium uppercase tracking-wider text-ink/60">
            Global finishes
          </label>
          <div className="grid grid-cols-2 gap-2">
            <button
              className="rounded border border-hair bg-paper p-2 text-left hover:border-ink/30"
              onClick={() => setPickerTarget({ kind: 'global-wall', schemeId: activeId })}
              type="button"
            >
              <div className="text-[10px] uppercase tracking-wider text-ink/50">Walls</div>
              <div className="mt-0.5 truncate text-[12px] font-medium">
                {active.wall || <span className="text-ink/40">Pick…</span>}
              </div>
            </button>
            <button
              className="rounded border border-hair bg-paper p-2 text-left hover:border-ink/30"
              onClick={() => setPickerTarget({ kind: 'global-floor', schemeId: activeId })}
              type="button"
            >
              <div className="text-[10px] uppercase tracking-wider text-ink/50">Floors</div>
              <div className="mt-0.5 truncate text-[12px] font-medium">
                {active.floor || <span className="text-ink/40">Pick…</span>}
              </div>
            </button>
          </div>
        </div>

        {/* Overrides list */}
        <div>
          <label className="mb-1 block text-[11px] font-medium uppercase tracking-wider text-ink/60">
            Overrides ({Object.keys(active.overrides).length})
          </label>
          {Object.keys(active.overrides).length === 0 ? (
            <p className="text-[11px] text-ink/50">
              Tap a wall or room in the 3D preview to override its finish.
            </p>
          ) : (
            <ul className="space-y-1">
              {Object.entries(active.overrides).map(([scope, slotMap]) => (
                <li className="rounded border border-hair bg-paper p-1.5" key={scope}>
                  <div className="truncate text-[11px] font-medium">{scope}</div>
                  <div className="text-[10px] text-ink/60">
                    {Object.entries(slotMap).map(([slot, mat]) =>
                      `${slot}=${mat}`).join(' · ')}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* Regions list */}
        <div>
          <label className="mb-1 block text-[11px] font-medium uppercase tracking-wider text-ink/60">
            Regions ({active.regions.length})
          </label>
          {active.regions.length === 0 ? (
            <p className="text-[11px] text-ink/50">
              No accent regions yet. Add one with the Region tool in the
              3D preview (D3, coming next).
            </p>
          ) : (
            <ul className="space-y-1">
              {active.regions.map((r) => (
                <li
                  className="flex items-start justify-between gap-2 rounded border border-hair bg-paper p-1.5"
                  key={r.id}
                >
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[11px] font-medium">
                      {r.target.type === 'wall'
                        ? `Wall ${r.target.wall_id} · ${r.target.side}`
                        : `Floor L${r.target.level}${r.target.region_id ? ` · ${r.target.region_id}` : ''}`}
                    </div>
                    <div className="text-[10px] text-ink/60">
                      {r.polygon.length} pts · {r.material}
                    </div>
                  </div>
                  <button
                    className="rounded px-1.5 py-0.5 text-[10px] text-ink/50 hover:bg-ink/5 hover:text-ink"
                    onClick={() => deleteRegion(activeId, r.id)}
                    type="button"
                  >
                    Del
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </PanelWrapper>
  )
}
