'use client'

import type { AnyNode } from '@ritn3d/core'
import { create } from 'zustand'

/**
 * "Detect plan" on a level: the host (webapp) runs AI detection on an image
 * and turns the result into editor nodes; the editor drops them onto the
 * level and then lines them up with the storey below.
 *
 * The editor stays host-agnostic -- it never calls an API. When the host
 * passes no detector the Detect button is not shown.
 */
export interface DetectedPlan {
  /** Parents before children. Top-level nodes have parentId = the level. */
  nodes: AnyNode[]
  /** Where the source image goes so it lies under the geometry, or null. */
  guide: { position: [number, number, number]; scale: number } | null
  stats?: { walls: number; doors: number; windows: number }
}

export type PlanDetector = (image: Blob, levelId: string) => Promise<DetectedPlan>

/** Detect-plan dialog state; each step carries the level the button was used on. */
export type DetectDialog =
  | { step: 'closed' }
  /** Only when there is something to ask: which PDF page, replace or add. */
  | { step: 'setup'; levelId: string; file: File; pages: number; hasWalls: boolean }
  | { step: 'working'; levelId: string; message: string }
  | { step: 'error'; levelId: string; message: string }

interface PlanDetectState {
  detector: PlanDetector | null
  setDetector: (fn: PlanDetector | null) => void
  dialog: DetectDialog
  setDialog: (d: DetectDialog) => void
}

export const usePlanDetect = create<PlanDetectState>((set) => ({
  detector: null,
  setDetector: (detector) => set({ detector }),
  dialog: { step: 'closed' },
  setDialog: (dialog) => set({ dialog }),
}))
