// CONTRACTS-PDF.2 — the sign route and the backfill POST render and store the
// signed PDF through ONE helper. A route that called renderContractPdf or
// the `contracts` bucket on its own could print a different countersignature,
// brand or path from the other, and the archived copies would drift.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8')

describe('signed-contract PDF writers', () => {
  const ROUTES = [
    'src/app/api/contracts/[id]/sign/route.js',
    'src/app/api/contracts/[id]/pdf/route.js',
  ]
  it.each(ROUTES)('%s renders and stores through renderAndStoreSignedContractPdf only', (p) => {
    const src = read(p)
    expect(src).toMatch(/renderAndStoreSignedContractPdf/)
    expect(src).not.toMatch(/renderContractPdf\b/)
    expect(src).not.toMatch(/contractCountersignatureLabel|contractPdfCountersignatureLabel/)
    expect(src).not.toMatch(/\.upload\(/)
    expect(src).not.toMatch(/signed_pdf_path:\s*pdfPath/)
  })

  it('the helper is the only src/ module that reads the PDF label rule', () => {
    const src = read('src/lib/contract-pdf-store.js')
    expect(src).toMatch(/contractPdfCountersignatureLabel\(contract\)/)
    expect(src).toMatch(/\.from\('contracts'\)\s*\n?\s*\.upload\(/)
  })
})
