'use client'

import { Editor, useEditor } from '@pascal-app/editor'
import { useEffect } from 'react'

export default function Home() {
  useEffect(() => {
    // Clear old persisted state
    try {
      for (const key of Object.keys(localStorage)) {
        if (key.includes('pascal') || key.includes('viewer') || key.includes('editor')) {
          localStorage.removeItem(key)
        }
      }
    } catch {}

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
