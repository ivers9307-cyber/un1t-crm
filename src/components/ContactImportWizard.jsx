'use client'

// ContactImportWizard — master-only 4-step modal for the contacts
// page's "Import" button.
//
//   1. Upload — drop CSV + optional batch tag + download template
//   2. Map    — auto-mapped headers; operator can override
//   3. Review — server-side dry-run summary + per-row outcomes
//   4. Done   — final stats + error CSV download link
//
// Client-side parsing (parseCsv from src/lib/contact-import.js)
// means we send rows + mapping as JSON to the API, no double file
// upload between preview and commit.

import { useState, useMemo } from 'react'
import { useRouter } from 'next/navigation'
import { Upload, X, Loader2, AlertTriangle, ArrowRight, Download, CheckCircle2, FileText, ArrowLeft } from 'lucide-react'
import { parseCsv, autoMapHeaders, IMPORT_FIELDS, IMPORT_FIELD_KEYS, buildCsvTemplate } from '@/lib/contact-import'

const FIELD_OPTIONS = [
  { value: '', label: '(skip column)' },
  ...IMPORT_FIELDS.map(f => ({ value: f.key, label: f.label })),
]

export default function ContactImportWizard({ onClose }) {
  const router = useRouter()
  const [stage, setStage] = useState('upload')
  const [filename, setFilename] = useState('')
  const [headers, setHeaders] = useState([])
  const [rows, setRows] = useState([])
  const [mapping, setMapping] = useState({})
  const [batchTag, setBatchTag] = useState('')
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)
  const [preview, setPreview] = useState(null)
  const [result, setResult] = useState(null)

  function downloadTemplate() {
    const blob = new Blob([buildCsvTemplate()], { type: 'text/csv;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'un1t-contacts-template.csv'
    a.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }

  async function onFile(file) {
    if (!file) return
    setError(null)
    setFilename(file.name)
    try {
      const text = await file.text()
      const parsed = parseCsv(text)
      if (parsed.headers.length === 0 || parsed.rows.length === 0) {
        setError('CSV is empty or malformed.')
        return
      }
      if (parsed.rows.length > 5000) {
        setError(`Too many rows (${parsed.rows.length}). Max is 5,000 per import — split the file and run two batches.`)
        return
      }
      setHeaders(parsed.headers)
      setRows(parsed.rows)
      setMapping(autoMapHeaders(parsed.headers))
      setStage('map')
    } catch (e) {
      setError(e.message || 'Failed to read file')
    }
  }

  const mappedFieldCount = useMemo(
    () => new Set(Object.values(mapping).filter(v => IMPORT_FIELD_KEYS.includes(v))).size,
    [mapping],
  )
  const hasEmailMapping = useMemo(
    () => Object.values(mapping).some(v => v === 'email'),
    [mapping],
  )

  async function runPreview() {
    setError(null)
    if (!hasEmailMapping) {
      setError('Email column is required — pick which CSV column contains the email.')
      return
    }
    setBusy(true)
    try {
      const r = await fetch('/api/contacts/import/preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mapping, rows, batch_tag: batchTag || undefined }),
      })
      const j = await r.json()
      if (!r.ok || j.success === false) {
        setError(j.error || `Preview failed (${r.status})`)
        return
      }
      setPreview(j.data)
      setStage('review')
    } catch (e) {
      setError(e.message || 'Network error')
    } finally {
      setBusy(false)
    }
  }

  async function runCommit() {
    setError(null)
    setBusy(true)
    try {
      const r = await fetch('/api/contacts/import/commit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mapping,
          rows,
          batch_tag: batchTag || undefined,
          source_filename: filename,
        }),
      })
      const j = await r.json()
      if (!r.ok || j.success === false) {
        setError(j.error || `Import failed (${r.status})`)
        return
      }
      setResult(j.data)
      setStage('done')
    } catch (e) {
      setError(e.message || 'Network error')
    } finally {
      setBusy(false)
    }
  }

  function done() {
    onClose()
    router.refresh()
  }

  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4" onClick={() => !busy && onClose()}>
      <div
        className="bg-un1t-dark border border-un1t-gray rounded-xl max-w-3xl w-full max-h-[90vh] overflow-auto p-6"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-start justify-between mb-4">
          <div>
            <h3 className="text-base font-semibold text-un1t-white">Import contacts</h3>
            <p className="text-xs text-un1t-light mt-0.5">
              {stage === 'upload' && 'Upload a CSV. Email column is required; everything else is optional.'}
              {stage === 'map' && 'Map your CSV columns to contact fields. We pre-fill obvious matches.'}
              {stage === 'review' && 'Dry-run summary. Nothing is written until you click Import.'}
              {stage === 'done' && 'Import complete. Any failed rows can be downloaded as CSV.'}
            </p>
          </div>
          <button type="button" onClick={() => !busy && onClose()} disabled={busy} className="text-un1t-light hover:text-un1t-white">
            <X size={16} />
          </button>
        </header>

        <Steps stage={stage} />

        {error && (
          <div className="bg-red-500/10 border border-red-500/30 text-red-700 text-sm rounded-md p-3 mb-3 flex items-start gap-2">
            <AlertTriangle size={14} className="mt-0.5 shrink-0" /> {error}
          </div>
        )}

        {stage === 'upload' && (
          <UploadStage
            onFile={onFile}
            batchTag={batchTag}
            setBatchTag={setBatchTag}
            downloadTemplate={downloadTemplate}
          />
        )}

        {stage === 'map' && (
          <MapStage
            headers={headers}
            rows={rows}
            mapping={mapping}
            setMapping={setMapping}
            mappedFieldCount={mappedFieldCount}
            onBack={() => setStage('upload')}
            onNext={runPreview}
            busy={busy}
          />
        )}

        {stage === 'review' && (
          <ReviewStage
            preview={preview}
            batchTag={batchTag}
            onBack={() => setStage('map')}
            onCommit={runCommit}
            busy={busy}
          />
        )}

        {stage === 'done' && (
          <DoneStage result={result} onDone={done} />
        )}
      </div>
    </div>
  )
}

function Steps({ stage }) {
  const order = ['upload', 'map', 'review', 'done']
  const idx = order.indexOf(stage)
  const labels = { upload: 'Upload', map: 'Map fields', review: 'Review', done: 'Done' }
  return (
    <div className="flex items-center gap-2 mb-4 text-[11px] uppercase tracking-wider">
      {order.map((s, i) => (
        <span key={s} className={`flex items-center gap-2 ${i <= idx ? 'text-un1t-white' : 'text-un1t-mid'}`}>
          <span className={`w-5 h-5 rounded-full flex items-center justify-center text-[10px] ${i <= idx ? 'bg-un1t-white text-un1t-black' : 'bg-un1t-gray text-un1t-light'}`}>
            {i + 1}
          </span>
          {labels[s]}
          {i < order.length - 1 && <span className="text-un1t-mid">›</span>}
        </span>
      ))}
    </div>
  )
}

function UploadStage({ onFile, batchTag, setBatchTag, downloadTemplate }) {
  return (
    <div className="space-y-4">
      <label
        htmlFor="contact-import-file"
        className="block bg-un1t-black border-2 border-dashed border-un1t-gray hover:border-un1t-mid rounded-lg p-8 text-center cursor-pointer"
      >
        <Upload size={28} className="mx-auto mb-2 text-un1t-light" />
        <div className="text-sm text-un1t-white font-medium">Click to choose a CSV</div>
        <div className="text-[11px] text-un1t-mid mt-1">Up to 5,000 rows per import</div>
        <input
          id="contact-import-file"
          type="file"
          accept=".csv,text/csv"
          className="hidden"
          onChange={(e) => onFile(e.target.files?.[0])}
        />
      </label>

      <div>
        <label className="block text-xs text-un1t-light mb-1">Tag this batch as <span className="text-un1t-mid">(optional, comma-separated)</span></label>
        <input
          type="text"
          value={batchTag}
          onChange={(e) => setBatchTag(e.target.value)}
          placeholder="lead_magnet_jan26, cold_lead"
          className="w-full bg-un1t-black border border-un1t-gray rounded-md px-3 py-2 text-sm text-un1t-white"
        />
        <p className="text-[11px] text-un1t-mid mt-1">
          Stamped on every imported contact. Useful for segmenting + retargeting downstream.
        </p>
      </div>

      <button
        type="button"
        onClick={downloadTemplate}
        className="inline-flex items-center gap-2 text-xs text-un1t-light hover:text-un1t-white"
      >
        <Download size={12} /> Download CSV template
      </button>
    </div>
  )
}

function MapStage({ headers, rows, mapping, setMapping, mappedFieldCount, onBack, onNext, busy }) {
  return (
    <div className="space-y-4">
      <div className="text-xs text-un1t-light">
        {rows.length} row{rows.length === 1 ? '' : 's'} detected · {mappedFieldCount} field{mappedFieldCount === 1 ? '' : 's'} mapped
      </div>
      <div className="bg-un1t-black border border-un1t-gray rounded-md max-h-72 overflow-auto">
        <table className="w-full text-xs">
          <thead className="text-[10px] uppercase tracking-wider text-un1t-light sticky top-0 bg-un1t-black">
            <tr>
              <th className="text-left p-2">CSV column</th>
              <th className="text-left p-2">Sample value</th>
              <th className="text-left p-2">Maps to</th>
            </tr>
          </thead>
          <tbody>
            {headers.map(h => (
              <tr key={h} className="border-t border-un1t-gray/40">
                <td className="p-2 text-un1t-white font-mono">{h}</td>
                <td className="p-2 text-un1t-light truncate max-w-[200px]">{rows[0]?.[h] ?? ''}</td>
                <td className="p-2">
                  <select
                    value={mapping[h] || ''}
                    onChange={(e) => setMapping({ ...mapping, [h]: e.target.value || null })}
                    className="w-full bg-un1t-dark border border-un1t-gray rounded-md px-2 py-1 text-xs text-un1t-white"
                  >
                    {FIELD_OPTIONS.map(o => (
                      <option key={o.value} value={o.value}>{o.label}</option>
                    ))}
                  </select>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="flex gap-2">
        <button
          type="button"
          onClick={onBack}
          disabled={busy}
          className="flex-1 inline-flex items-center justify-center gap-1.5 text-sm border border-un1t-gray text-un1t-light py-2 rounded-md hover:text-un1t-white"
        >
          <ArrowLeft size={14} /> Back
        </button>
        <button
          type="button"
          onClick={onNext}
          disabled={busy}
          className="flex-1 inline-flex items-center justify-center gap-2 bg-un1t-white text-un1t-black text-sm font-medium py-2 rounded-md hover:bg-un1t-accent disabled:opacity-50"
        >
          {busy ? <Loader2 size={14} className="animate-spin" /> : <ArrowRight size={14} />}
          {busy ? 'Validating…' : 'Run dry-run'}
        </button>
      </div>
    </div>
  )
}

function ReviewStage({ preview, batchTag, onBack, onCommit, busy }) {
  if (!preview) return null
  const { summary, rows } = preview
  const errored = rows.filter(r => r.action === 'errored')
  const skipped = rows.filter(r => r.action === 'skipped')

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-4 gap-2">
        <Stat label="Create" value={summary.to_create} tone="emerald" />
        <Stat label="Update" value={summary.to_update} tone="blue" />
        <Stat label="Skip" value={summary.to_skip} tone="amber" />
        <Stat label="Error" value={summary.to_error} tone="red" />
      </div>

      {batchTag && (
        <div className="bg-un1t-black border border-un1t-gray rounded-md p-2 text-[11px] text-un1t-light">
          Every contact will be tagged: <strong className="text-un1t-white">{batchTag}</strong>
        </div>
      )}

      {(errored.length > 0 || skipped.length > 0) && (
        <div className="bg-un1t-black border border-un1t-gray rounded-md p-3 text-xs space-y-2 max-h-48 overflow-auto">
          <div className="text-[10px] uppercase tracking-wider text-un1t-light">Issues</div>
          <ul className="space-y-0.5">
            {[...errored, ...skipped].slice(0, 50).map(r => (
              <li key={r.row_number} className={r.action === 'errored' ? 'text-red-700' : 'text-amber-700'}>
                Row {r.row_number}{r.email ? ` (${r.email})` : ''} — {r.error}
              </li>
            ))}
            {(errored.length + skipped.length) > 50 && (
              <li className="text-un1t-mid">…and {(errored.length + skipped.length) - 50} more</li>
            )}
          </ul>
        </div>
      )}

      <div className="flex gap-2">
        <button
          type="button"
          onClick={onBack}
          disabled={busy}
          className="flex-1 inline-flex items-center justify-center gap-1.5 text-sm border border-un1t-gray text-un1t-light py-2 rounded-md hover:text-un1t-white"
        >
          <ArrowLeft size={14} /> Back
        </button>
        <button
          type="button"
          onClick={onCommit}
          disabled={busy || (summary.to_create === 0 && summary.to_update === 0)}
          className="flex-1 inline-flex items-center justify-center gap-2 bg-emerald-600 text-white text-sm font-medium py-2 rounded-md hover:bg-emerald-500 disabled:opacity-50"
        >
          {busy ? <Loader2 size={14} className="animate-spin" /> : <Upload size={14} />}
          {busy ? 'Importing…' : `Import ${summary.to_create + summary.to_update} contacts`}
        </button>
      </div>
    </div>
  )
}

function DoneStage({ result, onDone }) {
  if (!result) return null
  const hasErrors = (result.summary.errored || 0) > 0 || (result.summary.skipped || 0) > 0
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3 mb-2">
        <CheckCircle2 size={28} className="text-emerald-700" />
        <div>
          <div className="text-base font-semibold text-un1t-white">Import complete</div>
          <div className="text-xs text-un1t-light">{result.summary.total} row{result.summary.total === 1 ? '' : 's'} processed.</div>
        </div>
      </div>

      <div className="grid grid-cols-4 gap-2">
        <Stat label="Created" value={result.summary.created} tone="emerald" />
        <Stat label="Updated" value={result.summary.updated} tone="blue" />
        <Stat label="Skipped" value={result.summary.skipped} tone="amber" />
        <Stat label="Errored" value={result.summary.errored} tone="red" />
      </div>

      <div className="flex gap-2">
        {hasErrors && (
          <a
            href={`/api/contacts/imports/${result.import_id}/error-csv`}
            className="flex-1 inline-flex items-center justify-center gap-2 text-sm border border-un1t-gray text-un1t-light py-2 rounded-md hover:text-un1t-white"
          >
            <Download size={14} /> Download error rows
          </a>
        )}
        <a
          href={`/contacts/imports/${result.import_id}`}
          className="flex-1 inline-flex items-center justify-center gap-2 text-sm border border-un1t-gray text-un1t-light py-2 rounded-md hover:text-un1t-white"
        >
          <FileText size={14} /> View batch
        </a>
        <button
          type="button"
          onClick={onDone}
          className="flex-1 inline-flex items-center justify-center text-sm bg-un1t-white text-un1t-black font-medium py-2 rounded-md hover:bg-un1t-accent"
        >
          Done
        </button>
      </div>
    </div>
  )
}

function Stat({ label, value, tone }) {
  const toneClasses = {
    emerald: 'border-emerald-500/40 text-emerald-700',
    blue:    'border-blue-500/40 text-blue-700',
    amber:   'border-amber-500/40 text-amber-700',
    red:     'border-red-500/40 text-red-700',
  }
  return (
    <div className={`border rounded-md p-3 text-center ${toneClasses[tone] || 'border-un1t-gray'}`}>
      <div className="text-[10px] uppercase tracking-wider opacity-80">{label}</div>
      <div className="text-2xl font-bold tabular-nums mt-0.5">{value}</div>
    </div>
  )
}
