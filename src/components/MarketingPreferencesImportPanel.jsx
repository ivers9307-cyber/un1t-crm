'use client'

// CONSENT.5 — operator UI for the bulk preferences import.
//
// Two-step flow:
//   1. Upload + Preview — POST CSV to /api/admin/marketing-preferences-import?preview=1.
//      Server parses, builds change plan, returns counts + samples
//      WITHOUT writing.
//   2. Commit — POST same CSV without preview flag. Applies via
//      applyMarketingPreferencesBulk per matched contact, writes
//      consent_log rows.
//
// The CSV file stays in the input between Preview and Commit so
// the operator only picks the file once.

import { useState } from 'react'
import { Loader2, Upload, Eye, Play, AlertTriangle, CheckCircle2, Lock } from 'lucide-react'

const STAT_LABELS = {
  total_rows:        'CSV rows',
  matched_contacts:  'Matched contacts',
  unmatched_email:   'Unmatched emails',
  classpass_skipped: 'ClassPass skipped',
  no_columns:        'No data on row',
  bad_email:         'Invalid email',
}

const PREF_LABELS = {
  email_marketing:    'Email',
  sms_marketing:      'SMS',
  whatsapp_marketing: 'WhatsApp',
}

export default function MarketingPreferencesImportPanel() {
  const [file, setFile] = useState(null)
  const [busy, setBusy] = useState(false)
  const [mode, setMode] = useState(null)  // 'preview' | 'commit'
  const [result, setResult] = useState(null)
  const [error, setError] = useState(null)

  async function run({ preview }) {
    if (!file) {
      setError('Pick a CSV file first.')
      return
    }
    setBusy(true)
    setMode(preview ? 'preview' : 'commit')
    setError(null)
    setResult(null)
    try {
      const fd = new FormData()
      fd.append('file', file)
      const url = `/api/admin/marketing-preferences-import${preview ? '?preview=1' : ''}`
      const r = await fetch(url, { method: 'POST', body: fd })

      // Defensive parse: a Vercel timeout / function crash returns
      // a plain-text error page (e.g. "An error occurred") rather
      // than JSON. Pre-CONSENT.5b that broke r.json() with
      // "Unexpected token 'A'…" giving the operator no useful
      // signal. Read as text first, parse JSON if it looks like it.
      const raw = await r.text()
      let j = null
      try { j = JSON.parse(raw) } catch { /* not JSON */ }

      if (!j) {
        if (r.status === 504 || /timeout/i.test(raw)) {
          setError(`Import timed out (HTTP ${r.status}). The CSV may be too large for a single request — try splitting it in half and uploading each piece, or share the file size and I'll bump the server limit.`)
        } else {
          setError(`Server returned a non-JSON response (HTTP ${r.status}). First 200 chars: ${raw.slice(0, 200)}`)
        }
        return
      }
      if (!r.ok || !j.success) {
        setError(j.error || `HTTP ${r.status}`)
        if (j.headers) setResult({ headers: j.headers })
      } else {
        setResult(j)
      }
    } catch (e) {
      setError(e?.message || 'Network error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-6">
      <div className="bg-un1t-dark border border-un1t-gray rounded-lg p-5">
        <div className="flex items-center gap-2 mb-2">
          <Upload size={16} className="text-emerald-400" />
          <h3 className="text-base font-semibold">Upload preferences CSV</h3>
        </div>
        <p className="text-sm text-un1t-light mb-4 max-w-3xl">
          The file needs an <code>email</code> column plus one or more of:{' '}
          <code>email_marketing</code>, <code>sms_marketing</code>,{' '}
          <code>whatsapp_marketing</code>, or a single <code>unsubscribed</code> column
          that means &ldquo;opt out of everything&rdquo;. Common header variants
          (<code>Subscribed</code>, <code>opted_out</code>, <code>marketing_consent_email</code>,
          Mailchimp&apos;s <code>Unsubscribed</code> timestamp) are auto-detected.
          Boolean values can be <code>true/false</code>, <code>yes/no</code>, <code>1/0</code>,
          or a date (which is read as &ldquo;true, this happened&rdquo;).
        </p>

        <div className="flex items-end gap-3 mb-4">
          <div className="flex-1">
            <label className="block text-xs text-un1t-light mb-1">CSV file</label>
            <input
              type="file"
              accept=".csv,text/csv"
              onChange={(e) => { setFile(e.target.files?.[0] || null); setResult(null); setError(null) }}
              className="w-full text-sm text-un1t-light file:mr-3 file:py-2 file:px-3 file:rounded-md file:border-0 file:bg-un1t-gray/40 file:text-un1t-white file:cursor-pointer hover:file:bg-un1t-gray/60"
            />
          </div>
          <button
            type="button"
            onClick={() => run({ preview: true })}
            disabled={busy || !file}
            className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-md bg-un1t-gray/40 border border-un1t-gray hover:bg-un1t-gray/60 disabled:opacity-50"
          >
            {busy && mode === 'preview' ? <Loader2 size={14} className="animate-spin" /> : <Eye size={14} />}
            Preview
          </button>
          <button
            type="button"
            onClick={() => {
              if (!window.confirm('Commit will write the imported preferences to every matched contact. Continue?')) return
              run({ preview: false })
            }}
            disabled={busy || !file}
            className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-md bg-emerald-600 text-white hover:bg-emerald-500 disabled:opacity-50"
          >
            {busy && mode === 'commit' ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />}
            Commit import
          </button>
        </div>

        <div className="flex items-start gap-2 text-[11px] text-un1t-light">
          <Lock size={11} className="mt-0.5 shrink-0" />
          <div>
            <strong className="text-un1t-white">ClassPass safety:</strong> contacts with{' '}
            <code>glofox_membership_status=&apos;classpass_payg&apos;</code> are excluded from
            the import — the CONSENT.2 blanket rule wins. They&apos;re reported under
            &ldquo;ClassPass skipped&rdquo; below if any are in your CSV.
          </div>
        </div>
      </div>

      {error && (
        <div className="bg-rose-500/10 border border-rose-500/40 rounded-lg p-4 flex items-start gap-2">
          <AlertTriangle size={16} className="text-rose-400 mt-0.5 shrink-0" />
          <div className="flex-1">
            <div className="text-sm font-medium text-rose-300">Import failed</div>
            <div className="text-xs text-un1t-light mt-1">{error}</div>
            {result?.headers && (
              <details className="mt-2 text-[11px]">
                <summary className="cursor-pointer">Headers we found</summary>
                <code className="block mt-1 break-all">{result.headers.join(' · ')}</code>
              </details>
            )}
          </div>
        </div>
      )}

      {result && result.success && <ResultPanel result={result} />}
    </div>
  )
}

function ResultPanel({ result }) {
  const isCommit = result.mode === 'commit'
  return (
    <div className="bg-un1t-dark border border-un1t-gray rounded-lg p-5 space-y-5">
      <div className="flex items-center gap-2">
        <CheckCircle2 size={16} className="text-emerald-400" />
        <h3 className="text-base font-semibold">
          {isCommit ? 'Import committed' : 'Preview'} — {result.contacts_to_change ?? result.contacts_changed ?? 0} contact
          {(result.contacts_to_change ?? result.contacts_changed ?? 0) === 1 ? '' : 's'}
          {isCommit ? ' updated' : ' will change'}
        </h3>
      </div>

      {/* Column mapping the server detected. Operator should sanity-check
          this — if 'subscribed' got mapped to email_marketing but the
          export's semantics were inverse, this is where they'd notice. */}
      <div>
        <h4 className="text-xs font-medium uppercase tracking-wider text-un1t-light mb-2">Column mapping</h4>
        <div className="text-xs space-y-1">
          {Object.keys(result.mapping || {}).length === 0
            ? <div className="text-un1t-mid italic">No columns matched.</div>
            : Object.entries(result.mapping).map(([canonical, sourceCol]) => (
              <div key={canonical} className="flex items-center gap-2">
                <code className="text-un1t-light">{sourceCol}</code>
                <span className="text-un1t-mid">→</span>
                <code className="text-emerald-400">{canonical}</code>
              </div>
            ))}
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 md:grid-cols-3 gap-3 text-sm">
        {Object.entries(STAT_LABELS).map(([key, label]) => (
          <Stat key={key} label={label} value={result.stats?.[key] ?? 0} />
        ))}
        {isCommit && (
          <>
            <Stat label="Contacts changed"   value={result.contacts_changed ?? 0} highlight="emerald" />
            <Stat label="Already aligned"    value={result.contacts_unchanged ?? 0} />
            <Stat label="Errors"             value={result.errors ?? 0} highlight={result.errors > 0 ? 'rose' : null} />
          </>
        )}
      </div>

      {/* Sample matched rows */}
      {Array.isArray(result.samples?.matched) && result.samples.matched.length > 0 && (
        <div>
          <h4 className="text-xs font-medium uppercase tracking-wider text-un1t-light mb-2">
            Sample {isCommit ? 'changes' : 'planned moves'} ({result.samples.matched.length})
          </h4>
          <ul className="text-xs space-y-1 max-h-64 overflow-y-auto">
            {result.samples.matched.map((s, i) => (
              <li key={i} className="flex items-baseline gap-2">
                <span className="text-un1t-white">{s.email}</span>
                <span className="text-un1t-mid">
                  {Object.entries(s.prefs).map(([k, v]) => (
                    <span key={k} className="ml-2">
                      {PREF_LABELS[k]}: <span className={v ? 'text-emerald-400' : 'text-rose-400'}>{v ? 'on' : 'off'}</span>
                    </span>
                  ))}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Unmatched + ClassPass + errors — collapsed by default */}
      {Array.isArray(result.samples?.unmatched) && result.samples.unmatched.length > 0 && (
        <details className="text-xs">
          <summary className="cursor-pointer text-un1t-light">
            Unmatched emails ({result.stats?.unmatched_email ?? 0} total — these emails aren&apos;t in your contacts)
          </summary>
          <ul className="mt-2 max-h-48 overflow-y-auto pl-4">
            {result.samples.unmatched.map((e, i) => (
              <li key={i} className="text-un1t-mid">{e}</li>
            ))}
          </ul>
        </details>
      )}
      {Array.isArray(result.samples?.classpass) && result.samples.classpass.length > 0 && (
        <details className="text-xs">
          <summary className="cursor-pointer text-un1t-light">
            ClassPass skipped ({result.stats?.classpass_skipped ?? 0} total — protected by the deliverability rule)
          </summary>
          <ul className="mt-2 max-h-48 overflow-y-auto pl-4">
            {result.samples.classpass.map((e, i) => (
              <li key={i} className="text-un1t-mid">{e}</li>
            ))}
          </ul>
        </details>
      )}
      {isCommit && Array.isArray(result.error_sample) && result.error_sample.length > 0 && (
        <details className="text-xs" open>
          <summary className="cursor-pointer text-rose-400">Errors ({result.errors})</summary>
          <pre className="mt-2 bg-un1t-black border border-un1t-gray rounded p-2 overflow-auto max-h-48 text-[10px]">
            {JSON.stringify(result.error_sample, null, 2)}
          </pre>
        </details>
      )}
    </div>
  )
}

function Stat({ label, value, highlight }) {
  const ring =
    highlight === 'emerald' ? 'border-emerald-500/40 bg-emerald-500/10' :
    highlight === 'rose'    ? 'border-rose-500/40 bg-rose-500/10' :
    'border-un1t-gray bg-un1t-gray/10'
  return (
    <div className={`border rounded-md px-3 py-2 ${ring}`}>
      <div className="text-[10px] uppercase tracking-wide text-un1t-light">{label}</div>
      <div className="text-lg font-semibold tabular-nums">{value ?? 0}</div>
    </div>
  )
}
