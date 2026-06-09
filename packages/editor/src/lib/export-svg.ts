/**
 * Export floor plan as clean SVG file.
 */
import { cleanSvgForExport } from './export-pdf'

export function exportSVG() {
  const svg = document.querySelector('svg[data-floorplan-svg]') as SVGSVGElement | null
  if (!svg) { alert('No floor plan found. Draw some walls first.'); return }

  const clone = cleanSvgForExport(svg)

  const vb = svg.getAttribute('viewBox')
  if (vb) {
    const parts = vb.split(' ').map(Number)
    clone.setAttribute('width', `${(parts[2] ?? 100) * 50}`)
    clone.setAttribute('height', `${(parts[3] ?? 100) * 50}`)
  }

  const svgString = new XMLSerializer().serializeToString(clone)
  const blob = new Blob([svgString], { type: 'image/svg+xml' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `floorplan_${Date.now()}.svg`
  a.click()
  URL.revokeObjectURL(url)
}
