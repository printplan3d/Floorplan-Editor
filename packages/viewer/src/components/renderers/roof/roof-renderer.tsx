import { type RoofNode, useRegistry, useScene } from '@ritn3d/core'
import { useMemo, useRef } from 'react'
import * as THREE from 'three'
import { useNodeEvents } from '../../../hooks/use-node-events'
import useViewer from '../../../store/use-viewer'
import { getLevelHeight } from '../../../systems/level/level-utils'
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
  const nodes = useScene((s) => s.nodes)

  /**
   * Lift the roof to the top of its storey's walls.
   *
   * The backend has always placed roofs at
   *     base_z = storey_elev + storey_height + wall_h
   * (see computeAutoRoofHeight's note, and
   * api/editor_scene_translator_dev.py). The preview only ever had
   * two of those three terms: LevelSystem contributes storey_elev by
   * moving the LEVEL group, and the shell adds wall_h as baseZ. The
   * storey_height term was simply missing.
   *
   * On a single-storey plan storey_elev is 0, so a roof authored with
   * the correct wall_h of 0 rendered at Y=0 — sitting on the ground.
   * That is the "why are some roofs on the floor" report; the data was
   * right and the preview was wrong. Measured on the operator's plan:
   * all three roof groups had world Y exactly 0.
   *
   * wall_h stays what its schema says it is — a PARAPET, stacked above
   * the wall top, per the operator: "All roofs must sit on the lower
   * level wall. If parapet is added, that will be above the walls."
   *
   * Multi-storey still works: a roof on L1 gets L0's height from
   * LevelSystem plus L1's height from here, landing on L1's walls.
   */
  const storeyTop = useMemo(() => {
    const levelId = (node as { parentId?: string }).parentId
    if (!levelId) return 0
    const level = nodes[levelId as keyof typeof nodes]
    if (!level || (level as { type?: string }).type !== 'level') return 0
    return getLevelHeight(levelId as never, nodes as never)
  }, [node, nodes])

  useRegistry(node.id, 'roof', ref)

  const handlers = useNodeEvents(node, 'roof')
  const debugColors = useViewer((s) => s.debugColors)

  return (
    <group
      position={[node.position[0], node.position[1] + storeyTop, node.position[2]]}
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
