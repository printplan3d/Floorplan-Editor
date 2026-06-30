'use client'

import type { ButtonHTMLAttributes, ReactNode } from 'react'

/*
  Ritn3D 2026-06-18: port of D:\\Ritn3D_WebApp\\src\\components\\ui\\primitives.tsx.
  Single source of truth for the editor's paper / ink / hair / accent design
  language. Mirror of the webapp components so the two apps look identical.

  Auth-only primitives (Apple/Google buttons), blueprint poster, and other
  marketing-only widgets were intentionally not ported.
*/

// ---------------------------------------------------------------------------
// Logo
// ---------------------------------------------------------------------------
export function Logo({ size = 18 }: { size?: number }) {
  const cubePx = Math.round(size * 1.5)
  return (
    <div className="flex items-center gap-2.5">
      <svg
        width={cubePx}
        height={cubePx}
        viewBox="0 0 100 100"
        fill="none"
        aria-hidden
        className="text-ink"
        style={{ display: 'block' }}
      >
        <g strokeLinejoin="round" strokeLinecap="round">
          <path d="M20 72 L50 87 L80 72 L50 57 Z" fill="currentColor" fillOpacity="0.04" stroke="currentColor" strokeWidth="1.6" />
          <path d="M50 57 L50 87" stroke="currentColor" strokeWidth="1.3" />
          <path d="M50 72 L65 79.5" stroke="currentColor" strokeWidth="1.3" />
        </g>
        <g strokeLinejoin="round" strokeLinecap="round">
          <path d="M50 22 L50 57" stroke="currentColor" strokeOpacity="0.45" strokeWidth="1.04" strokeDasharray="2 2.6" />
          <path d="M20 37 L50 52 L80 37 L50 22 Z" fill="#2f6dab" fillOpacity="0.16" stroke="currentColor" strokeWidth="1.6" />
          <path d="M20 37 L20 72 L50 87 L50 52 Z" fill="#2f6dab" fillOpacity="0.26" stroke="currentColor" strokeWidth="1.6" />
          <path d="M80 37 L80 72 L50 87 L50 52 Z" fill="#2f6dab" fillOpacity="0.08" stroke="currentColor" strokeWidth="1.6" />
        </g>
      </svg>
      <span
        className="font-display text-ink"
        style={{
          fontSize: Math.round(size * 1.05),
          fontWeight: 700,
          letterSpacing: '-0.035em',
          lineHeight: 1,
        }}
      >
        Ritn<span className="text-[var(--color-accent)]">3D</span>
      </span>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Hairline
// ---------------------------------------------------------------------------
export function Hairline({ vertical = false, className = '' }: { vertical?: boolean; className?: string }) {
  return vertical
    ? <div className={`w-px self-stretch bg-hair ${className}`} />
    : <div className={`h-px w-full bg-hair ${className}`} />
}

// ---------------------------------------------------------------------------
// FrameTicks — corner-tick framed block
// ---------------------------------------------------------------------------
export function FrameTicks({
  children,
  className = '',
  padding = 'p-6',
}: { children: ReactNode; className?: string; padding?: string }) {
  return (
    <div className={`relative border border-hair ${padding} ${className}`}>
      <span className="absolute -top-px -left-px w-2 h-2 border-t border-l border-ink" />
      <span className="absolute -top-px -right-px w-2 h-2 border-t border-r border-ink" />
      <span className="absolute -bottom-px -left-px w-2 h-2 border-b border-l border-ink" />
      <span className="absolute -bottom-px -right-px w-2 h-2 border-b border-r border-ink" />
      {children}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Btn
// ---------------------------------------------------------------------------
type BtnVariant = 'primary' | 'secondary' | 'ghost' | 'accent' | 'danger'
type BtnSize = 'sm' | 'md' | 'lg'

export function Btn({
  children,
  variant = 'primary',
  size = 'md',
  className = '',
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: BtnVariant; size?: BtnSize }) {
  const sizes: Record<BtnSize, string> = {
    sm: 'h-8 px-3 text-[13px]',
    md: 'h-9 px-4 text-[13.5px]',
    lg: 'h-11 px-5 text-[14px]',
  }
  const variants: Record<BtnVariant, string> = {
    primary: 'bg-ink text-paper hover:bg-ink/90',
    secondary: 'bg-transparent text-ink border border-hair hover:bg-ink/[0.03]',
    ghost: 'bg-transparent text-ink hover:bg-ink/[0.04]',
    accent: 'bg-[var(--color-accent)] text-white hover:opacity-90',
    danger: 'bg-transparent text-red-700 border border-red-200 hover:bg-red-50',
  }
  return (
    <button
      className={`inline-flex items-center justify-center gap-2 rounded-md font-medium tracking-[-0.005em] transition-colors duration-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]/40 focus-visible:ring-offset-2 focus-visible:ring-offset-paper ${sizes[size]} ${variants[variant]} ${className}`}
      {...rest}
    >
      {children}
    </button>
  )
}

// ---------------------------------------------------------------------------
// Badge
// ---------------------------------------------------------------------------
export type BadgeTone = 'neutral' | 'ready' | 'rendering' | 'pending' | 'failed' | 'accent'
export function Badge({
  children,
  tone = 'neutral',
  className = '',
}: { children: ReactNode; tone?: BadgeTone; className?: string }) {
  const tones: Record<BadgeTone, string> = {
    neutral: 'bg-ink/[0.04] text-ink/70 border border-hair',
    ready: 'bg-emerald-50 text-emerald-800 border border-emerald-200/70',
    rendering: 'bg-amber-50 text-amber-800 border border-amber-200/70',
    pending: 'bg-ink/[0.04] text-ink/60 border border-hair',
    failed: 'bg-red-50 text-red-800 border border-red-200/70',
    accent: 'bg-[var(--color-accent)]/10 text-[var(--color-accent)] border border-[var(--color-accent)]/20',
  }
  return (
    <span className={`inline-flex items-center gap-1.5 px-2 h-[22px] rounded-[5px] text-[11px] font-medium tracking-[0.02em] uppercase font-mono ${tones[tone]} ${className}`}>
      {children}
    </span>
  )
}

// ---------------------------------------------------------------------------
// StatusDot
// ---------------------------------------------------------------------------
export type DotTone = 'ready' | 'rendering' | 'pending' | 'failed'
export function StatusDot({ tone = 'ready' }: { tone?: DotTone }) {
  const tones: Record<DotTone, string> = {
    ready: 'bg-emerald-500',
    rendering: 'bg-amber-500',
    pending: 'bg-ink/30',
    failed: 'bg-red-500',
  }
  return (
    <span className="relative inline-flex w-1.5 h-1.5">
      <span className={`absolute inset-0 rounded-full ${tones[tone]}`} />
      {tone === 'rendering' && (
        <span className={`absolute inset-0 rounded-full ${tones[tone]} animate-ping opacity-50`} />
      )}
    </span>
  )
}

// ---------------------------------------------------------------------------
// Mono — monospace technical label
// ---------------------------------------------------------------------------
export function Mono({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <span className={`font-mono text-[11px] tracking-[0.02em] uppercase text-ink/50 ${className}`}>
      {children}
    </span>
  )
}

// ---------------------------------------------------------------------------
// DotGrid — blueprint dot-grid bg
// ---------------------------------------------------------------------------
export function DotGrid({
  className = '',
  opacity = 0.5,
  animated = false,
}: { className?: string; opacity?: number; animated?: boolean }) {
  return (
    <div
      className={`absolute inset-0 pointer-events-none ${animated ? 'dot-drift' : ''} ${className}`}
      style={{
        opacity,
        backgroundImage:
          'radial-gradient(circle at 1px 1px, rgba(22,24,28,0.08) 1px, transparent 0)',
        backgroundSize: '24px 24px',
      }}
    />
  )
}

// ---------------------------------------------------------------------------
// Field — label + child input
// ---------------------------------------------------------------------------
export function Field({
  label,
  children,
  right,
}: { label: string; children: ReactNode; right?: ReactNode }) {
  return (
    <label className="block">
      <div className="flex items-center justify-between mb-1.5">
        <Mono>{label}</Mono>
        {right}
      </div>
      {children}
    </label>
  )
}

// ---------------------------------------------------------------------------
// Icon set
// ---------------------------------------------------------------------------
export function ArrowRight() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
      <path d="M3 7H11M11 7L7.5 3.5M11 7L7.5 10.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

export function ArrowLeft() {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
      <path d="M6.5 2.5L4 5L6.5 7.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

export function CheckIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 11 11" fill="none">
      <path d="M2 5.5L4.5 8L9 3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}
