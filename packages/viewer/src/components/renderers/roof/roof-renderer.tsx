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
 * The empty geometry alone is NOT enough, and an earlier version of
 * this comment was wrong to claim it "raycasts to nothing". drei's
 * <Bvh> builds a boundsTree on EVERY descendant, including this one,
 * so three-mesh-bvh's accelerated path runs instead of three's own
 * Mesh.raycast and its cheap bounding-sphere reject never happens.
 * With an array material it then resolves the hit's material through
 * geometry.groups, and on a geometry with no groups that read is
 * `undefined.materialIndex` → TypeError.
 *
 * Measured on editor-dev: this single mesh threw on 9 of 9 test rays
 * (hasBVH: true, matCount: 4, groups: 0, posCount: 0) and accounted
 * for thousands of console exceptions. Adding one empty group takes
 * it to 0 of 9.
 *
 * So: zero-length position attribute AND one zero-length group, which
 * gives the group lookup something valid to land on. Still raycasts
 * to nothing and still costs nothing.
 */
function makeEmptyRoofPlaceholder(): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.Float32BufferAttribute([], 3))
  g.addGroup(0, 0, 0)
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
