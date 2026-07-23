'use client'

import { useScene } from '@ritn3d/core'
import { useCallback, useEffect, useRef, useState } from 'react'
import { cn } from '../../../lib/utils'

// Ritn3D 2026-07-24: paper-themed range slider styles. Self-contained so
// the component works whether embedded in the standalone editor app or
// mounted inside the webapp. Injected once at module load; safe if the
// module is evaluated multiple times because we key by an id.
const SLIDER_STYLE_ID = 'ritn3d-slider-styles'
if (typeof document !== 'undefined' && !document.getElementById(SLIDER_STYLE_ID)) {
  const style = document.createElement('style')
  style.id = SLIDER_STYLE_ID
  style.textContent = `
    .ritn3d-slider {
      appearance: none;
      -webkit-appearance: none;
      background: transparent;
      height: 14px;
    }
    .ritn3d-slider:focus { outline: none; }
    .ritn3d-slider::-webkit-slider-runnable-track {
      height: 2px;
      background: rgb(from var(--color-ink, #171512) r g b / 0.15);
      border-radius: 999px;
    }
    .ritn3d-slider::-moz-range-track {
      height: 2px;
      background: rgb(from var(--color-ink, #171512) r g b / 0.15);
      border-radius: 999px;
    }
    .ritn3d-slider::-webkit-slider-thumb {
      appearance: none;
      -webkit-appearance: none;
      width: 12px; height: 12px;
      background: var(--color-ink, #171512);
      border-radius: 999px;
      margin-top: -5px;
      cursor: grab;
      box-shadow: 0 0 0 3px rgb(from var(--color-paper, #f7f5f0) r g b / 1);
      transition: transform 120ms ease;
    }
    .ritn3d-slider::-moz-range-thumb {
      width: 12px; height: 12px;
      background: var(--color-ink, #171512);
      border: none;
      border-radius: 999px;
      cursor: grab;
      box-shadow: 0 0 0 3px rgb(from var(--color-paper, #f7f5f0) r g b / 1);
      transition: transform 120ms ease;
    }
    .ritn3d-slider:hover::-webkit-slider-thumb { transform: scale(1.15); }
    .ritn3d-slider:hover::-moz-range-thumb { transform: scale(1.15); }
    .ritn3d-slider:active::-webkit-slider-thumb { cursor: grabbing; }
    .ritn3d-slider:active::-moz-range-thumb { cursor: grabbing; }
    .ritn3d-slider:disabled { opacity: 0.5; }
    .ritn3d-slider:disabled::-webkit-slider-thumb { cursor: not-allowed; }
    .ritn3d-slider:disabled::-moz-range-thumb { cursor: not-allowed; }
  `
  document.head.appendChild(style)
}

interface SliderControlProps {
  label: React.ReactNode
  value: number
  onChange: (value: number) => void
  min?: number
  max?: number
  precision?: number
  step?: number
  className?: string
  unit?: string
}

export function SliderControl({
  label,
  value,
  onChange,
  min = Number.NEGATIVE_INFINITY,
  max = Number.POSITIVE_INFINITY,
  precision = 0,
  step = 1,
  className,
  unit = '',
}: SliderControlProps) {
  const [isEditing, setIsEditing] = useState(false)
  const [isDragging, setIsDragging] = useState(false)
  const [isHovered, setIsHovered] = useState(false)
  const [inputValue, setInputValue] = useState(value.toFixed(precision))

  const dragRef = useRef<{ startX: number; startValue: number } | null>(null)
  const labelRef = useRef<HTMLDivElement>(null)
  const valueRef = useRef(value)
  valueRef.current = value

  const clamp = useCallback((val: number) => Math.min(Math.max(val, min), max), [min, max])

  useEffect(() => {
    if (!isEditing) {
      setInputValue(value.toFixed(precision))
    }
  }, [value, precision, isEditing])

  // Wheel support on the label
  useEffect(() => {
    const el = labelRef.current
    if (!el) return
    const handleWheel = (e: WheelEvent) => {
      if (isEditing) return
      e.preventDefault()
      const direction = e.deltaY < 0 ? 1 : -1
      let s = step
      if (e.shiftKey) s = step * 10
      else if (e.altKey) s = step * 0.1
      const newValue = clamp(valueRef.current + direction * s)
      const final = Number.parseFloat(newValue.toFixed(precision))
      if (final !== valueRef.current) onChange(final)
    }
    el.addEventListener('wheel', handleWheel, { passive: false })
    return () => el.removeEventListener('wheel', handleWheel)
  }, [isEditing, step, clamp, onChange, precision])

  // Arrow key support while hovered
  useEffect(() => {
    if (!isHovered || isEditing) return
    const handleKeyDown = (e: KeyboardEvent) => {
      let direction = 0
      if (e.key === 'ArrowUp' || e.key === 'ArrowRight') direction = 1
      else if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') direction = -1
      if (direction !== 0) {
        e.preventDefault()
        let s = step
        if (e.shiftKey) s = step * 10
        else if (e.metaKey || e.ctrlKey) s = step * 0.1
        const newValue = clamp(valueRef.current + direction * s)
        const final = Number.parseFloat(newValue.toFixed(precision))
        if (final !== valueRef.current) onChange(final)
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [isHovered, isEditing, step, clamp, onChange, precision])

  const handleLabelPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (isEditing) return
      e.preventDefault()
      e.currentTarget.setPointerCapture(e.pointerId)
      dragRef.current = { startX: e.clientX, startValue: valueRef.current }
      setIsDragging(true)
      useScene.temporal.getState().pause()
    },
    [isEditing],
  )

  const handleLabelPointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!dragRef.current) return
      const { startX, startValue } = dragRef.current
      const dx = e.clientX - startX
      let s = step
      if (e.shiftKey) s = step * 10
      else if (e.metaKey || e.ctrlKey) s = step * 0.1
      // 4 px per step at default sensitivity
      const newValue = clamp(Number.parseFloat((startValue + (dx / 4) * s).toFixed(precision)))
      onChange(newValue)
    },
    [step, precision, clamp, onChange],
  )

  const handleLabelPointerUp = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!dragRef.current) return
      const { startValue } = dragRef.current
      const finalVal = valueRef.current
      dragRef.current = null
      setIsDragging(false)
      e.currentTarget.releasePointerCapture(e.pointerId)

      if (startValue !== finalVal) {
        onChange(startValue)
        useScene.temporal.getState().resume()
        onChange(finalVal)
      } else {
        useScene.temporal.getState().resume()
      }
    },
    [onChange],
  )

  const handleValueClick = useCallback(() => {
    setIsEditing(true)
    setInputValue(value.toFixed(precision))
  }, [value, precision])

  const submitValue = useCallback(() => {
    const numValue = Number.parseFloat(inputValue)
    if (Number.isNaN(numValue)) {
      setInputValue(value.toFixed(precision))
    } else {
      onChange(clamp(Number.parseFloat(numValue.toFixed(precision))))
    }
    setIsEditing(false)
  }, [inputValue, onChange, clamp, precision, value])

  const handleInputKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Enter') {
        submitValue()
      } else if (e.key === 'Escape') {
        setInputValue(value.toFixed(precision))
        setIsEditing(false)
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        const newV = clamp(value + step)
        onChange(newV)
        setInputValue(newV.toFixed(precision))
      } else if (e.key === 'ArrowDown') {
        e.preventDefault()
        const newV = clamp(value - step)
        onChange(newV)
        setInputValue(newV.toFixed(precision))
      }
    },
    [submitValue, value, precision, step, clamp, onChange],
  )

  // Ritn3D 2026-07-24: added a real <input type=range> track+thumb between
  // the label grip and the value. When min/max are both finite the range
  // is rendered and takes the horizontal space; otherwise falls back to
  // a spacer (preserving the old drag-scrub-only layout for numeric
  // fields with no bounds e.g. a stray Position field with no wall parent).
  const hasBounds = Number.isFinite(min) && Number.isFinite(max)

  const handleRangeInput = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const newValue = clamp(Number.parseFloat(e.target.value))
      const final = Number.parseFloat(newValue.toFixed(precision))
      if (final !== valueRef.current) onChange(final)
    },
    [clamp, onChange, precision],
  )
  const handleRangeDown = useCallback(() => {
    useScene.temporal.getState().pause()
    dragRef.current = { startX: 0, startValue: valueRef.current }
    setIsDragging(true)
  }, [])
  const handleRangeUp = useCallback(() => {
    if (!dragRef.current) return
    const { startValue } = dragRef.current
    const finalVal = valueRef.current
    dragRef.current = null
    setIsDragging(false)
    if (startValue !== finalVal) {
      onChange(startValue)
      useScene.temporal.getState().resume()
      onChange(finalVal)
    } else {
      useScene.temporal.getState().resume()
    }
  }, [onChange])

  // Ritn3D 2026-06-18: paper-themed slider control. Hover bg is hair-tinted
  // (not white/5), label and value use ink with mono numerics for tabular
  // alignment. Same drag / wheel / arrow / click-to-edit mechanics.
  return (
    <div
      className={cn(
        'group flex h-7 w-full select-none items-center rounded-md px-2 transition-colors',
        isDragging ? 'bg-ink/[0.05]' : 'hover:bg-ink/[0.03]',
        className,
      )}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
    >
      <div
        className={cn(
          'flex shrink-0 cursor-ew-resize items-center gap-1.5 text-[12px] transition-colors',
          isDragging ? 'text-ink' : 'text-ink/60 hover:text-ink/80',
        )}
        onPointerDown={handleLabelPointerDown}
        onPointerMove={handleLabelPointerMove}
        onPointerUp={handleLabelPointerUp}
        ref={labelRef}
      >
        <div
          className={cn(
            'grid grid-cols-2 gap-[2.5px] transition-opacity',
            isDragging ? 'opacity-70' : 'opacity-25 group-hover:opacity-45',
          )}
        >
          {[...Array(6)].map((_, i) => (
            <div className="h-[2px] w-[2px] rounded-full bg-current" key={i} />
          ))}
        </div>
        <span className="font-medium">{label}</span>
      </div>

      {hasBounds ? (
        <input
          type="range"
          className={cn(
            'ritn3d-slider mx-2 flex-1 cursor-pointer',
            isEditing && 'pointer-events-none opacity-50',
          )}
          min={min}
          max={max}
          step={step}
          value={value}
          onChange={handleRangeInput}
          onPointerDown={handleRangeDown}
          onPointerUp={handleRangeUp}
          disabled={isEditing}
        />
      ) : (
        <div className="flex-1" />
      )}

      <div className="flex items-center text-[12px]">
        {isEditing ? (
          <>
            <input
              autoFocus
              className="w-14 bg-transparent p-0 text-right font-mono tabular-nums text-ink outline-none selection:bg-[var(--color-accent)]/25"
              onBlur={submitValue}
              onChange={(e) => setInputValue(e.target.value)}
              onKeyDown={handleInputKeyDown}
              type="text"
              value={inputValue}
            />
            {unit && <span className="ml-[1px] text-ink/45">{unit}</span>}
          </>
        ) : (
          <div
            className="flex cursor-text items-center text-ink/65 transition-colors hover:text-ink"
            onClick={handleValueClick}
          >
            <span className="font-mono tabular-nums tracking-[-0.01em]">
              {Number(value.toFixed(precision)).toFixed(precision)}
            </span>
            {unit && <span className="ml-[1px] text-ink/45">{unit}</span>}
          </div>
        )}
      </div>
    </div>
  )
}
