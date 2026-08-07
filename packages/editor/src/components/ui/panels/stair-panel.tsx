'use client'

import {
  type AnyNodeId,
  computeStairMetrics,
  STAIR_FLIGHT_GAP,
  STAIR_MAX_ANGLE_DEG,
  type StairNode,
  type StairVariant,
  suggestStairFootprint,
  useScene,
} from '@ritn3d/core'
import { DEFAULT_LEVEL_HEIGHT, getLevelHeight, useViewer } from '@ritn3d/viewer'
import { AlertTriangle, Check } from 'lucide-react'
import { useCallback, useMemo } from 'react'
import { ActionButton } from '../controls/action-button'
import { PanelSection } from '../controls/panel-section'
import { SliderControl } from '../controls/slider-control'
import { PanelWrapper } from './panel-wrapper'

/**
 * Ritn3D 2026-08-07 — the stair panel exists to make ONE constraint visible.
 *
 * Step count is not a choice: it falls out of the storey height as
 * ceil(height / riser). So a footprint that looks generous can still force a
 * punishing pitch, and the user has no way to know until the render comes
 * back. The old procedural stairs handled that by quietly overflowing the
 * room — the stair came out through the wall — which is why they were never
 * enabled.
 *
 * Everything below is driven by computeStairMetrics, the same function the
 * Blender pipeline mirrors constant-for-constant (675-case parity test). So
 * the readout here is not an estimate of the render; it IS the render's
 * arithmetic.
 */

const VARIANTS: { id: StairVariant; label: string; icon: string; hint: string }[] = [
  {
    id: 'straight',
    label: 'Straight',
    icon: '/symbols/stairs/staircase.svg',
    hint: 'One flight. Needs the most length.',
  },
  {
    id: 'u',
    label: 'U-turn',
    icon: '/symbols/stairs/u_staircase.svg',
    hint: 'Folds back on itself. Halves the length, needs width.',
  },
  {
    id: 'l',
    label: 'L-turn',
    icon: '/symbols/stairs/l_staircase.svg',
    hint: 'Turns 90°. Splits the run across length and depth.',
  },
]

export function StairPanel() {
  const selectedIds = useViewer((s) => s.selection.selectedIds)
  const setSelection = useViewer((s) => s.setSelection)
  const nodes = useScene((s) => s.nodes)
  const unit = useViewer((s) => s.unit)
  const updateNode = useScene((s) => s.updateNode)

  const selectedId = selectedIds[0]
  const node = selectedId ? (nodes[selectedId as AnyNodeId] as StairNode | undefined) : undefined

  const handleUpdate = useCallback(
    (updates: Partial<StairNode>) => {
      if (!selectedId) return
      updateNode(selectedId as AnyNodeId, updates)
    },
    [selectedId, updateNode],
  )

  const handleClose = useCallback(() => setSelection({ selectedIds: [] }), [setSelection])

  /* Floor-to-floor for the storey this stair sits on — the real one, read off
     the level's own walls. A hardcoded default here is exactly what made the
     old pipeline stairs land at the wrong height on a 2.7 m or 3.0 m storey. */
  const levelHeight = useMemo(() => {
    if (!node?.parentId) return DEFAULT_LEVEL_HEIGHT
    return getLevelHeight(node.parentId as AnyNodeId, nodes) || DEFAULT_LEVEL_HEIGHT
  }, [node?.parentId, nodes])

  const metrics = useMemo(
    () => (node ? computeStairMetrics(node, levelHeight) : null),
    [node, levelHeight],
  )

  /* Widening a flight on a U or L also needs room ACROSS, and without this
     the panel just reported that it had quietly narrowed the flights back
     down — the slider moved and nothing changed, with a warning explaining
     why. Growing the depth to match makes the control do what it says.

     Only ever grows. Shrinking the depth when the user narrows a flight would
     undo a footprint they set deliberately. */
  /* Changing the SHAPE has to change the footprint with it.

     Switching a straight stair to a U left length and depth exactly as they
     were — and a straight stair's depth is one flight wide, far too narrow
     for two flights plus the gap. The metrics narrowed the flights to fit, so
     the symbol barely moved and the stair looked unchanged until "fit to this
     storey" was pressed. The button appeared to do nothing.

     Refitting on switch is also just what the user means: pick a U, get a U.
     Flight width is preserved because that is a deliberate choice; only the
     box around it is re-derived. */
  const handleVariantChange = useCallback(
    (variant: StairVariant) => {
      if (!node) return
      const fit = suggestStairFootprint(variant, node.width, levelHeight)
      handleUpdate({ variant, length: fit.length, depth: fit.depth })
    },
    [node, levelHeight, handleUpdate],
  )

  const handleWidthChange = useCallback(
    (w: number) => {
      if (!node) return
      if (node.variant === 'u') {
        const needed = w * 2 + STAIR_FLIGHT_GAP
        handleUpdate({
          width: w,
          depth: Math.max(node.depth, Math.round(needed * 100) / 100),
        })
        return
      }
      if (node.variant === 'l') {
        handleUpdate({ width: w, depth: Math.max(node.depth, w) })
        return
      }
      handleUpdate({ width: w })
    },
    [node, handleUpdate],
  )

  const handleFit = useCallback(() => {
    if (!node) return
    const fit = suggestStairFootprint(node.variant, node.width, levelHeight)
    handleUpdate({ length: Math.round(fit.length * 100) / 100, depth: Math.round(fit.depth * 100) / 100 })
  }, [node, levelHeight, handleUpdate])

  if (!(node && metrics)) return null

  // Follow the canvas unit. The sliders already convert via SliderControl, so
  // showing the readout in millimetres while Length read in feet put two unit
  // systems in one panel.
  const small = (v: number) =>
    unit === 'imperial'
      ? `${(v * 39.3700787).toFixed(1)} in`
      : `${Math.round(v * 1000)} mm`
  const storey = unit === 'imperial'
    ? `${(levelHeight * 3.280839895).toFixed(2)} ft`
    : `${levelHeight.toFixed(2)} m`

  return (
    <PanelWrapper
      icon="/symbols/stairs/staircase.svg"
      onClose={handleClose}
      title={node.name || 'Stair'}
      width={340}
    >
      <PanelSection title="Shape">
        <div className="grid grid-cols-3 gap-1 px-1 pb-1">
          {VARIANTS.map((v) => {
            const isActive = node.variant === v.id
            return (
              <button
                className={`flex flex-col items-center gap-1 rounded-md border px-2 py-2 text-[11px] font-medium transition-colors ${
                  isActive
                    ? 'border-amber-500/50 bg-amber-500/20 text-amber-100'
                    : 'border-border/30 text-muted-foreground hover:bg-accent/40 hover:text-foreground'
                }`}
                key={v.id}
                onClick={() => handleVariantChange(v.id)}
                title={v.hint}
                type="button"
              >
                <img alt="" className="h-8 w-8 opacity-80" src={v.icon} />
                {v.label}
              </button>
            )
          })}
        </div>

        {node.variant !== 'straight' && (
          <div className="mt-1 grid grid-cols-2 gap-1.5 px-1 pb-1">
            <ActionButton
              label={node.handedness === 'left' ? '↰ Turns left' : '↱ Turns right'}
              onClick={() =>
                handleUpdate({ handedness: node.handedness === 'left' ? 'right' : 'left' })
              }
            />
            <ActionButton
              label={node.railing === false ? 'Railing off' : 'Railing on'}
              onClick={() => handleUpdate({ railing: node.railing === false })}
            />
          </div>
        )}
      </PanelSection>

      <PanelSection title="Footprint">
        <SliderControl
          label="Length"
          max={12}
          min={0.8}
          onChange={(v) => handleUpdate({ length: v })}
          precision={2}
          step={0.05}
          unit="m"
          value={node.length}
        />
        <SliderControl
          label="Flight width"
          max={2.5}
          min={0.6}
          onChange={(v) => handleWidthChange(v)}
          precision={2}
          step={0.05}
          unit="m"
          value={node.width}
        />
        {node.variant !== 'straight' && (
          <SliderControl
            label="Depth (across)"
            max={8}
            min={0.6}
            onChange={(v) => handleUpdate({ depth: v })}
            precision={2}
            step={0.05}
            unit="m"
            value={node.depth}
          />
        )}
        <SliderControl
          label="Rotation"
          max={360}
          min={0}
          onChange={(v) => handleUpdate({ rotation: (v * Math.PI) / 180 })}
          precision={0}
          step={5}
          unit="deg"
          value={Math.round(((node.rotation * 180) / Math.PI + 360) % 360)}
        />

        <div className="mt-2 px-1 pb-1">
          <ActionButton label="Fit to this storey" onClick={handleFit} />
        </div>
      </PanelSection>

      {/* The readout. Step count first, because it is the number users do not
          expect to be fixed — everything else is a consequence of it. */}
      <PanelSection title={`Steps — ${storey} storey`}>
        <div className="grid grid-cols-2 gap-x-3 gap-y-1 px-2 py-1 text-sm">
          <span className="text-muted-foreground">Risers</span>
          <span className="text-right font-mono text-white">{metrics.stepCount}</span>

          <span className="text-muted-foreground">Riser height</span>
          <span className="text-right font-mono text-white">{small(metrics.riser)}</span>

          <span className="text-muted-foreground">Tread</span>
          <span
            className={`text-right font-mono ${metrics.fits ? 'text-white' : 'text-amber-300'}`}
          >
            {small(metrics.tread)}
          </span>

          <span className="text-muted-foreground">Pitch</span>
          <span
            className={`text-right font-mono ${
              metrics.angleDeg > STAIR_MAX_ANGLE_DEG ? 'text-amber-300' : 'text-white'
            }`}
          >
            {metrics.angleDeg.toFixed(0)}°
          </span>

          {metrics.narrowed && (
            <>
              <span className="text-muted-foreground">Flight width</span>
              <span className="text-right font-mono text-amber-300">{small(metrics.width)}</span>
            </>
          )}
        </div>

        {metrics.fits ? (
          <div className="mx-1 mb-1 flex items-start gap-2 rounded-md border border-emerald-500/30 bg-emerald-500/10 px-2 py-1.5 text-[11px] text-emerald-200">
            <Check className="mt-px h-3.5 w-3.5 shrink-0" />
            <span>Comfortable. This is exactly what will be built.</span>
          </div>
        ) : (
          <div className="mx-1 mb-1 flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-2 py-1.5 text-[11px] text-amber-200">
            <AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0" />
            <span>
              {metrics.problem}
              <br />
              <span className="text-amber-200/70">
                It will still be built inside this footprint — just steeper. Stairs never
                overflow the space you gave them.
              </span>
            </span>
          </div>
        )}
      </PanelSection>
    </PanelWrapper>
  )
}
