import { create } from 'zustand'

/**
 * "Add dormer → pick a window" (operator 2026-09-26). While `segId` is set,
 * the next window the operator selects — in the plan or the 3D view — gets a
 * dormer on this roof segment that follows it. DormerWindowPicker does the
 * work; the roof panel only starts it.
 */
type DormerPickState = {
  /** The roof segment the dormer goes on, or null when not picking. */
  segId: string | null
  /** Level to return to afterwards (the roof's), and the one the operator
   *  was on when picking started. */
  roofLevelId: string | null
  /** Last problem to show in the banner (e.g. a window not under the roof). */
  message: string | null
  start: (segId: string, roofLevelId: string | null) => void
  setMessage: (message: string | null) => void
  cancel: () => void
}

export const useDormerPick = create<DormerPickState>((set) => ({
  segId: null,
  roofLevelId: null,
  message: null,
  start: (segId, roofLevelId) => set({ segId, roofLevelId, message: null }),
  setMessage: (message) => set({ message }),
  cancel: () => set({ segId: null, roofLevelId: null, message: null }),
}))
