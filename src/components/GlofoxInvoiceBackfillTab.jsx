'use client'

// PIPELINE5.5 — operator-facing trigger for the invoice backfill.
//
// One-shot button + result panel. Calls
// POST /api/admin/glofox-invoice-backfill with since_iso. Surfaces
// the row counts so the operator can confirm the backfill landed
// what they expected.
//
// Once this completes, the pipeline classifier can use the
// "paid in last 60d" signal that keeps subscription-style members
// in active_member instead of dropping them to at_risk after
// 30 days of no bookings.

import { useState } from 'react'
import { Loader2, Receipt, CheckCircle2, AlertTriangle, Upload, FileText } from 'lucide-react'

const DEFAULT_SINCE = '2026-01-01T00:00:00Z'

export default function GlofoxInvoiceBackfillTab() {
  const [sinceIso, setSinceIso] = useState(DEFAULT_SINCE)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState(null)
  const [error, setError] = useState(null)

  // CSV import state — separate from the API path above. Used when
  // the Glofox /Analytics/report scope is locked (the actual prod
  // outcome on 2026-05-12; PIPELINE5.5b).
  const [csvFile, setCsvFile] = useState(null)
  const [csvBusy, setCsvBusy] = useState(false)
  const [csvResult, setCsvResult] = useState(null)
  const [csvError, setCsvError] = useState(null)

  async function run() {
    setBusy(true)
    setError(null)
    setResult(null)
    try {
      const r = await fetch('/api/admin/glofox-invoice-backfill', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ since_iso: sinceIso }),
      })
      const j = await r.json()
      if (!r.ok || j.ok === false) {
        setError(j.error || `HTTP ${r.status}`)
        setResult(j) // surface the raw body too — useful when Glofox 403s
      } else {
        setResult(j)
      }
    } catch (e) {
      setError(e?.message || 'Network error')
    } finally {
      setBusy(false)
    }
  }

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
      <div className="bg-un1t-dark border border-un1t-gray rounded-lg p-4 space-y-3">
        <div className="flex items-start gap-3">
          <div className="w-10 h-10 rounded-lg bg-emerald-500/15 border border-emerald-500/40 flex items-center justify-center shrink-0">
            <Receipt size={18} className="text-emerald-400" />
          </div>
          <div>
            <h3 className="font-semibold text-un1t-white">Backfill historical invoices</h3>
            <p className="text-xs text-un1t-light mt-1 max-w-3xl">
              Pulls Glofox payment transactions from the chosen cutoff to now,
              upserts them into <code>glofox_invoices</code>, and recomputes
              every affected contact&apos;s <code>last_payment_at</code> +
              lifetime value. Required for the new pipeline classifier&apos;s
              &ldquo;Active Member&rdquo; rule that keeps subscription-style
              members visible even when they rarely attend classes.
            </p>
            <p className="text-[11px] text-amber-700 mt-2">
              One-shot — runs synchronously, ~30-60 seconds for a 5-month window.
              Idempotent: re-running on the same range is safe (invoices upsert by id).
            </p>
          </div>
        </div>

        <div className="flex items-end gap-3">
          <div className="flex-1">
            <label className="block text-xs text-un1t-light mb-1">Since (ISO timestamp)</label>
            <input
              type="text"
              value={sinceIso}
              onChange={(e) => setSinceIso(e.target.value)}
              className="w-full bg-un1t-black border border-un1t-gray rounded-md px-3 py-2 text-sm font-mono text-un1t-white"
            />
          </div>
          <button
            type="button"
            onClick={run}
            disabled={busy}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-md bg-emerald-500/20 text-emerald-300 border border-emerald-500/40 hover:bg-emerald-500/30 disabled:opacity-50 text-sm font-medium"
          >
            {busy ? <Loader2 size={14} className="animate-spin" /> : <Receipt size={14} />}
            {busy ? 'Backfilling…' : 'Run backfill'}
          </button>
        </div>
      </div>

      {error && (
        <div className="bg-red-500/10 border border-red-500/30 rounded-lg p-3 text-sm text-red-700 flex items-start gap-2">
          <AlertTriangle size={14} className="mt-0.5 shrink-0" />
          <div>
            <div className="font-medium">{error}</div>
            {result?.hint && <div className="text-[12px] mt-1">{result.hint}</div>}
            {result?.glofox_status && (
              <div className="text-[11px] mt-1 text-un1t-mid">
                Glofox responded {result.glofox_status}. Full body:{' '}
                <code className="text-[10px]">{JSON.stringify(result.glofox_body).slice(0, 200)}</code>
              </div>
            )}
          </div>
        </div>
      )}

      {result && result.ok && (
        <div className="bg-emerald-500/10 border border-emerald-500/30 rounded-lg p-4 space-y-2 text-sm">
          <div className="flex items-center gap-2 text-emerald-300 font-medium">
            <CheckCircle2 size={16} /> Backfill complete
          </div>
          <div className="grid grid-cols-4 gap-3 text-center pt-2">
            <div>
              <div className="text-2xl font-semibold tabular-nums text-un1t-white">{result.fetched}</div>
              <div className="text-[11px] text-un1t-light uppercase tracking-wider">Fetched</div>
            </div>
            <div>
              <div className="text-2xl font-semibold tabular-nums text-emerald-400">{result.upserted}</div>
              <div className="text-[11px] text-un1t-light uppercase tracking-wider">Upserted</div>
            </div>
            <div>
              <div className="text-2xl font-semibold tabular-nums text-blue-400">{result.contacts_updated}</div>
              <div className="text-[11px] text-un1t-light uppercase tracking-wider">Contacts updated</div>
            </div>
            <div>
              <div className="text-2xl font-semibold tabular-nums text-amber-400">{result.skipped}</div>
              <div className="text-[11px] text-un1t-light uppercase tracking-wider">Skipped</div>
            </div>
          </div>
          {result.message && (
            <p className="text-[12px] text-un1t-light pt-2 border-t border-un1t-gray/50">{result.message}</p>
          )}
          {result.failed_sample && result.failed_sample.length > 0 && (
            <details className="text-[11px] text-un1t-light pt-2 border-t border-un1t-gray/50">
              <summary className="cursor-pointer">Failed sample ({result.failed_sample.length})</summary>
              <pre className="mt-2 bg-un1t-black border border-un1t-gray rounded p-2 overflow-auto max-h-40 text-[10px]">
                {JSON.stringify(result.failed_sample, null, 2)}
              </pre>
            </details>
          )}
        </div>
      )}

      {/* CSV fallback — when /Analytics/report returns 0 (the actual
          prod outcome). Operator exports invoices from the Glofox UI
          and uploads here. PIPELINE5.5b. */}
      <div className="bg-un1t-dark border border-un1t-gray rounded-lg p-4 space-y-3">
        <div className="flex items-start gap-3">
          <div className="w-10 h-10 rounded-lg bg-blue-500/15 border border-blue-500/40 flex items-center justify-center shrink-0">
            <FileText size={18} className="text-blue-400" />
          </div>
          <div className="flex-1">
            <h3 className="font-semibold text-un1t-white">Upload Glofox CSV (fallback)</h3>
            <p className="text-xs text-un1t-light mt-1 max-w-3xl">
              If the API path above returned 0 (Glofox <code>/Analytics/report</code>{' '}
              scope likely locked), export invoices from the Glofox UI as CSV and upload here.
              Tolerant column matching: handles common header names (Member Email / email,
              Total / Amount, Date / Invoice Date, etc.) and DD/MM/YYYY dates.
            </p>
            <p className="text-[11px] text-amber-700 mt-2">
              Idempotent: invoices upsert by id, so re-uploading the same CSV is safe.
              Match priority: Glofox Member ID first, then email.
            </p>
          </div>
        </div>

        <form onSubmit={runCsv} className="flex items-end gap-3">
          <div className="flex-1">
            <label className="block text-xs text-un1t-light mb-1">CSV file</label>
            <input
              type="file"
              accept=".csv,text/csv"
              onChange={(e) => setCsvFile(e.target.files?.[0] || null)}
              className="w-full text-sm text-un1t-light file:mr-3 file:py-2 file:px-3 file:rounded-md file:border-0 file:bg-un1t-gray/40 file:text-un1t-white file:cursor-pointer hover:file:bg-un1t-gray/60"
            />
          </div>
          <button
            type="submit"
            disabled={csvBusy || !csvFile}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-md bg-blue-500/20 text-blue-300 border border-blue-500/40 hover:bg-blue-500/30 disabled:opacity-50 text-sm font-medium"
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
              <div className="text-[11px] mt-1 text-un1t-mid">
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
              <div className="text-2xl font-semibold tabular-nums text-un1t-white">{csvResult.fetched}</div>
              <div className="text-[11px] text-un1t-light uppercase tracking-wider">Rows in CSV</div>
            </div>
            <div>
              <div className="text-2xl font-semibold tabular-nums text-emerald-400">{csvResult.upserted}</div>
              <div className="text-[11px] text-un1t-light uppercase tracking-wider">Upserted</div>
            </div>
            <div>
              <div className="text-2xl font-semibold tabular-nums text-blue-400">{csvResult.contacts_updated}</div>
              <div className="text-[11px] text-un1t-light uppercase tracking-wider">Contacts updated</div>
            </div>
            <div>
              <div className="text-2xl font-semibold tabular-nums text-amber-400">{csvResult.skipped}</div>
              <div className="text-[11px] text-un1t-light uppercase tracking-wider">Skipped</div>
            </div>
          </div>
          {csvResult.detected_columns && (
            <details className="text-[11px] text-un1t-light pt-2 border-t border-un1t-gray/50">
              <summary className="cursor-pointer">Column mapping (sanity check)</summary>
              <table className="mt-2 w-full text-[11px]">
                <tbody>
                  {Object.entries(csvResult.detected_columns).map(([canonical, header]) => (
                    <tr key={canonical} className="border-b border-un1t-gray/30 last:border-b-0">
                      <td className="py-1 text-un1t-mid font-mono">{canonical}</td>
                      <td className="py-1 text-right">{header || <span className="text-amber-700">— not found</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </details>
          )}
          {csvResult.failed_sample && csvResult.failed_sample.length > 0 && (
            <details className="text-[11px] text-un1t-light pt-2 border-t border-un1t-gray/50">
              <summary className="cursor-pointer">Failed sample ({csvResult.failed_sample.length})</summary>
              <pre className="mt-2 bg-un1t-black border border-un1t-gray rounded p-2 overflow-auto max-h-40 text-[10px]">
                {JSON.stringify(csvResult.failed_sample, null, 2)}
              </pre>
            </details>
          )}
        </div>
      )}
    </div>
  )
}
