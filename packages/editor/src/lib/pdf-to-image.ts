/**
 * Render a PDF's first page to a PNG data URL so it can be used as a
 * GuideNode source — the same way images are.
 *
 * Why first page only (for now):
 *   Architectural plans frequently ship as multi-page PDFs (title block,
 *   floor 1, floor 2, sections, ...). A page picker is real UI work; v1
 *   takes page 1 and logs a hint when there are more. The user can split
 *   their PDF externally if they want a specific page.
 *
 * Why scale capping:
 *   A 36"x24" architectural sheet rendered at PDF native DPI is ~2592x1728.
 *   At scale=2 (default for "trace quality") that's 5184x3456 — a ~100 MB
 *   canvas, slow to encode, and slow for three.js to decode as a texture.
 *   We cap the LONGEST edge to ~3000 px which keeps trace lines crisp at
 *   typical zoom without melting the browser.
 *
 * Errors we surface (vs ones we let bubble):
 *   - Password-protected PDFs: pdfjs throws PasswordException. We translate
 *     to a friendly message — most users won't know what "PasswordException"
 *     means.
 *   - Corrupt / non-PDF bytes: pdfjs throws InvalidPDFException. Also
 *     translated.
 *   - Anything else (worker init failures, OOM): bubble — surfaces in the
 *     caller's catch with the original message.
 */

const MAX_LONG_EDGE_PX = 3000

let _pdfjsLib: typeof import('pdfjs-dist') | null = null

async function ensurePdfJs(): Promise<typeof import('pdfjs-dist')> {
  if (_pdfjsLib) return _pdfjsLib

  // Dynamic import keeps pdf.js out of the initial editor bundle — it only
  // loads when a user actually tries to upload a PDF.
  const pdfjs = await import('pdfjs-dist')

  // Worker setup. pdfjs-dist v4+ ships an ESM worker (pdf.worker.mjs) that
  // Webpack/Turbopack bundle via new URL(..., import.meta.url). This pattern
  // works in Next.js 16 without copying anything into public/ — the bundler
  // emits a hashed worker chunk and resolves the URL automatically.
  if (typeof window !== 'undefined' && !pdfjs.GlobalWorkerOptions.workerSrc) {
    pdfjs.GlobalWorkerOptions.workerSrc = new URL(
      'pdfjs-dist/build/pdf.worker.min.mjs',
      import.meta.url,
    ).toString()
  }

  _pdfjsLib = pdfjs
  return pdfjs
}

export interface PdfRenderResult {
  /** PNG data URL of the rendered page, ready to set on a GuideNode. */
  dataUrl: string
  /** Page count of the source PDF (1 even for single-page). */
  totalPages: number
  /** Rendered width / height in pixels. */
  width: number
  height: number
}

export async function pdfFileToImageDataUrl(file: File): Promise<PdfRenderResult> {
  let pdfjs: typeof import('pdfjs-dist')
  try {
    pdfjs = await ensurePdfJs()
  } catch (e) {
    throw new Error(`Could not load the PDF renderer: ${(e as Error)?.message ?? e}`)
  }

  const buffer = await file.arrayBuffer()

  let doc: import('pdfjs-dist/types/src/display/api').PDFDocumentProxy
  try {
    // `data` accepts a copy of the ArrayBuffer (pdfjs consumes it).
    doc = await pdfjs.getDocument({ data: new Uint8Array(buffer) }).promise
  } catch (e) {
    const name = (e as { name?: string })?.name
    if (name === 'PasswordException') {
      throw new Error('This PDF is password protected. Unlock it before uploading.')
    }
    if (name === 'InvalidPDFException') {
      throw new Error('This file is not a valid PDF. Try re-exporting from your CAD tool.')
    }
    throw e
  }

  const totalPages = doc.numPages
  const page = await doc.getPage(1)

  // Pick a scale so the longest rendered edge stays under MAX_LONG_EDGE_PX.
  // Start from the 1:1 viewport, scale up to 2 (the "trace quality" target),
  // then scale down if 2x would exceed the cap.
  const baseViewport = page.getViewport({ scale: 1 })
  const longBase = Math.max(baseViewport.width, baseViewport.height)
  const desiredScale = 2
  const capScale = MAX_LONG_EDGE_PX / longBase
  const scale = Math.min(desiredScale, capScale)
  const viewport = page.getViewport({ scale })

  const canvas = document.createElement('canvas')
  canvas.width = Math.ceil(viewport.width)
  canvas.height = Math.ceil(viewport.height)
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Could not create a 2D canvas to render the PDF into.')

  // White background — most PDFs have transparent backgrounds and the
  // editor's dark UI would otherwise bleed through the trace overlay.
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, canvas.width, canvas.height)

  await page.render({ canvasContext: ctx, viewport, canvas }).promise

  // Always release the doc — pdf.js holds an internal worker handle until
  // `.destroy()` runs. The method exists at runtime in v4+ but isn't on the
  // narrowed PDFDocumentProxy type, so call it through a cast. Small leak
  // per upload if we skip this.
  void (doc as unknown as { destroy(): Promise<void> }).destroy?.()

  const dataUrl = canvas.toDataURL('image/png')
  return { dataUrl, totalPages, width: canvas.width, height: canvas.height }
}
