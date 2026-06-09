'use client'

import { Editor, useEditor } from '@pascal-app/editor'
import { useEffect } from 'react'

export default function Home() {
  useEffect(() => {
    // Optional dev escape hatch: ?reset=1 wipes Pascal's persisted state.
    // Used to be unconditional, which broke autosave — every refresh nuked
    // the user's work-in-progress. Now opt-in only.
    if (typeof window !== 'undefined' && location.search.includes('reset=1')) {
      try {
        for (const key of Object.keys(localStorage)) {
          if (key.includes('pascal') || key.includes('viewer') || key.includes('editor')) {
            localStorage.removeItem(key)
          }
        }
      } catch {}
    }

    // Force 2D floor plan mode
    useEditor.getState().setPhase('structure')
    useEditor.getState().setStructureLayer('elements')
    useEditor.getState().setMode('build')
    useEditor.getState().setFloorplanOpen(true)
  }, [])

  return (
    <div className="h-screen w-screen">
      <Editor projectId="local-editor" />
    </div>
  )
}
