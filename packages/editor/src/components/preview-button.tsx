'use client'

import { ArrowLeft, Eye } from 'lucide-react'
import useEditor from '../store/use-editor'

// Ritn3D 2026-09-23: toggle rather than one-way switch. In 2D mode
// it's the "Preview" CTA that lifts us into isPreviewMode; in
// preview it's the "Back to 2D" return. Same footprint, so the
// operator doesn't have to hunt for two different buttons in two
// different corners.
export function PreviewButton() {
  const isPreviewMode = useEditor((s) => s.isPreviewMode)
  const label = isPreviewMode ? 'Back to 2D' : 'Preview'
  const Icon = isPreviewMode ? ArrowLeft : Eye
  return (
    <button
      type="button"
      className="flex cursor-pointer items-center gap-2 rounded-lg border border-border bg-background/95 px-3 py-2 font-medium text-sm shadow-lg backdrop-blur-md transition-colors hover:bg-accent/90"
      onClick={() => useEditor.getState().setPreviewMode(!isPreviewMode)}
    >
      <Icon className="h-4 w-4 shrink-0" />
      <span className="hidden whitespace-nowrap sm:inline">{label}</span>
    </button>
  )
}
