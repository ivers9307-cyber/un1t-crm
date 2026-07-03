'use client'

// PIPELINE5.5b — operator-facing CSV importer for historical invoices.
//
// Glofox has no REST endpoint that returns a member's invoices or
// balance (verified against the API spec v2.3.0), and the studio-wide
// /Analytics/report is TRANSACTIONS (payments), not the invoice ledger —
// feeding it into glofox_invoices mixed two status vocabularies and
// corrupted the data, so that backfill path was removed (mig 244 cleaned
// up its artifacts). Going forward invoices flow in via the
// INVOICE_UPDATED webhook; this CSV path seeds a location's history from
// the Glofox UI "invoices" export when needed (e.g. onboarding a studio
// that predates the webhook).

import { useState } from 'react'
import { Loader2, CheckCircle2, AlertTriangle, Upload, FileText } from 'lucide-react'

export default function GlofoxInvoiceBackfillTab() {
  const [csvFile, setCsvFile] = useState(null)
  const [csvBusy, setCsvBusy] = useState(false)
  const [csvResult, setCsvResult] = useState(null)
  const [csvError, setCsvError] = useState(null)

  async function runCsv(e) {
    e.preventDefault()
    if (!csvFile) {
      setCsvError('Pick a CSV file first')
      return
    }
    setCsvBusy(true)
    setCsvError(null)
    setCsvResult(null)
    try {
      const fd = new FormData()
      fd.append('file', csvFile)
      const r = await fetch('/api/admin/glofox-invoice-csv-import', {
        method: 'POST',
        body: fd,
      })
      const j = await r.json()
      if (!r.ok || j.ok === false) {
        setCsvError(j.error || `HTTP ${r.status}`)
        setCsvResult(j)
      } else {
        setCsvResult(j)
      }
    } catch (e) {
      setCsvError(e?.message || 'Network error')
    } finally {
      setCsvBusy(false)
    }
  }

  return (
    <div className="space-y-4">
      <div className="bg-un1t-surface border border-un1t-border rounded-lg p-4 space-y-3">
        <div className="flex items-start gap-3">
          <div className="w-10 h-10 rounded-lg bg-blue-500/15 border border-blue-500/40 flex items-center justify-center shrink-0">
            <FileText size={18} className="text-blue-400" />
          </div>
          <div className="flex-1">
            <h3 className="font-semibold text-un1t-text">Import historical invoices (CSV)</h3>
            <p className="text-xs text-un1t-subtle mt-1 max-w-3xl">
              Glofox has no API to pull a member&apos;s invoices, so seed a location&apos;s
              history by exporting <strong>invoices</strong> from the Glofox UI as CSV and
              uploading here. Ongoing invoices arrive automatically via the
              <code> INVOICE_UPDATED</code> webhook — this is only for backfilling a studio
              that predates the webhook (e.g. onboarding).
            </p>
            <p className="text-[11px] text-amber-700 mt-2">
              Idempotent: invoices upsert by id, so re-uploading the same CSV is safe.
              Match priority: Glofox Member ID first, then email. Tolerant column matching
              (Member Email / email, Total / Amount, Date / Invoice Date, DD/MM/YYYY dates).
            </p>
          </div>
        </div>

        <form onSubmit={runCsv} className="flex items-end gap-3">
          <div className="flex-1">
            <label className="block text-xs text-un1t-subtle mb-1">CSV file</label>
            <input
              type="file"
              accept=".csv,text/csv"
              onChange={(e) => setCsvFile(e.target.files?.[0] || null)}
              className="w-full text-sm text-un1t-subtle file:mr-3 file:py-2 file:px-3 file:rounded-md file:border-0 file:bg-un1t-border/40 file:text-un1t-text file:cursor-pointer hover:file:bg-un1t-border/60"
            />
          </div>
          <button
            type="submit"
            disabled={csvBusy || !csvFile}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-md bg-blue-500/20 text-blue-700 border border-blue-500/40 hover:bg-blue-500/30 disabled:opacity-50 text-sm font-medium"
          >
            {csvBusy ? <Loader2 size={14} className="animate-spin" /> : <Upload size={14} />}
            {csvBusy ? 'Importing…' : 'Import CSV'}
          </button>
        </form>
      </div>

      {csvError && (
        <div className="bg-red-500/10 border border-red-500/30 rounded-lg p-3 text-sm text-red-700 flex items-start gap-2">
          <AlertTriangle size={14} className="mt-0.5 shrink-0" />
          <div>
            <div className="font-medium">{csvError}</div>
            {csvResult?.headers && (
              <div className="text-[11px] mt-1 text-un1t-muted">
                Headers seen: <code className="text-[10px]">{csvResult.headers.join(', ')}</code>
              </div>
            )}
          </div>
        </div>
      )}

      {csvResult && csvResult.ok && (
        <div className="bg-emerald-500/10 border border-emerald-500/30 rounded-lg p-4 space-y-2 text-sm">
          <div className="flex items-center gap-2 text-emerald-300 font-medium">
            <CheckCircle2 size={16} /> CSV import complete
          </div>
          <div className="grid grid-cols-4 gap-3 text-center pt-2">
            <div>
              <div className="text-2xl font-semibold tabular-nums text-un1t-text">{csvResult.fetched}</div>
              <div className="text-[11px] text-un1t-subtle uppercase tracking-wider">Rows in CSV</div>
            </div>
            <div>
              <div className="text-2xl font-semibold tabular-nums text-emerald-400">{csvResult.upserted}</div>
              <div className="text-[11px] text-un1t-subtle uppercase tracking-wider">Upserted</div>
            </div>
            <div>
              <div className="text-2xl font-semibold tabular-nums text-blue-400">{csvResult.contacts_updated}</div>
              <div className="text-[11px] text-un1t-subtle uppercase tracking-wider">Contacts updated</div>
            </div>
            <div>
              <div className="text-2xl font-semibold tabular-nums text-amber-400">{csvResult.skipped}</div>
              <div className="text-[11px] text-un1t-subtle uppercase tracking-wider">Skipped</div>
            </div>
          </div>
          {csvResult.detected_columns && (
            <details className="text-[11px] text-un1t-subtle pt-2 border-t border-un1t-border/50">
              <summary className="cursor-pointer">Column mapping (sanity check)</summary>
              <table className="mt-2 w-full text-[11px]">
                <tbody>
                  {Object.entries(csvResult.detected_columns).map(([canonical, header]) => (
                    <tr key={canonical} className="border-b border-un1t-border/30 last:border-b-0">
                      <td className="py-1 text-un1t-muted font-mono">{canonical}</td>
                      <td className="py-1 text-right">{header || <span className="text-amber-700">— not found</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </details>
          )}
          {csvResult.failed_sample && csvResult.failed_sample.length > 0 && (
            <details className="text-[11px] text-un1t-subtle pt-2 border-t border-un1t-border/50">
              <summary className="cursor-pointer">Failed sample ({csvResult.failed_sample.length})</summary>
              <pre className="mt-2 bg-un1t-bg border border-un1t-border rounded p-2 overflow-auto max-h-40 text-[10px]">
                {JSON.stringify(csvResult.failed_sample, null, 2)}
              </pre>
            </details>
          )}
        </div>
      )}
    </div>
  )
}
