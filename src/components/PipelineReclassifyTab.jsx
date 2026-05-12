'use client'

// PIPELINE5.7 — operator-facing trigger for the classifier orchestrator.
//
// Two-step flow:
//   1. Preview (dry-run) — calls /api/admin/pipeline-reclassify with
//      dry_run=true. Shows the movement_matrix + sample list so the
//      operator can sanity-check before committing.
//   2. Commit — same endpoint, dry_run=false. Bulk-UPDATEs every
//      out-of-place deal and writes a real audit row to
//      pipeline_classification_runs.
//
// The dry-run is the answer to "I tweaked HOT_MIN_ATTENDED, what
// will move?" — it shows the delta without touching the deals
// table. The same endpoint is what powers tonight's 03:30 cron;
// running the button just shifts the source string from 'cron' to
// 'backfill' / 'manual'.

import { useState } from 'react'
import { Loader2, Sparkles, CheckCircle2, AlertTriangle, Eye, Play } from 'lucide-react'

const STAGE_LABELS = {
  new_lead:          'New Lead',
  active_trial:     'Active Trial',
  hot_conversion:   'Hot Conversion',
  active_member:    'Active Member',
  at_risk_member:   'At Risk Member',
  classpass_active: 'ClassPass (Active)',
  lapsed:           'Lapsed',
  dormant:          'Dormant',
  dormant_classpass: 'ClassPass (Dormant)',
  '':               '(no deal yet)',
}

function fmtSlug(slug) {
  return STAGE_LABELS[slug] || slug || '—'
}

export default function PipelineReclassifyTab() {
  const [busy, setBusy] = useState(false)
  const [mode, setMode] = useState(null) // 'preview' | 'commit' | null
  const [result, setResult] = useState(null)
  const [error, setError] = useState(null)

  async function run({ dryRun }) {
    setBusy(true)
    setMode(dryRun ? 'preview' : 'commit')
    setError(null)
    setResult(null)
    try {
      const r = await fetch('/api/admin/pipeline-reclassify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dry_run: dryRun, source: dryRun ? 'manual' : 'backfill' }),
      })
      const j = await r.json()
      if (!r.ok || j.ok === false) {
        setError(j.error || `HTTP ${r.status}`)
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
      <div className="bg-un1t-darker border border-un1t-gray rounded-lg p-5">
        <div className="flex items-center gap-2 mb-2">
          <Sparkles size={16} className="text-emerald-400" />
          <h3 className="text-base font-semibold">Re-classify all contacts</h3>
        </div>
        <p className="text-sm text-un1t-light mb-4 max-w-3xl">
          Runs the same engagement-aware classifier the nightly cron uses (03:30 Dublin),
          but immediately. Use this after a fresh threshold tweak in
          <code className="px-1 mx-1 text-[11px] bg-un1t-gray/30 rounded">pipeline-classifier.js</code>
          or right after a bulk import so every deal is in the right column without waiting.
        </p>
        <p className="text-xs text-un1t-light mb-5 max-w-3xl">
          <strong>Preview</strong> is a dry-run — it computes every move the classifier
          would make and shows you the from→to matrix without touching the deals table.
          <strong> Commit</strong> writes the moves and stamps an audit row.
          Both record nothing visible to non-master users.
        </p>
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => run({ dryRun: true })}
            disabled={busy}
            className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-md bg-un1t-gray/40 border border-un1t-gray hover:bg-un1t-gray/60 disabled:opacity-50"
          >
            {busy && mode === 'preview' ? <Loader2 size={14} className="animate-spin" /> : <Eye size={14} />}
            Preview moves
          </button>
          <button
            type="button"
            onClick={() => {
              if (!window.confirm('Commit will move every out-of-place deal to its classifier-recommended stage. Continue?')) return
              run({ dryRun: false })
            }}
            disabled={busy}
            className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-md bg-emerald-600 text-white hover:bg-emerald-500 disabled:opacity-50"
          >
            {busy && mode === 'commit' ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />}
            Commit re-classification
          </button>
        </div>
      </div>

      {error && (
        <div className="bg-rose-500/10 border border-rose-500/40 rounded-lg p-4 flex items-start gap-2">
          <AlertTriangle size={16} className="text-rose-400 mt-0.5 shrink-0" />
          <div>
            <div className="text-sm font-medium text-rose-300">Re-classification failed</div>
            <div className="text-xs text-un1t-light mt-1">{error}</div>
          </div>
        </div>
      )}

      {result && <ResultPanel result={result} mode={mode} />}
    </div>
  )
}

function ResultPanel({ result, mode }) {
  const matrix = result.movement_matrix || {}
  const matrixRows = Object.entries(matrix).flatMap(
    ([from, tos]) => Object.entries(tos).map(([to, count]) => ({ from, to, count }))
  )
  matrixRows.sort((a, b) => b.count - a.count)

  return (
    <div className="bg-un1t-darker border border-un1t-gray rounded-lg p-5">
      <div className="flex items-center gap-2 mb-4">
        <CheckCircle2 size={16} className="text-emerald-400" />
        <h3 className="text-base font-semibold">
          {mode === 'preview' ? 'Preview' : 'Committed'}: {result.contacts_seen} contacts seen
        </h3>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-5 gap-3 mb-5 text-sm">
        <Stat label="Contacts seen"   value={result.contacts_seen} />
        <Stat label="Deals to move"   value={result.deals_moved}  highlight={result.deals_moved > 0 ? 'amber' : null} />
        <Stat label="Already correct" value={result.deals_unchanged} />
        <Stat label="New deals"       value={result.deals_created} />
        <Stat label="Errors"          value={result.errors} highlight={result.errors > 0 ? 'rose' : null} />
      </div>

      {matrixRows.length === 0 ? (
        <div className="text-sm text-un1t-light italic">
          No moves needed — every deal is already in the right stage.
        </div>
      ) : (
        <>
          <h4 className="text-sm font-medium mb-2">Movement matrix</h4>
          <div className="overflow-x-auto mb-5">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs uppercase tracking-wide text-un1t-light border-b border-un1t-gray">
                  <th className="py-2 pr-4">From</th>
                  <th className="py-2 pr-4">To</th>
                  <th className="py-2 text-right">Count</th>
                </tr>
              </thead>
              <tbody>
                {matrixRows.map((r, i) => (
                  <tr key={i} className="border-b border-un1t-gray/40">
                    <td className="py-1.5 pr-4 text-un1t-light">{fmtSlug(r.from)}</td>
                    <td className="py-1.5 pr-4">{fmtSlug(r.to)}</td>
                    <td className="py-1.5 text-right tabular-nums font-medium">{r.count}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {Array.isArray(result.samples) && result.samples.length > 0 && (
        <>
          <h4 className="text-sm font-medium mb-2">Sample moves ({result.samples.length})</h4>
          <ul className="space-y-1 text-xs text-un1t-light max-h-64 overflow-y-auto">
            {result.samples.map((s, i) => (
              <li key={i}>
                <span className="text-un1t-white">{s.contact_name || s.contact_id}</span>
                <span className="mx-2">{fmtSlug(s.from_slug)} → {fmtSlug(s.to_slug)}</span>
              </li>
            ))}
          </ul>
        </>
      )}

      {result.run_id && (
        <div className="mt-4 text-[11px] text-un1t-light">
          Audit run: <code className="bg-un1t-gray/30 px-1 rounded">{result.run_id}</code>
        </div>
      )}
    </div>
  )
}

function Stat({ label, value, highlight }) {
  const ring =
    highlight === 'amber' ? 'border-amber-500/40 bg-amber-500/10' :
    highlight === 'rose'  ? 'border-rose-500/40 bg-rose-500/10' :
    'border-un1t-gray bg-un1t-gray/10'
  return (
    <div className={`border rounded-md px-3 py-2 ${ring}`}>
      <div className="text-[10px] uppercase tracking-wide text-un1t-light">{label}</div>
      <div className="text-lg font-semibold tabular-nums">{value ?? 0}</div>
    </div>
  )
}
