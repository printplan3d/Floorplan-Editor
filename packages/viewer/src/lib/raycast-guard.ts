import * as THREE from 'three'
import * as THREE_WEBGPU from 'three/webgpu'

/**
 * TEMPORARY DIAGNOSTIC — remove once the raycast crash is closed out.
 *
 * Symptom being chased (2026-09-23): entering 3D preview blanked the
 * scene. Console filled with ~1750×
 *
 *   Uncaught TypeError: Cannot read properties of undefined
 *     (reading 'materialIndex')   at Mesh.raycast
 *
 * A throw inside raycast propagates out of the pointer-move handler
 * and kills the render loop, so no meshes draw while drei <Html>
 * labels (plain DOM, outside the WebGL loop) keep rendering. That's
 * what "only room annotations visible" looked like.
 *
 * The throw itself means three.js (or three-mesh-bvh's accelerated
 * raycast) resolved a hit triangle's material to `undefined` —
 * either a group whose materialIndex is past the end of the
 * material array, or a triangle covered by no group at all.
 *
 * This guard does two jobs:
 *   1. Keeps the render loop ALIVE by swallowing the throw, so a
 *      single bad mesh can't blank the whole scene.
 *   2. Names the offender ONCE per mesh (deduped — otherwise it's
 *      1750 identical lines) with everything needed to fix it:
 *      geometry size, group layout, material array length, whether
 *      a BVH is attached.
 *
 * Deliberately not silent: if this ever fires in production we want
 * it loud in the console, because a mesh that can't be raycast also
 * can't be selected.
 */
// The viewer renders through `three/webgpu`, while most other code
// imports plain `three`. Depending on how the bundler dedupes, those
// can resolve to SEPARATE module instances with distinct Mesh
// classes — patching one would then miss the meshes actually being
// raycast. Patch every distinct prototype we can reach, guarding
// against double-wrapping when they turn out to be the same object.
const patchedPrototypes = new WeakSet<object>()
const reported = new Set<string>()

export function installRaycastGuard(): void {
  for (const Ctor of [THREE.Mesh, (THREE_WEBGPU as unknown as typeof THREE).Mesh]) {
    const proto = Ctor?.prototype as (THREE.Mesh & { raycast: THREE.Mesh['raycast'] }) | undefined
    if (!proto || patchedPrototypes.has(proto)) continue
    patchedPrototypes.add(proto)
    patchPrototype(proto)
  }
}

function patchPrototype(proto: THREE.Mesh): void {
  const original = proto.raycast

  proto.raycast = function patchedRaycast(
    this: THREE.Mesh,
    raycaster: THREE.Raycaster,
    intersects: THREE.Intersection[],
  ) {
    try {
      original.call(this, raycaster, intersects)
    } catch (err) {
      const key = `${this.name || '(unnamed)'}:${this.uuid}`
      if (reported.has(key)) return
      reported.add(key)

      const geom = this.geometry as THREE.BufferGeometry | undefined
      const index = geom?.getIndex?.()
      const groups = geom?.groups ?? []
      const matIsArray = Array.isArray(this.material)
      const matLen = matIsArray ? (this.material as THREE.Material[]).length : 1
      const maxSlot = groups.length
        ? Math.max(...groups.map((g) => g.materialIndex ?? 0))
        : -1
      const indexCount = index?.count ?? 0
      const covered = groups.reduce((n, g) => n + (g.count ?? 0), 0)

      console.error('[raycast-guard] mesh threw during raycast — swallowed', {
        name: this.name || '(unnamed)',
        type: this.type,
        uuid: this.uuid,
        parent: this.parent?.name || this.parent?.type,
        verts: geom?.getAttribute('position')?.count ?? 0,
        indexCount,
        groupCount: groups.length,
        coveredIndices: covered,
        uncoveredIndices: Math.max(0, indexCount - covered),
        maxGroupMaterialIndex: maxSlot,
        materialIsArray: matIsArray,
        materialArrayLength: matLen,
        slotOutOfRange: maxSlot >= matLen,
        hasBoundsTree: Boolean((geom as unknown as { boundsTree?: unknown })?.boundsTree),
        groups: groups.map((g) => ({
          start: g.start,
          count: g.count,
          materialIndex: g.materialIndex,
        })),
        error: String(err),
      })
    }
  }
}
