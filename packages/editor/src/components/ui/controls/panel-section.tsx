'use client'

import { ChevronDown } from 'lucide-react'
import { AnimatePresence, motion } from 'motion/react'
import { useState } from 'react'
import { cn } from '../../../lib/utils'

interface PanelSectionProps {
  title: string
  children: React.ReactNode
  defaultExpanded?: boolean
  className?: string
}

export function PanelSection({
  title,
  children,
  defaultExpanded = true,
  className,
}: PanelSectionProps) {
  const [isExpanded, setIsExpanded] = useState(defaultExpanded)

  return (
    <motion.div
      className={cn('flex shrink-0 flex-col overflow-hidden border-b border-hair', className)}
      layout
      transition={{ type: 'spring', bounce: 0, duration: 0.4 }}
    >
      {/* Ritn3D 2026-06-18: webapp Mono caps for section labels.
          font-mono + uppercase + letter-spacing — same micro-typography as
          AppShell section headings. Background stays paper to avoid the
          banded look. */}
      <motion.button
        className={cn(
          'group/section flex h-9 shrink-0 items-center justify-between px-3 transition-colors duration-200',
          'text-ink/55 hover:bg-ink/[0.03] hover:text-ink',
        )}
        layout="position"
        onClick={() => setIsExpanded(!isExpanded)}
        type="button"
      >
        <span className="truncate font-mono text-[11px] uppercase tracking-[0.02em]">{title}</span>
        <ChevronDown
          className={cn(
            'h-3.5 w-3.5 transition-transform duration-200',
            isExpanded ? 'rotate-180 text-ink/70' : 'rotate-0',
            !isExpanded && 'opacity-0 group-hover/section:opacity-100',
          )}
        />
      </motion.button>

      <AnimatePresence initial={false}>
        {isExpanded && (
          <motion.div
            animate={{ height: 'auto', opacity: 1 }}
            className="overflow-hidden"
            exit={{ height: 0, opacity: 0 }}
            initial={{ height: 0, opacity: 0 }}
            transition={{ type: 'spring', bounce: 0, duration: 0.4 }}
          >
            <div className="flex flex-col gap-1.5 p-3 pt-2">{children}</div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  )
}
