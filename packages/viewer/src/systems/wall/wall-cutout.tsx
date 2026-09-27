import { getRoofContext, sceneRegistry, useScene, type WallNode } from '@ritn3d/core'
import { useFrame } from '@react-three/fiber'
import { useRef } from 'react'
import { Fn, float, fract, length, mix, positionLocal, smoothstep, step, vec2 } from 'three/tsl'

import { type Mesh, MeshStandardNodeMaterial, Vector3 } from 'three/webgpu'
import useViewer from '../../store/use-viewer'

const tmpVec = new Vector3()
const u = new Vector3()
const v = new Vector3()

// Dot pattern shader
const dotPattern = Fn(() => {
  // Create a repeating grid pattern based on world position
  const scale = float(0.1) // Dot grid spacing (10cm)
  const dotSize = float(0.3) // Size of dots relative to grid

  // Use XY coordinates for pattern on wall face
  const uv = vec2(positionLocal.x, positionLocal.y).div(scale)
  const gridUV = fract(uv)

  // Distance from center of grid cell (creates circular dots)
  const dist = length(gridUV.sub(0.5))

  // Create dots: 1 where we want dots, 0 elsewhere
  const dots = step(dist, dotSize.mul(0.5))

  // Vertical fade: fade out as Y increases (from bottom to top)
  const fadeHeight = float(2.5) // Fade over 2.5 meters
  const yFade = float(1).sub(smoothstep(float(0), fadeHeight, positionLocal.y))

  return dots.mul(yFade)
})

const invsibleWallMaterial = new MeshStandardNodeMaterial({
  transparent: true,
  opacityNode: mix(float(0.0), float(0.24), dotPattern()),
  color: 'white',
  depthWrite: false,
  emissive: 'white',
})
const wallMaterial = new MeshStandardNodeMaterial({
  color: 'white',
  roughness: 1,
  metalness: 0,
})

export const WallCutout = () => {
  const lastCameraPosition = useRef(new Vector3())
  const lastCameraTarget = useRef(new Vector3())
  const lastUpdateTime = useRef(0)
  const lastWallMode = useRef<string>(useViewer.getState().wallMode)
  const lastNumberOfWalls = useRef(0)

  useFrame(({ camera, clock }) => {
    const wallMode = useViewer.getState().wallMode
    const currentTime = clock.elapsedTime
    const currentCameraPosition = camera.position
    camera.getWorldDirection(tmpVec)
    tmpVec.add(currentCameraPosition)

    // Throttle: only update if camera moved significantly AND enough time passed
    const distanceMoved = currentCameraPosition.distanceTo(lastCameraPosition.current)
    const directionChanged = tmpVec.distanceTo(lastCameraTarget.current)
    const timeSinceUpdate = currentTime - lastUpdateTime.current

    // Update if moved > 0.5m OR direction changed > 0.3 AND at least 100ms passed
    if (
      ((distanceMoved > 0.5 || directionChanged > 0.3) && timeSinceUpdate > 0.1) ||
      lastWallMode.current !== wallMode ||
      sceneRegistry.byType.wall.size !== lastNumberOfWalls.current
    ) {
      // Camera has moved, update cutout logic here

      // Update last known positions and time
      lastCameraPosition.current.copy(currentCameraPosition)
      lastCameraTarget.current.copy(tmpVec)
      lastUpdateTime.current = currentTime
      camera.getWorldDirection(u)

      const walls = sceneRegistry.byType.wall
      const nodes = useScene.getState().nodes
      // An interior wall under a roof stays visible in the cutaway. With the
      // roof on, the rooms can't be seen into from above anyway, and such a
      // wall often rises ABOVE a lower roof on one side -- hiding it opened a
      // hole straight through the house (operator 2026-09-27: the L1 wall
      // beside the shed, between the shed room and the room under the main
      // roof's slope).
      let roofCtx: ReturnType<typeof getRoofContext> | null = null
      let roofsShown: boolean | null = null
      const underRoof = (w: WallNode): boolean => {
        roofCtx ??= getRoofContext(nodes as Parameters<typeof getRoofContext>[0])
        if (!roofCtx.segments.size) return false
        // Only while roofs are on screen: with them hidden the cutaway is
        // back to its job of showing the rooms.
        roofsShown ??= [...roofCtx.segments.keys()].some((id) => {
          let o = sceneRegistry.nodes.get(id) as { visible: boolean; parent: unknown } | undefined
          if (!o) return false
          while (o) {
            if (!o.visible) return false
            o = o.parent as typeof o
          }
          return true
        })
        if (!roofsShown) return false
        const [sx, sz] = w.start
        const [ex, ez] = w.end
        for (const t of [0.1, 0.5, 0.9]) {
          if (roofCtx.wallHeightAt(sx + (ex - sx) * t, sz + (ez - sz) * t) != null) return true
        }
        return false
      }
      walls.forEach((wallId) => {
        const wallMesh = sceneRegistry.nodes.get(wallId)
        if (!wallMesh) return
        const wallNode = useScene.getState().nodes[wallId as WallNode['id']]
        if (!wallNode || wallNode.type !== 'wall') return
        let hideWall = wallNode.frontSide === 'interior' && wallNode.backSide === 'interior'

        if (wallMode === 'up') {
          hideWall = false
        } else if (wallMode === 'down') {
          hideWall = true
        } else {
          wallMesh.getWorldDirection(v)
          if (v.dot(u) < 0) {
            // Front side
            if (wallNode.frontSide === 'exterior' && wallNode.backSide !== 'exterior') {
              hideWall = true
            }
          } else if (wallNode.backSide === 'exterior' && wallNode.frontSide !== 'exterior') {
            // Back side
            hideWall = true
          }
        }
        if (
          hideWall &&
          wallMode !== 'down' &&
          wallNode.frontSide === 'interior' &&
          wallNode.backSide === 'interior' &&
          underRoof(wallNode)
        ) {
          hideWall = false
        }
        ;(wallMesh as Mesh).material = hideWall ? invsibleWallMaterial : wallMaterial
      })
      lastWallMode.current = wallMode
      lastNumberOfWalls.current = sceneRegistry.byType.wall.size
    }
  })
  return null
}
