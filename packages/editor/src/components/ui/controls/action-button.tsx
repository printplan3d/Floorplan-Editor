'use client'

import { cn } from '../../../lib/utils'

interface ActionButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  icon?: React.ReactNode
  label: string
}

/*
  Ritn3D 2026-06-18: paper-themed action button — same shape and weight as
  webapp's secondary Btn variant (hairline border, paper fill, ink text,
  subtle hover bg). Pascal had hardcoded #2C2C2E charcoal which was bright
  on the new paper background.
*/
export function ActionButton({ icon, label, className, ...props }: ActionButtonProps) {
  return (
    <button
      {...props}
      className={cn(
        'flex h-8 flex-1 items-center justify-center gap-1.5 rounded-md border border-hair bg-paper px-3 font-medium text-[12px] text-ink/80 transition-colors hover:bg-ink/[0.04] hover:text-ink active:bg-ink/[0.06] disabled:opacity-40 disabled:cursor-not-allowed',
        className,
      )}
    >
      {icon}
      <span>{label}</span>
    </button>
  )
}

export function ActionGroup({
  children,
  className,
}: {
  children: React.ReactNode
  className?: string
}) {
  return <div className={cn('flex gap-1.5', className)}>{children}</div>
}
