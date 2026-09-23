'use client'

import {
  CeilingSystem,
  DoorSystem,
  ItemSystem,
  RoofSystem,
  SlabSystem,
  WallSystem,
  WindowSystem,
} from '@ritn3d/core'
import { Bvh } from '@react-three/drei'
import {
  Canvas,
  extend,
  type ThreeToJSXElements,
  useFrame,
  useStore,
  useThree,
} from '@react-three/fiber'
import { useEffect, useMemo, useRef } from 'react'
import * as THREE from 'three/webgpu'
import { useRaycastGuard } from '../../lib/raycast-guard'
import useViewer from '../../store/use-viewer'
import { GuideSystem } from '../../systems/guide/guide-system'
import { ItemLightSystem } from '../../systems/item-light/item-light-system'
import { LevelSystem } from '../../systems/level/level-system'
// ScanSystem removed 2026-06-10 (Ritn3D cleanup): Pascal's 3D-scan import
// feature (LiDAR/photogrammetry GLB overlay), unused here.
import { WallCutout } from '../../systems/wall/wall-cutout'
import { ZoneSystem } from '../../systems/zone/zone-system'
import { SceneRenderer } from '../renderers/scene-renderer'
import { Lights } from './lights'
import { PerfMonitor } from './perf-monitor'
import PostProcessing from './post-processing'
import { SelectionManager } from './selection-manager'
import { ViewerCamera } from './viewer-camera'

function AnimatedBackground({ isDark }: { isDark: boolean }) {
  const targetColor = useMemo(() => new THREE.Color(), [])
  const initialized = useRef(false)

  useFrame(({ scene }, delta) => {
    const dt = Math.min(delta, 0.1) * 4
    const targetHex = isDark ? '#1f2433' : '#ffffff'

    if (!(scene.background && scene.background instanceof THREE.Color)) {
      scene.background = new THREE.Color(targetHex)
      initialized.current = true
      return
    }

    if (!initialized.current) {
      scene.background.set(targetHex)
      initialized.current = true
      return
    }

    targetColor.set(targetHex)
    scene.background.lerp(targetColor, dt)
  })

  return null
}

declare module '@react-three/fiber' {
  interface ThreeElements extends ThreeToJSXElements<typeof THREE> {}
}

extend(THREE as any)

// TEMPORARY (2026-09-23): keeps a single mesh that throws inside
// raycast from taking the whole render loop down, and names the
// offender once in the console. See lib/raycast-guard.ts. Remove
// after the preview-blanking bug is closed.
//
// Rendered inside the Canvas (after <Bvh>) rather than called at
// module scope: the first attempt installed here and was silently
// replaced by Bvh's acceleratedRaycast assignment before a single
// raycast ran, so the guard never fired.
function RaycastGuard() {
  useRaycastGuard()
  return null
}

/**
 * Monitors the WebGPU device for loss events and logs them.
 * WebGPU device loss can happen when:
 *  - Tab is backgrounded and OS reclaims GPU
 *  - Driver crash or GPU reset
 *  - Browser security policy kills the context
 */
function GPUDeviceWatcher() {
  const gl = useThree((s) => s.gl)

  useEffect(() => {
    const backend = (gl as any).backend
    const device: GPUDevice | undefined = backend?.device

    if (!device) return

    device.lost.then((info) => {
      console.error(
        `[viewer] WebGPU device lost: reason="${info.reason}", message="${info.message}". ` +
          'The page must be reloaded to recover the GPU context.',
      )
    })
  }, [gl])

  return null
}

/**
 * Dev-only introspection bridge, enabled with ?debug3d=1 on the URL.
 *
 * Added 2026-09-24 after several rounds of debugging the blank editor
 * preview against MINIFIED runtime code, which produced two wrong
 * conclusions: a WebGPU-API probe that missed a WebGL2 fallback, and a
 * getContext('webgl2') check that CREATED the context it was testing
 * for. Guessing at internals from the console is how that happened, so
 * the package now hands the real store out instead.
 *
 * Exposes:
 *   window.__ritn3d        the R3F store (.getState() => gl/scene/camera/...)
 *   window.__ritn3dFrames  useFrame tick count — the single fastest way
 *                          to tell "loop never started" from "loop runs
 *                          but draws nothing"
 *
 * Off unless the query param is present, so share links and the public
 * viewer are unaffected. The useFrame runs at default priority 0, which
 * does NOT switch R3F to a manual render loop.
 */
function DebugBridge() {
  const store = useStore()
  const enabled = useMemo(
    () =>
      typeof window !== 'undefined' &&
      new URLSearchParams(window.location.search).has('debug3d'),
    [],
  )

  useFrame(() => {
    if (!enabled) return
    const w = window as any
    w.__ritn3dFrames = (w.__ritn3dFrames || 0) + 1
  })

  useEffect(() => {
    if (!enabled) return
    const w = window as any
    w.__ritn3d = store
    w.__ritn3dFrames = 0
    const s: any = store.getState()
    const gl: any = s.gl
    console.log('[debug3d] canvas mounted', {
      renderer: gl?.constructor?.name,
      isWebGPURenderer: !!gl?.isWebGPURenderer,
      backend: gl?.backend?.constructor?.name,
      hasGPUDevice: !!gl?.backend?.device,
      canvasInDom: !!gl?.domElement?.isConnected,
      frameloop: s.frameloop,
      sceneChildren: s.scene?.children?.length,
      camera: s.camera?.position?.toArray?.(),
      size: s.size,
    })
  }, [enabled, store])

  return null
}

interface ViewerProps {
  children?: React.ReactNode
  selectionManager?: 'default' | 'custom'
  perf?: boolean
  /**
   * Mount the TSL post-processing pipeline. Default true — share links
   * and the public viewer keep the full look.
   *
   * Pass false to render plainly. This is not just a visual toggle:
   * PostProcessing's `useFrame(..., 1)` runs at priority 1, which
   * switches R3F's render loop to MANUAL — R3F stops calling gl.render
   * itself and that callback becomes the only thing that draws. Not
   * mounting it hands rendering back to R3F.
   *
   * The editor preview passes false (2026-09-24). Measured on
   * editor-dev: with post-FX on, the pipeline initialises, configures
   * the WebGPU context and submits GPU work (48 submits observed) but
   * composites alpha=0 across the whole surface, so the canvas reads
   * back as a single rgba(0,0,0,0) value and only the drei <Html>
   * labels are visible. Its own design note says it clears with
   * setClearAlpha(0) and treats scenePassColor.a as a geometry mask
   * where "geometry pixels write a=1 via output node" — that a=1 isn't
   * landing. Geometry, camera and scene graph are all fine; this is a
   * TSL/WebGPU composite bug. The editor only needs a working
   * workflow, so it opts out rather than waiting on that fix.
   */
  postProcessing?: boolean
}

const Viewer: React.FC<ViewerProps> = ({
  children,
  selectionManager = 'default',
  perf = false,
  postProcessing = true,
}) => {
  const theme = useViewer((state) => state.theme)

  return (
    <Canvas
      camera={{ position: [50, 50, 50], fov: 50 }}
      className={`transition-colors duration-700 ${theme === 'dark' ? 'bg-[#1f2433]' : 'bg-[#fafafa]'}`}
      dpr={[1, 1.5]}
      gl={(props) => {
        const renderer = new THREE.WebGPURenderer(props as any)
        renderer.toneMapping = THREE.ACESFilmicToneMapping
        renderer.toneMappingExposure = 0.9
        // renderer.init() // Only use when using <DebugRenderer />
        return renderer
      }}
      resize={{
        debounce: 100,
      }}
      shadows={{
        type: THREE.PCFShadowMap,
        enabled: true,
      }}
    >
      {/* <AnimatedBackground isDark={theme === 'dark'} /> */}
      <ViewerCamera />

      {/* <directionalLight position={[10, 10, 5]} intensity={0.5} castShadow
        /> */}
      <Lights />
      {/* Must sit AFTER <Bvh>: drei's Bvh assigns three-mesh-bvh's
          acceleratedRaycast onto Mesh.prototype in a layout effect,
          which clobbers any wrapper installed earlier. RaycastGuard
          re-checks each frame and re-wraps whatever is currently
          there, so it survives that and any later remount. */}
      <Bvh>
        <SceneRenderer />
      </Bvh>
      <RaycastGuard />

      {/* Default Systems */}
      <LevelSystem />
      <GuideSystem />
      <WallCutout />
      {/* Core systems */}
      <CeilingSystem />
      <DoorSystem />
      <ItemSystem />
      <RoofSystem />
      <SlabSystem />
      <WallSystem />
      <WindowSystem />
      <ZoneSystem />
      {postProcessing && <PostProcessing />}
      {/* <DebugRenderer /> */}
      <GPUDeviceWatcher />
      <DebugBridge />

      <ItemLightSystem />
      {selectionManager === 'default' && <SelectionManager />}
      {perf && <PerfMonitor />}
      {children}
    </Canvas>
  )
}

const DebugRenderer = () => {
  useFrame(({ gl, scene, camera }) => {
    gl.render(scene, camera)
  })
  return null
}

export default Viewer
