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

/**
 * Priority for the plain (no post-FX) render pass.
 *
 * Must be higher than every system's useFrame priority so the draw
 * happens after they have all updated their meshes for this frame.
 * Highest today is 5 (roof-system, level-system); 1000 leaves room.
 */
const PLAIN_RENDER_PRIORITY = 1000

/**
 * Draws the scene when <PostProcessing /> is not mounted.
 *
 * This is REQUIRED, not a nicety. R3F only calls gl.render itself
 * while `internal.priority` is 0:
 *
 *     if (!state.internal.priority && state.gl.render)
 *       state.gl.render(state.scene, state.camera)
 *
 * and this app permanently mounts seven systems with a useFrame
 * priority above 0 — roof 5, level 5, wall 4, door 3, window 3,
 * item 2, slab 1. So internal.priority is never 0, R3F never draws,
 * and whichever priority>0 subscriber calls render IS the renderer.
 *
 * That subscriber used to be PostProcessing alone. Passing
 * postProcessing={false} therefore didn't just drop the effects, it
 * removed the only draw call in the app and left a blank canvas.
 * Measured on editor-dev: internal.priority 7, and 0 gl.render calls
 * across 4 advance() ticks.
 */
function PlainRenderer() {
  useFrame(({ gl, scene, camera }) => {
    gl.render(scene, camera)
  }, PLAIN_RENDER_PRIORITY)
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
   * Pass false to render plainly; <PlainRenderer /> is mounted in its
   * place and does the draw. An earlier version of this comment said
   * not mounting PostProcessing "hands rendering back to R3F". That is
   * WRONG — see PlainRenderer above. R3F only draws while
   * internal.priority is 0, and seven systems here keep it at 7, so
   * without one of the two renderers nothing draws at all.
   *
   * The editor preview passes false (2026-09-24) because the post-FX
   * path composites alpha=0 across the whole surface on this scene —
   * the canvas reads back as a single rgba(0,0,0,0). Its own design
   * note says geometry pixels should write a=1 via the output node;
   * that isn't landing. Worth revisiting now that the renderer is
   * initialised properly (see the gl callback), since the pipeline was
   * previously driving an uninitialised backend.
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
      gl={async (props) => {
        const renderer = new THREE.WebGPURenderer(props as any)
        renderer.toneMapping = THREE.ACESFilmicToneMapping
        renderer.toneMappingExposure = 0.9
        // MUST await. three r183's Renderer.render() opens with
        //   if (this._initialized === false) throw new Error(...)
        // and @react-three/fiber 9.6.1 never calls init() for you --
        // it only awaits whatever this callback returns:
        //   const customRenderer = typeof glConfig === 'function'
        //     ? await glConfig(defaultProps) : glConfig
        // Without this the very first gl.render() throws INSIDE R3F's
        // rAF loop, before the loop re-schedules itself, so the chain
        // breaks while the module's `running` flag stays true -- which
        // means invalidate() can never restart it either. One throw
        // kills rendering for the whole page, permanently.
        await renderer.init()
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
      <Bvh>
        <SceneRenderer />
      </Bvh>

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
      {postProcessing ? <PostProcessing /> : <PlainRenderer />}
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
