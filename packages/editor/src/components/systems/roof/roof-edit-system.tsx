import {
  type AnyNodeId,
  getRoofContext,
  roofMeshesForExport,
  sceneRegistry,
  useScene,
} from '@ritn3d/core'
import { useViewer } from '@ritn3d/viewer'
import { useEffect, useRef } from 'react'
import * as THREE from 'three'

/**
 * Highlights the selected roof in the 3D view.
 *
 * This used to swap a selected roof into "edit mode": hide its merged mesh
 * and show per-segment meshes rebuilt on demand. Those were built without
 * the roof context (joins, trimming, neighbour clipping), so a selected roof
 * looked different, and any segment whose rebuild didn't run simply
 * vanished until another roof was selected (operator 2026-09-26: "some
 * roofs disappear when I select them"). The move tool still switches to
 * segment meshes on its own while dragging, and restores them after.
 *
 * Now the merged roof — the one already drawn correctly — stays up, and the
 * selected segment(s) get a translucent orange overlay built from exactly
 * the same geometry (roofMeshesForExport, world space), so the highlight
 * always matches what is shown. Selecting a whole roof highlights all of
 * its segments.
 */
const HIGHLIGHT = new THREE.MeshBasicMaterial({
  color: 0xff8a1f,
  transparent: true,
  opacity: 0.38,
  depthWrite: false,
  side: THREE.DoubleSide,
  polygonOffset: true,
  polygonOffsetFactor: -2,
  polygonOffsetUnits: -2,
})

export const RoofEditSystem = () => {
  const selectedIds = useViewer((s) => s.selection.selectedIds)
  const nodes = useScene((s) => s.nodes)
  const shown = useRef<THREE.Mesh[]>([])

  useEffect(() => {
    for (const m of shown.current) {
      m.parent?.remove(m)
      m.geometry.dispose()
    }
    shown.current = []

    const segIds = new Set<string>()
    for (const id of selectedIds) {
      const node = nodes[id as AnyNodeId]
      if (!node) continue
      if (node.type === 'roof') {
        for (const c of node.children ?? []) segIds.add(c as string)
      } else if (node.type === 'roof-segment') {
        segIds.add(id)
      }
    }
    if (!segIds.size) return

    let meshes: ReturnType<typeof roofMeshesForExport>
    try {
      meshes = roofMeshesForExport(nodes as never, getRoofContext(nodes as never), segIds)
    } catch (e) {
      console.warn('roof highlight: could not build', e)
      return
    }
    for (const [segId, m] of meshes) {
      const seg = nodes[segId as AnyNodeId]
      const roofGroup = seg?.parentId ? sceneRegistry.nodes.get(seg.parentId) : undefined
      if (!roofGroup) continue
      const g = new THREE.BufferGeometry()
      g.setAttribute('position', new THREE.Float32BufferAttribute(m.vertices, 3))
      g.setIndex(m.faces)
      const mesh = new THREE.Mesh(g, HIGHLIGHT)
      mesh.name = 'roof-selection-highlight'
      mesh.raycast = () => {}
      mesh.renderOrder = 10
      // World-space geometry into the roof group's frame (levels move groups).
      roofGroup.updateWorldMatrix(true, false)
      mesh.applyMatrix4(new THREE.Matrix4().copy(roofGroup.matrixWorld).invert())
      roofGroup.add(mesh)
      shown.current.push(mesh)
    }
  }, [selectedIds, nodes])

  useEffect(
    () => () => {
      for (const m of shown.current) {
        m.parent?.remove(m)
        m.geometry.dispose()
      }
      shown.current = []
    },
    [],
  )

  return null
}
