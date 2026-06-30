'use client'

/*
  Ritn3D 2026-06-18: hand-drawn 14px stroke-1.2 icons matching the webapp's
  AppShell. Lucide's default stroke-width 2 looked heavier than the webapp's
  micro-sketched icons in the same context. These are the most-visible icons
  on the editor sidebar.

  All use currentColor so they tint via parent text colour. ViewBox 14×14
  for tight packing; stroke 1.1–1.2 to match webapp weight.
*/

type IconProps = { className?: string; size?: number }

function box({ className, size }: IconProps, content: React.ReactNode) {
  return (
    <svg
      width={size ?? 14}
      height={size ?? 14}
      viewBox="0 0 14 14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.1"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      {content}
    </svg>
  )
}

export const StackIcon = (p: IconProps) => box(p, (
  <>
    <rect x="1.5" y="1.5" width="11" height="3" rx="0.5" />
    <rect x="1.5" y="5.75" width="11" height="3" rx="0.5" />
    <rect x="1.5" y="10" width="11" height="2.5" rx="0.5" />
  </>
))

export const PlusIcon = (p: IconProps) => box(p, (
  <path d="M7 2.5V11.5M2.5 7H11.5" strokeWidth="1.2" />
))

export const CardIcon = (p: IconProps) => box(p, (
  <>
    <rect x="1.5" y="3" width="11" height="8" rx="1" />
    <path d="M1.5 5.75H12.5" />
  </>
))

export const GearIcon = (p: IconProps) => box(p, (
  <>
    <circle cx="7" cy="7" r="2" />
    <path d="M7 1.5V3M7 11V12.5M2.5 7H1M13 7H11.5M3.7 3.7L4.7 4.7M9.3 9.3L10.3 10.3M3.7 10.3L4.7 9.3M9.3 4.7L10.3 3.7" />
  </>
))

export const TrashIcon = (p: IconProps) => box(p, (
  <>
    <path d="M2 3.5H12" strokeWidth="1.2" />
    <path d="M5.5 3.5V2.25C5.5 2 5.7 1.8 5.95 1.8H8.05C8.3 1.8 8.5 2 8.5 2.25V3.5" />
    <path d="M3 3.5V11.7C3 12 3.25 12.2 3.5 12.2H10.5C10.75 12.2 11 12 11 11.7V3.5" />
    <path d="M5.5 6V10M8.5 6V10" />
  </>
))

export const ResetViewIcon = (p: IconProps) => box(p, (
  <>
    <path d="M9 1.5H12.5V5" strokeWidth="1.2" />
    <path d="M5 12.5H1.5V9" strokeWidth="1.2" />
    <path d="M12.5 1.5L8.5 5.5" />
    <path d="M1.5 12.5L5.5 8.5" />
  </>
))

export const EyeIcon = (p: IconProps) => box(p, (
  <>
    <path d="M1.5 7C1.5 7 3.5 3 7 3C10.5 3 12.5 7 12.5 7C12.5 7 10.5 11 7 11C3.5 11 1.5 7 1.5 7Z" />
    <circle cx="7" cy="7" r="1.6" />
  </>
))

export const EyeOffIcon = (p: IconProps) => box(p, (
  <>
    <path d="M2 7C2 7 4 4 7 4M12 7C12 7 10.5 9 8.4 9.9" />
    <path d="M5.6 4.4C6 4.2 6.5 4 7 4C10.5 4 12.5 7 12.5 7" strokeOpacity="0.4" />
    <path d="M1 1L13 13" strokeWidth="1.2" />
  </>
))

export const ChevronRightIcon = (p: IconProps) => box(p, (
  <path d="M5 3.5L8.5 7L5 10.5" strokeWidth="1.2" />
))

export const ChevronDownIcon = (p: IconProps) => box(p, (
  <path d="M3.5 5L7 8.5L10.5 5" strokeWidth="1.2" />
))

export const SaveIcon = (p: IconProps) => box(p, (
  <>
    <path d="M2 2.5C2 2.2 2.2 2 2.5 2H10L12 4V11.5C12 11.8 11.8 12 11.5 12H2.5C2.2 12 2 11.8 2 11.5V2.5Z" />
    <path d="M4 2V5H9V2" />
    <path d="M4 9H10" />
  </>
))

export const UploadIcon = (p: IconProps) => box(p, (
  <>
    <path d="M7 1.5V8.5M7 1.5L4.5 4M7 1.5L9.5 4" strokeWidth="1.2" />
    <path d="M2.5 9V11.5C2.5 11.8 2.7 12 3 12H11C11.3 12 11.5 11.8 11.5 11.5V9" />
  </>
))

export const DownloadIcon = (p: IconProps) => box(p, (
  <>
    <path d="M7 1.5V8.5M7 8.5L4.5 6M7 8.5L9.5 6" strokeWidth="1.2" />
    <path d="M2.5 9V11.5C2.5 11.8 2.7 12 3 12H11C11.3 12 11.5 11.8 11.5 11.5V9" />
  </>
))

export const CameraIcon = (p: IconProps) => box(p, (
  <>
    <path d="M1.5 4.5C1.5 4.2 1.7 4 2 4H4L5 2.5H9L10 4H12C12.3 4 12.5 4.2 12.5 4.5V11C12.5 11.3 12.3 11.5 12 11.5H2C1.7 11.5 1.5 11.3 1.5 11V4.5Z" />
    <circle cx="7" cy="7.5" r="2" />
  </>
))

export const KeyboardIcon = (p: IconProps) => box(p, (
  <>
    <rect x="1" y="3.5" width="12" height="7" rx="0.7" />
    <path d="M3 6h0.1M5 6h0.1M7 6h0.1M9 6h0.1M11 6h0.1M3.5 8.5H10.5" />
  </>
))

export const PencilIcon = (p: IconProps) => box(p, (
  <>
    <path d="M9 2L12 5L5 12L2 12L2 9L9 2Z" />
    <path d="M8 3L11 6" />
  </>
))

export const LayersIcon = (p: IconProps) => box(p, (
  <>
    <path d="M7 1.5L12.5 4.5L7 7.5L1.5 4.5L7 1.5Z" />
    <path d="M1.5 7.5L7 10.5L12.5 7.5" />
    <path d="M1.5 10L7 13L12.5 10" />
  </>
))

export const BuildingIcon = (p: IconProps) => box(p, (
  <>
    <path d="M2 12V3L7 1.5L7 12" />
    <path d="M7 5L12 6V12" />
    <path d="M3.5 5H5M3.5 7H5M3.5 9H5M8.5 7.5H10.5M8.5 9.5H10.5" />
  </>
))

export const HexagonIcon = (p: IconProps) => box(p, (
  <path d="M7 1.5L12 4.5V9.5L7 12.5L2 9.5V4.5L7 1.5Z" />
))

export const VolumeIcon = (p: IconProps) => box(p, (
  <>
    <path d="M2 5.5V8.5H4L7 11V3L4 5.5H2Z" />
    <path d="M9.5 5.5C10 6 10.3 6.5 10.3 7C10.3 7.5 10 8 9.5 8.5" />
    <path d="M11 4C11.8 4.8 12.3 5.9 12.3 7C12.3 8.1 11.8 9.2 11 10" />
  </>
))

export const VolumeOffIcon = (p: IconProps) => box(p, (
  <>
    <path d="M2 5.5V8.5H4L7 11V3L4 5.5H2Z" />
    <path d="M9 5L12 8M12 5L9 8" strokeWidth="1.2" />
  </>
))

export const MoonIcon = (p: IconProps) => box(p, (
  <path d="M11.5 8C10.8 9.7 9.1 11 7 11C4.2 11 2 8.8 2 6C2 3.9 3.3 2.2 5 1.5C4.4 2.3 4 3.3 4 4.5C4 7 6 9 8.5 9C9.7 9 10.7 8.6 11.5 8Z" />
))

export const SunIcon = (p: IconProps) => box(p, (
  <>
    <circle cx="7" cy="7" r="2.5" />
    <path d="M7 1V2.5M7 11.5V13M1 7H2.5M11.5 7H13M2.8 2.8L3.85 3.85M10.15 10.15L11.2 11.2M2.8 11.2L3.85 10.15M10.15 3.85L11.2 2.8" />
  </>
))
