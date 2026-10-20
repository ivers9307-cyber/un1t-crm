'use client'

// CONTRACTS-PDF.2 — the download control for a SIGNED contract with no
// stored PDF (signed before CONTRACTS-PDF.1, or the sign-time render
// degraded to a warning). Shows GET /api/contracts/[id]/pdf's own 409
// message in place of the Download PDF link and, for a master or an
// organisation admin of the contract's org, a Generate PDF button that
// POSTs the same path. On success the page refreshes, so the server
// component re-reads signed_pdf_path and swaps this control for the link.

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { CONTRACT_PDF_MISSING_MESSAGE } from '@/lib/contract-gates'

export default function ContractPdfGenerateButton({ contractId, canGenerate = false }) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [done, setDone] = useState(false)

  async function handleGenerate() {
    setBusy(true)
    setError(null)
    try {
      const res = await fetch(`/api/contracts/${contractId}/pdf`, { method: 'POST' })
      const json = await res.json().catch(() => ({}))
      if (!res.ok || !json.success) throw new Error(json.error || `HTTP ${res.status}`)
      setDone(true)
      router.refresh()
    } catch (e) {
      setError(e.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-col gap-1">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs text-amber-700">{CONTRACT_PDF_MISSING_MESSAGE}</span>
        {canGenerate && !done && (
          <button
            type="button"
            onClick={handleGenerate}
            disabled={busy}
            className="text-xs px-3 py-1.5 rounded-md border border-un1t-border text-un1t-subtle hover:text-un1t-text disabled:opacity-50"
          >{busy ? 'Generating…' : 'Generate PDF'}</button>
        )}
      </div>
      {done && <p className="text-xs text-emerald-700">PDF generated. The download link is ready.</p>}
      {error && <p className="text-xs text-red-700">{error}</p>}
    </div>
  )
}
