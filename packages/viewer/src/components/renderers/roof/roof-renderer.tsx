import { type RoofNode, useRegistry } from '@ritn3d/core'
import { useMemo, useRef } from 'react'
import * as THREE from 'three'
import { useNodeEvents } from '../../../hooks/use-node-events'
import useViewer from '../../../store/use-viewer'
import { NodeRenderer } from '../node-renderer'
import { roofDebugMaterials, roofMaterials } from './roof-materials'

/**
 * Empty placeholder for the merged-roof mesh before RoofSystem fills
 * it in.
 *
 * Must NOT be a BoxGeometry. BoxGeometry ships six groups
 * (materialIndex 0-5, one per cube face) but roofMaterials only has
 * four entries, so three.js's Mesh.raycast reads
 * `materials[4].side` → undefined.side → TypeError. It throws on
 * every raycast against the mesh, which with a SelectionManager
 * mounted means every pointer move, which kills the render loop and
 * blanks the whole 3D scene. (roof-system.tsx already works around
 * this for per-SEGMENT meshes; the merged mesh was missed.)
 *
 * A zero-length position attribute with no groups raycasts to
 * nothing and costs nothing.
 */
function makeEmptyRoofPlaceholder(): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.Float32BufferAttribute([], 3))
  return g
}

export const RoofRenderer = ({ node }: { node: RoofNode }) => {
  const ref = useRef<THREE.Group>(null!)
  const placeholder = useMemo(makeEmptyRoofPlaceholder, [])

  useRegistry(node.id, 'roof', ref)

  const handlers = useNodeEvents(node, 'roof')
  const debugColors = useViewer((s) => s.debugColors)

  return (
    <group
      position={node.position}
      ref={ref}
      rotation-y={node.rotation}
      visible={node.visible}
      {...handlers}
    >
      <mesh
        castShadow
        geometry={placeholder}
        material={debugColors ? roofDebugMaterials : roofMaterials}
        name="merged-roof"
        receiveShadow
      />
      <group name="segments-wrapper" visible={false}>
        {(node.children ?? []).map((childId) => (
          <NodeRenderer key={childId} nodeId={childId} />
        ))}
      </group>
    </group>
  )
}
