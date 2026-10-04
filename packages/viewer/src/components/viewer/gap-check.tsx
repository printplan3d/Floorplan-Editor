import { type AnyNode, sceneRegistry, useScene, type ZoneNode } from '@ritn3d/core'
import { useFrame } from '@react-three/fiber'
import { useMemo, useRef } from 'react'
import * as THREE from 'three/webgpu'
import useViewer from '../../store/use-viewer'

/** Bright and saturated: nothing else in a plan is this colour. */
const GAP_COLOR = '#ff00d4'
/** Light height above each storey's floor: under any ceiling, over furniture. */
const LIGHT_Y = 1.6

/**
 * "Check gaps": the house lit from INSIDE only. Each room gets a magenta
 * light; Lights dims everything else and the background goes black. Outer
 * wall faces and roof tops face away from every room light, so they stay
 * dark; inner faces glow. Any crack, bleed or hole between roof and walls
 * shows as magenta from outside (operator 2026-10-04). View only.
 */
export function GapCheck() {
  const on = useViewer((s) => s.checkGaps)
  const nodes = useScene((s) => s.nodes) as Record<string, AnyNode>
  const zones = useMemo(
    () =>
      Object.values(nodes).filter(
        (n): n is ZoneNode => n?.type === 'zone' && Array.isArray((n as ZoneNode).polygon) && (n as ZoneNode).polygon.length >= 3,
      ),
    [nodes],
  )
  const refs = useRef<(THREE.PointLight | null)[]>([])
  const prevBg = useRef<THREE.Scene['background'] | undefined>(undefined)
  const black = useMemo(() => new THREE.Color('#000000'), [])

  useFrame(({ scene }) => {
    if (on) {
      if (prevBg.current === undefined) prevBg.current = scene.background
      scene.background = black
    } else if (prevBg.current !== undefined) {
      scene.background = prevBg.current
      prevBg.current = undefined
    }
    if (!on) return
    // Each room's light follows its storey wherever the level system has
    // put it (stacked, exploded or solo).
    zones.forEach((z, i) => {
      const light = refs.current[i]
      if (!light) return
      const lvl = z.parentId ? sceneRegistry.nodes.get(z.parentId) : undefined
      const pos = new THREE.Vector3()
      lvl?.getWorldPosition(pos)
      let cx = 0
      let cz = 0
      for (const [x, zz] of z.polygon) {
        cx += x
        cz += zz
      }
      light.position.set(cx / z.polygon.length + pos.x, pos.y + LIGHT_Y, cz / z.polygon.length + pos.z)
      light.visible = lvl ? lvl.visible !== false : true
    })
  })

  if (!on) return null
  return (
    <>
      {zones.map((z, i) => {
        // Reach: the room's own size plus its roof space, no further, so a
        // room's light doesn't paint the outside of another wing.
        let r = 0
        const n = z.polygon.length
        const cx = z.polygon.reduce((a, p) => a + p[0], 0) / n
        const cz = z.polygon.reduce((a, p) => a + p[1], 0) / n
        for (const [x, zz] of z.polygon) r = Math.max(r, Math.hypot(x - cx, zz - cz))
        return (
          <pointLight
            color={GAP_COLOR}
            decay={1}
            distance={r + 4}
            intensity={6}
            key={z.id}
            ref={(el) => {
              refs.current[i] = el
            }}
          />
        )
      })}
    </>
  )
}
