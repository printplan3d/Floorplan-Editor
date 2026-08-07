/**
 * Export floor plan as PDF — A4, to-scale, with title block.
 * Multi-level: each level on its own page.
 */
import { type AnyNodeId, type BuildingNode, type LevelNode, useScene } from '@ritn3d/core'
import { useViewer } from '@ritn3d/viewer'

const STANDARD_SCALES = [
  { ratio: 1/50, label: '1:50' },
  { ratio: 1/75, label: '1:75' },
  { ratio: 1/100, label: '1:100' },
  { ratio: 1/150, label: '1:150' },
  { ratio: 1/200, label: '1:200' },
  { ratio: 1/250, label: '1:250' },
]

export function exportPDF() {
  const svg = document.querySelector('svg[data-floorplan-svg]') as SVGSVGElement | null
  if (!svg) { alert('No floor plan found. Draw some walls first.'); return }

  const vb = svg.getAttribute('viewBox')
  const [, , vbW, vbH] = (vb || '0 0 20 20').split(' ').map(Number)

  const isLandscape = (vbW ?? 20) >= (vbH ?? 20)
  const autoOrientation = isLandscape ? 'landscape' : 'portrait'
  const bestAutoScale = pickBestScale(vbW!, vbH!, autoOrientation)

  // Get all levels
  const levels = getAllLevels()

  showExportDialog(svg, vbW!, vbH!, autoOrientation, bestAutoScale, levels)
}

function getAllLevels(): { id: string; label: string; level: number }[] {
  const { nodes } = useScene.getState()
  const { selection } = useViewer.getState()

  const buildingId = selection.buildingId
  if (!buildingId) return []

  const building = nodes[buildingId as AnyNodeId] as BuildingNode | undefined
  if (!building || building.type !== 'building') return []

  return building.children
    .map(id => nodes[id as AnyNodeId])
    .filter((n): n is LevelNode => n?.type === 'level')
    .sort((a, b) => (a.level ?? 0) - (b.level ?? 0))
    .map(l => ({
      id: l.id,
      label: l.name || `Level ${l.level ?? 0}`,
      level: l.level ?? 0,
    }))
}

function pickBestScale(vbW: number, vbH: number, orientation: string): typeof STANDARD_SCALES[0] {
  const pageW = orientation === 'landscape' ? 277 : 190
  const pageH = orientation === 'landscape' ? 165 : 255
  const rawScale = Math.min(pageW / (vbW * 1000), pageH / (vbH * 1000))

  let best = STANDARD_SCALES[STANDARD_SCALES.length - 1]!
  for (const s of STANDARD_SCALES) {
    if (s.ratio <= rawScale) { best = s; break }
  }
  return best
}

function showExportDialog(
  svg: SVGSVGElement, vbW: number, vbH: number,
  autoOrientation: string, autoScale: typeof STANDARD_SCALES[0],
  levels: { id: string; label: string; level: number }[]
) {
  const hasMultipleLevels = levels.length > 1
  const dialog = document.createElement('div')
  dialog.style.cssText = 'position:fixed;inset:0;z-index:10000;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,0.6);backdrop-filter:blur(4px);'

  dialog.innerHTML = `
    <div style="background:#1c1c1e;border:1px solid rgba(255,255,255,0.1);border-radius:16px;padding:24px;width:340px;color:#e5e5e5;font-family:system-ui,sans-serif;">
      <h3 style="margin:0 0 16px;font-size:15px;font-weight:600;color:white;">Export PDF</h3>

      <label style="display:block;margin-bottom:12px;">
        <span style="font-size:11px;color:#9ca3af;text-transform:uppercase;letter-spacing:0.5px;">Orientation</span>
        <div style="display:flex;gap:6px;margin-top:6px;">
          <button data-orient="landscape" class="orient-btn" style="flex:1;padding:8px;border-radius:8px;border:1px solid rgba(255,255,255,0.15);background:${autoOrientation === 'landscape' ? 'rgba(13,148,136,0.2)' : 'rgba(255,255,255,0.05)'};color:${autoOrientation === 'landscape' ? '#5eead4' : '#9ca3af'};font-size:12px;font-weight:500;cursor:pointer;">Landscape</button>
          <button data-orient="portrait" class="orient-btn" style="flex:1;padding:8px;border-radius:8px;border:1px solid rgba(255,255,255,0.15);background:${autoOrientation === 'portrait' ? 'rgba(13,148,136,0.2)' : 'rgba(255,255,255,0.05)'};color:${autoOrientation === 'portrait' ? '#5eead4' : '#9ca3af'};font-size:12px;font-weight:500;cursor:pointer;">Portrait</button>
        </div>
      </label>

      <label style="display:block;margin-bottom:12px;">
        <span style="font-size:11px;color:#9ca3af;text-transform:uppercase;letter-spacing:0.5px;">Scale</span>
        <div style="display:flex;flex-wrap:wrap;gap:4px;margin-top:6px;">
          ${STANDARD_SCALES.map(s => `<button data-scale="${s.ratio}" data-label="${s.label}" class="scale-btn" style="padding:6px 10px;border-radius:6px;border:1px solid rgba(255,255,255,0.15);background:${s.label === autoScale.label ? 'rgba(13,148,136,0.2)' : 'rgba(255,255,255,0.05)'};color:${s.label === autoScale.label ? '#5eead4' : '#9ca3af'};font-size:11px;font-weight:500;cursor:pointer;">${s.label}</button>`).join('')}
        </div>
        <span style="font-size:10px;color:#6b7280;margin-top:4px;display:block;">${autoScale.label} auto-selected to fit A4</span>
      </label>

      ${hasMultipleLevels ? `
      <label style="display:block;margin-bottom:16px;">
        <span style="font-size:11px;color:#9ca3af;text-transform:uppercase;letter-spacing:0.5px;">Levels</span>
        <div style="display:flex;gap:6px;margin-top:6px;">
          <button data-levels="current" class="levels-btn" style="flex:1;padding:8px;border-radius:8px;border:1px solid rgba(255,255,255,0.15);background:rgba(255,255,255,0.05);color:#9ca3af;font-size:12px;font-weight:500;cursor:pointer;">Current Only</button>
          <button data-levels="all" class="levels-btn" style="flex:1;padding:8px;border-radius:8px;border:1px solid rgba(255,255,255,0.15);background:rgba(13,148,136,0.2);color:#5eead4;font-size:12px;font-weight:500;cursor:pointer;">All Levels (${levels.length} pages)</button>
        </div>
      </label>
      ` : ''}

      <div style="display:flex;gap:8px;">
        <button id="pdf-cancel" style="flex:1;padding:10px;border-radius:8px;border:1px solid rgba(255,255,255,0.15);background:rgba(255,255,255,0.05);color:#9ca3af;font-size:13px;font-weight:500;cursor:pointer;">Cancel</button>
        <button id="pdf-export" style="flex:1;padding:10px;border-radius:8px;border:none;background:#0d9488;color:white;font-size:13px;font-weight:600;cursor:pointer;">Export</button>
      </div>
    </div>
  `

  document.body.appendChild(dialog)

  let selectedOrientation = autoOrientation
  let selectedScale = autoScale
  let exportAllLevels = hasMultipleLevels

  // Orientation buttons
  dialog.querySelectorAll('.orient-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      selectedOrientation = (btn as HTMLElement).dataset.orient!
      dialog.querySelectorAll('.orient-btn').forEach(b => {
        const el = b as HTMLElement
        const active = el.dataset.orient === selectedOrientation
        el.style.background = active ? 'rgba(13,148,136,0.2)' : 'rgba(255,255,255,0.05)'
        el.style.color = active ? '#5eead4' : '#9ca3af'
      })
      const newBest = pickBestScale(vbW, vbH, selectedOrientation)
      selectedScale = newBest
      dialog.querySelectorAll('.scale-btn').forEach(b => {
        const el = b as HTMLElement
        const active = el.dataset.label === newBest.label
        el.style.background = active ? 'rgba(13,148,136,0.2)' : 'rgba(255,255,255,0.05)'
        el.style.color = active ? '#5eead4' : '#9ca3af'
      })
    })
  })

  // Scale buttons
  dialog.querySelectorAll('.scale-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const el = btn as HTMLElement
      selectedScale = { ratio: parseFloat(el.dataset.scale!), label: el.dataset.label! }
      dialog.querySelectorAll('.scale-btn').forEach(b => {
        const bel = b as HTMLElement
        const active = bel.dataset.label === selectedScale.label
        bel.style.background = active ? 'rgba(13,148,136,0.2)' : 'rgba(255,255,255,0.05)'
        bel.style.color = active ? '#5eead4' : '#9ca3af'
      })
    })
  })

  // Levels buttons
  dialog.querySelectorAll('.levels-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      exportAllLevels = (btn as HTMLElement).dataset.levels === 'all'
      dialog.querySelectorAll('.levels-btn').forEach(b => {
        const el = b as HTMLElement
        const active = (el.dataset.levels === 'all') === exportAllLevels
        el.style.background = active ? 'rgba(13,148,136,0.2)' : 'rgba(255,255,255,0.05)'
        el.style.color = active ? '#5eead4' : '#9ca3af'
      })
    })
  })

  dialog.querySelector('#pdf-cancel')!.addEventListener('click', () => dialog.remove())
  dialog.addEventListener('click', (e) => { if (e.target === dialog) dialog.remove() })

  dialog.querySelector('#pdf-export')!.addEventListener('click', async () => {
    dialog.remove()
    if (exportAllLevels && levels.length > 1) {
      await generateMultiLevelPDF(levels, selectedOrientation, selectedScale)
    } else {
      generatePDF(svg, vbW, vbH, selectedOrientation, selectedScale, null)
    }
  })
}

async function generateMultiLevelPDF(
  levels: { id: string; label: string; level: number }[],
  orientation: string,
  scale: { ratio: number; label: string }
) {
  const originalLevelId = useViewer.getState().selection.levelId
  const svgPages: { svgString: string; label: string; vbW: number; vbH: number }[] = []

  for (const level of levels) {
    // Switch to this level
    useViewer.getState().setSelection({ levelId: level.id as any })

    // Wait for React to re-render the SVG
    await new Promise(r => setTimeout(r, 300))

    const svg = document.querySelector('svg[data-floorplan-svg]') as SVGSVGElement | null
    if (!svg) continue

    const vb = svg.getAttribute('viewBox')
    const [, , vbW, vbH] = (vb || '0 0 20 20').split(' ').map(Number)

    const clone = cleanSvgForExport(svg)
    const svgWidthMM = vbW! * 1000 * scale.ratio
    const svgHeightMM = vbH! * 1000 * scale.ratio
    clone.setAttribute('width', `${svgWidthMM}mm`)
    clone.setAttribute('height', `${svgHeightMM}mm`)

    svgPages.push({
      svgString: new XMLSerializer().serializeToString(clone),
      label: level.label,
      vbW: vbW!,
      vbH: vbH!,
    })
  }

  // Restore original level
  if (originalLevelId) {
    useViewer.getState().setSelection({ levelId: originalLevelId as any })
  }

  // Generate multi-page PDF
  const date = new Date().toLocaleDateString()
  const printWindow = window.open('', '_blank', 'width=1200,height=800')
  if (!printWindow) { alert('Please allow popups.'); return }

  // HTML-escape user-typed level names before templating them into the
  // pagesHtml block below. Without this a user-typed level name like
  // `<script>` would execute inside the export window (same origin, so
  // it can read cookies/localStorage). Self-XSS is still XSS.
  const escapeHtml = (s: string) =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')

  const pagesHtml = svgPages.map((page, i) => `
    <div class="page ${i > 0 ? 'page-break' : ''}">
      <div class="drawing-area">${page.svgString}</div>
      <div class="title-block">
        <div class="title-left">
          <div class="logo">Ritn<span>3D</span></div>
          <div class="project-info">${escapeHtml(page.label)}<br>${escapeHtml(date)}</div>
        </div>
        <div class="title-right">
          <div class="scale-bar">
            <div class="scale-bar-graphic">
              <div style="width:10mm;background:#000;"></div>
              <div style="width:10mm;background:#fff;"></div>
              <div style="width:10mm;background:#000;"></div>
            </div>
            <div class="scale-bar-labels" style="width:30mm;justify-content:space-between;">
              <span>0</span>
              <span>${Math.round(10 / scale.ratio / 1000)}m</span>
              <span>${Math.round(20 / scale.ratio / 1000)}m</span>
              <span>${Math.round(30 / scale.ratio / 1000)}m</span>
            </div>
          </div>
          <div class="scale-label">${scale.label}</div>
          <div class="north-arrow">
            <svg viewBox="0 0 24 24" fill="none"><polygon points="12,2 15,10 12,8 9,10" fill="#ef4444"/><polygon points="12,22 9,14 12,16 15,14" fill="#94a3b8"/><line x1="12" y1="2" x2="12" y2="22" stroke="#64748b" stroke-width="0.5"/></svg>
            <span>N</span>
          </div>
          <div class="page-num">Page ${i + 1}/${svgPages.length}</div>
        </div>
      </div>
    </div>
  `).join('')

  printWindow.document.write(getPdfHtml(orientation, pagesHtml, date, scale))
  printWindow.document.close()
}

function generatePDF(
  svg: SVGSVGElement, vbW: number, vbH: number,
  orientation: string, scale: { ratio: number; label: string },
  levelLabel: string | null
) {
  const clone = cleanSvgForExport(svg)
  clone.setAttribute('width', `${vbW * 1000 * scale.ratio}mm`)
  clone.setAttribute('height', `${vbH * 1000 * scale.ratio}mm`)

  const svgString = new XMLSerializer().serializeToString(clone)
  const date = new Date().toLocaleDateString()

  const pageHtml = `
    <div class="page">
      <div class="drawing-area">${svgString}</div>
      <div class="title-block">
        <div class="title-left">
          <div class="logo">Ritn<span>3D</span></div>
          <div class="project-info">${levelLabel || 'Floor Plan'}<br>${date}</div>
        </div>
        <div class="title-right">
          <div class="scale-bar">
            <div class="scale-bar-graphic">
              <div style="width:10mm;background:#000;"></div>
              <div style="width:10mm;background:#fff;"></div>
              <div style="width:10mm;background:#000;"></div>
            </div>
            <div class="scale-bar-labels" style="width:30mm;justify-content:space-between;">
              <span>0</span>
              <span>${Math.round(10 / scale.ratio / 1000)}m</span>
              <span>${Math.round(20 / scale.ratio / 1000)}m</span>
              <span>${Math.round(30 / scale.ratio / 1000)}m</span>
            </div>
          </div>
          <div class="scale-label">${scale.label}</div>
          <div class="north-arrow">
            <svg viewBox="0 0 24 24" fill="none"><polygon points="12,2 15,10 12,8 9,10" fill="#ef4444"/><polygon points="12,22 9,14 12,16 15,14" fill="#94a3b8"/><line x1="12" y1="2" x2="12" y2="22" stroke="#64748b" stroke-width="0.5"/></svg>
            <span>N</span>
          </div>
        </div>
      </div>
    </div>
  `

  const printWindow = window.open('', '_blank', 'width=1200,height=800')
  if (!printWindow) { alert('Please allow popups.'); return }
  printWindow.document.write(getPdfHtml(orientation, pageHtml, date, scale))
  printWindow.document.close()
}

function getPdfHtml(orientation: string, pagesHtml: string, date: string, scale: { ratio: number; label: string }) {
  return `<!DOCTYPE html>
<html><head><title>Floor Plan — Ritn3D</title>
<link href="https://fonts.googleapis.com/css2?family=Montserrat:wght@700&family=Inter:wght@400;500;600&display=swap" rel="stylesheet">
<style>
  @page { size: A4 ${orientation}; margin: 10mm; }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { width: 100%; }
  body { font-family: 'Inter', system-ui, sans-serif; background: white; }

  .page {
    width: 100%; height: 100vh;
    display: flex; flex-direction: column;
    page-break-inside: avoid;
  }
  .page-break { page-break-before: always; }

  .drawing-area {
    flex: 1; display: flex; align-items: center; justify-content: center;
    overflow: hidden; padding: 2mm;
  }
  .drawing-area svg { max-width: 100%; max-height: 100%; }

  .title-block {
    display: flex; align-items: center; justify-content: space-between;
    border-top: 0.5mm solid #000; padding: 2mm 0 0; height: 14mm; flex-shrink: 0;
  }
  .title-left { display: flex; align-items: center; gap: 3mm; }
  .logo { font-family: 'Montserrat', sans-serif; font-weight: 700; font-size: 12pt; color: #1e293b; letter-spacing: -0.5px; }
  .logo span { color: #0d9488; }
  .project-info { font-size: 7pt; color: #64748b; line-height: 1.4; }
  .title-right { display: flex; align-items: center; gap: 5mm; font-size: 7pt; color: #64748b; }
  .scale-label { font-size: 9pt; font-weight: 600; color: #1e293b; border: 0.3mm solid #cbd5e1; border-radius: 1mm; padding: 1mm 2.5mm; }
  .north-arrow { display: flex; flex-direction: column; align-items: center; gap: 0.5mm; }
  .north-arrow svg { width: 5mm; height: 5mm; }
  .north-arrow span { font-size: 6pt; font-weight: 700; color: #ef4444; }
  .scale-bar { display: flex; flex-direction: column; gap: 0.3mm; }
  .scale-bar-graphic { display: flex; height: 1.5mm; }
  .scale-bar-graphic div { height: 100%; border: 0.2mm solid #000; }
  .scale-bar-labels { display: flex; font-size: 5pt; color: #64748b; }
  .page-num { font-size: 7pt; color: #94a3b8; font-weight: 500; }

  .actions { text-align: center; padding: 8px; }
  .actions button { padding: 8px 24px; background: #0d9488; color: white; border: none; border-radius: 6px; font-size: 13px; font-weight: 600; cursor: pointer; }
  @media print { .actions { display: none; } }
</style></head>
<body>
  ${pagesHtml}
  <div class="actions"><button onclick="window.print();setTimeout(()=>window.close(),500)">Print / Save as PDF</button></div>
</body></html>`
}

export function cleanSvgForExport(svg: SVGSVGElement): SVGSVGElement {
  const clone = svg.cloneNode(true) as SVGSVGElement
  clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg')
  clone.removeAttribute('data-floorplan-svg')
  clone.removeAttribute('class')
  clone.style.cssText = ''

  const bg = clone.querySelector('rect')
  if (bg) bg.setAttribute('fill', '#ffffff')

  // Remove grid
  clone.querySelectorAll('path[shape-rendering="crispEdges"]').forEach(el => el.remove())
  // Remove hit zones
  clone.querySelectorAll('*[stroke="transparent"]').forEach(el => el.remove())
  // Remove hover effects
  clone.querySelectorAll('*').forEach(el => {
    const style = el.getAttribute('style') || ''
    if (style.includes('opacity: 0') && el.getAttribute('pointer-events') === 'none') el.remove()
  })

  // Walls — black bold
  clone.querySelectorAll('[data-element="wall"]').forEach(el => {
    el.setAttribute('fill', '#000000')
    el.setAttribute('stroke', '#000000')
    el.setAttribute('stroke-width', '0.02')
    el.removeAttribute('data-element')
  })

  // Doors — white gap with dark outline
  clone.querySelectorAll('[data-element="door"]').forEach(el => {
    el.setAttribute('fill', '#ffffff')
    el.setAttribute('stroke', '#333333')
    el.setAttribute('stroke-width', '0.02')
    el.removeAttribute('data-element')
  })

  // Windows — white gap with dark outline
  clone.querySelectorAll('[data-element="window"]').forEach(el => {
    el.setAttribute('fill', '#ffffff')
    el.setAttribute('stroke', '#333333')
    el.setAttribute('stroke-width', '0.02')
    el.removeAttribute('data-element')
  })

  // The storey-below underlay is an authoring aid, not part of the drawing.
  // A downloaded plan of level 1 showing level 0's walls ghosted through it
  // is just noise on paper.
  clone.querySelectorAll('[data-element="ghost"]').forEach(el => el.remove())

  // Stairs — outline and treads in dark line work, no fill. The on-screen
  // fill is a selection affordance; on paper it prints as a grey smear over
  // the treads that are the actual information.
  clone.querySelectorAll('[data-element="stair"]').forEach(el => {
    el.setAttribute('fill', 'none')
    el.setAttribute('stroke', '#333333')
    if (el.tagName.toLowerCase() === 'line') {
      el.setAttribute('stroke-width', '0.015')
    } else {
      el.setAttribute('stroke-width', '0.025')
    }
    el.removeAttribute('data-element')
  })
  // The direction arrow is a filled head, so it keeps its fill.
  clone.querySelectorAll('[data-element="stair"] path[fill]').forEach(el => {
    el.setAttribute('fill', '#333333')
  })

  // Door symbols — leaf, arc, track, hatch. Tagged separately from the
  // door OPENING (data-element="door", the white gap in the wall) because
  // these are strokes, not a filled gap, and the generic dimension-line rule
  // below would otherwise flatten them all to faint grey.
  clone.querySelectorAll('[data-element="door-symbol"] *').forEach(el => {
    el.setAttribute('stroke', '#333333')
    // These are non-scaling strokes, so their widths are PIXELS (1.5 for a
    // panel, 1 for track and hatch). Left alone they print at screen weight,
    // which is about right; only the colour needs forcing for paper.
    el.setAttribute('data-keep', '1')
  })
  clone.querySelectorAll('[data-element="door-symbol"]').forEach(el => {
    el.removeAttribute('data-element')
  })
  // data-keep is stripped as the dimension rule passes over each line.

  // Door swing arcs — thin grey
  clone.querySelectorAll('path').forEach(path => {
    const d = path.getAttribute('d') || ''
    if (d.includes(' A ')) {
      path.setAttribute('stroke', '#999999')
      path.setAttribute('stroke-width', '0.01')
    }
  })

  // Dimension lines — thin grey, remove outlines
  clone.querySelectorAll('line[vector-effect="non-scaling-stroke"]').forEach(line => {
    // Skip anything already styled above. This rule exists for dimension
    // witness lines; door symbols are drawn with the same vector-effect and
    // were being flattened to the same faint grey, which is why a double
    // door printed as a pair of hairlines.
    if (line.getAttribute('data-keep')) { line.removeAttribute('data-keep'); return }
    const sw = parseFloat(line.getAttribute('stroke-width') || '0')
    if (sw >= 2) { line.remove() }
    else { line.setAttribute('stroke', '#aaaaaa'); line.setAttribute('stroke-width', '0.5') }
  })

  // Extension lines
  clone.querySelectorAll('line:not([vector-effect])').forEach(line => {
    const sw = parseFloat(line.getAttribute('stroke-width') || '0')
    if (sw > 0 && sw < 0.1) line.setAttribute('stroke', '#cccccc')
  })

  // Dimension labels — grey, no outline
  clone.querySelectorAll('text').forEach(text => {
    if (text.getAttribute('paint-order') === 'stroke' || (text.getAttribute('font-family') || '').includes('monospace')) {
      text.setAttribute('fill', '#777777')
      text.setAttribute('fill-opacity', '1')
      text.setAttribute('stroke', 'none')
      text.removeAttribute('paint-order')
    }
  })

  // Cleanup
  clone.querySelectorAll('[style]').forEach(el => {
    if ((el as SVGElement).style.cursor) (el as SVGElement).style.cursor = ''
  })
  clone.querySelectorAll('g[opacity="0.4"]').forEach(g => g.setAttribute('opacity', '0.15'))

  return clone
}
