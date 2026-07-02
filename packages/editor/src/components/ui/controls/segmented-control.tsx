'use client'

import { cn } from '../../../lib/utils'

interface SegmentedControlProps<T extends string> {
  value: T
  onChange: (value: T) => void
  options: { label: React.ReactNode; value: T }[]
  className?: string
}

/*
  Ritn3D 2026-06-18: paper-themed segmented control. Was hardcoded charcoal
  (bg-[#2C2C2E] / #3e3e3e) — invisible-dark against the new paper background.
  Now: hairline outer border on paper, ink fill for the selected pill, ghost
  ink hover for the others. Same shape as webapp Btn-primary/secondary pair.
*/
export function SegmentedControl<T extends string>({
  value,
  onChange,
  options,
  className,
}: SegmentedControlProps<T>) {
  return (
    <div
      className={cn(
        'flex h-9 w-full items-center rounded-md border border-hair bg-ink/[0.03] p-[3px]',
        className,
      )}
    >
      {options.map((option) => {
        const isSelected = value === option.value
        return (
          <button
            className={cn(
              'relative flex h-full flex-1 items-center justify-center rounded-[5px] text-[12.5px] font-medium tracking-[-0.005em] transition-colors duration-150',
              isSelected
                ? 'bg-ink text-paper shadow-sm'
                : 'text-ink/60 hover:text-ink hover:bg-ink/[0.05]',
            )}
            key={option.value}
            onClick={() => onChange(option.value)}
            type="button"
          >
            <span className="relative z-10 flex items-center gap-1.5">{option.label}</span>
          </button>
        )
      })}
    </div>
  )
}
