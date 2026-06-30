'use client'

import { ChevronLeft, RotateCcw, X } from 'lucide-react'
import Image from 'next/image'
import { cn } from '../../../lib/utils'

interface PanelWrapperProps {
  title: string
  icon?: string
  onClose?: () => void
  onReset?: () => void
  onBack?: () => void
  children: React.ReactNode
  className?: string
  width?: number | string
}

/*
  Ritn3D 2026-06-18: paper-themed panel wrapper. Pascal had a rounded-2xl
  charcoal floating card with heavy shadow. Webapp aesthetic = hairline
  border on paper, mild shadow, smaller header, display-font title.
*/
export function PanelWrapper({
  title,
  icon,
  onClose,
  onReset,
  onBack,
  children,
  className,
  width = 320,
}: PanelWrapperProps) {
  return (
    <div
      className={cn(
        'pointer-events-auto fixed top-20 right-4 z-50 flex max-h-[calc(100dvh-100px)] flex-col overflow-hidden rounded-md border border-hair bg-paper text-ink shadow-[0_8px_28px_rgba(22,24,28,0.08)]',
        className,
      )}
      style={{ width }}
    >
      {/* Header */}
      <div className="flex items-center justify-between border-b border-hair px-3 py-2.5">
        <div className="flex items-center gap-2">
          {onBack && (
            <button
              className="mr-1 flex h-7 w-7 items-center justify-center rounded-md text-ink/60 transition-colors hover:bg-ink/[0.05] hover:text-ink"
              onClick={onBack}
              type="button"
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
          )}
          {icon && (
            <Image alt="" className="shrink-0 object-contain opacity-80" height={14} src={icon} width={14} />
          )}
          <h2 className="font-display truncate text-[13px] font-semibold tracking-[-0.01em] text-ink">
            {title}
          </h2>
        </div>

        <div className="flex items-center gap-0.5">
          {onReset && (
            <button
              className="flex h-7 w-7 items-center justify-center rounded-md text-ink/55 transition-colors hover:bg-ink/[0.05] hover:text-ink"
              onClick={onReset}
              type="button"
              title="Reset"
            >
              <RotateCcw className="h-3.5 w-3.5" />
            </button>
          )}
          {onClose && (
            <button
              className="flex h-7 w-7 items-center justify-center rounded-md text-ink/55 transition-colors hover:bg-ink/[0.05] hover:text-ink"
              onClick={onClose}
              type="button"
              title="Close"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      </div>

      {/* Content */}
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">{children}</div>
    </div>
  )
}
