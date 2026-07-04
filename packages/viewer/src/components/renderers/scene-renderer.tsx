'use client'

import { useScene } from '@ritn3d/core'
import { NodeRenderer } from './node-renderer'

export const SceneRenderer = () => {
  const rootNodes = useScene((state) => state.rootNodeIds)

  return (
    <group name="scene-renderer">
      {rootNodes.map((nodeId) => (
        <NodeRenderer key={nodeId} nodeId={nodeId} />
      ))}
    </group>
  )
}
