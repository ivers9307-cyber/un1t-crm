'use client'

// BCA Submit — Phase 1 staging UI on the car detail page.
//
// Renders only when the car's location has features.bca_submit = true
// AND the config is in place. Owner of the gating decision is the
// parent (CarDetail.jsx); this component does its own fetch on mount
// to load slots + staged uploads, and rerenders.
//
// Phase 1 = staging only:
//   - 10 upload slots in a 2-column grid (config-driven labels)
//   - drag-drop + click-to-browse per slot
//   - preview / replace / remove per slot
//   - "Submit to BCA" button disabled with a "coming in Phase 2"
//     tooltip — UX surface is in place so when Phase 2 lands, the
//     wiring is trivial
//
// All upload state is fetched fresh on mount + after each change —
// staging files are the source of truth, not local React state. That
// makes the page reload-safe (operator can come back tomorrow and the
// staged docs are still there).

import { useEffect, useState, useRef } from 'react'
import {
  FileText, Upload, X, Check, AlertCircle, Send, Loader2, Eye,
} from 'lucide-react'

export default function BcaSubmitCard({ car }) {
  const [state, setState] = useState({ loading: true, config: null, staged: {}, submissions: [], error: null })
  const [uploadingSlot, setUploadingSlot] = useState(null)
  const [removingSlot, setRemovingSlot] = useState(null)

  // Initial load + a `refresh()` we re-call after every mutation.
  async function refresh() {
    try {
      const r = await fetch(`/api/cars/${car.id}/bca`, { cache: 'no-store' })
      const j = await r.json()
      if (!r.ok || j.success === false) {
        setState(s => ({ ...s, loading: false, error: j.error || `Load failed (${r.status})` }))
        return
      }
      setState({ loading: false, ...j.data, error: null })
    } catch (e) {
      setState(s => ({ ...s, loading: false, error: e.message || 'Network error' }))
    }
  }
  useEffect(() => { refresh() }, [car.id])  // eslint-disable-line react-hooks/exhaustive-deps

  async function upload(slug, file) {
    setUploadingSlot(slug)
    try {
      const fd = new FormData()
      fd.append('file', file)
      const r = await fetch(`/api/cars/${car.id}/bca/uploads/${slug}`, { method: 'POST', body: fd })
      const j = await r.json()
      if (!r.ok || j.success === false) {
        setState(s => ({ ...s, error: j.error || `Upload failed (${r.status})` }))
        return
      }
      setState(s => ({ ...s, error: null }))
      await refresh()
    } catch (e) {
      setState(s => ({ ...s, error: e.message || 'Network error' }))
    } finally {
      setUploadingSlot(null)
    }
  }

  async function remove(slug) {
    if (!confirm('Remove this document from the BCA pack?')) return
    setRemovingSlot(slug)
    try {
      const r = await fetch(`/api/cars/${car.id}/bca/uploads/${slug}`, { method: 'DELETE' })
      const j = await r.json()
      if (!r.ok || j.success === false) {
        setState(s => ({ ...s, error: j.error || `Remove failed (${r.status})` }))
        return
      }
      setState(s => ({ ...s, error: null }))
      await refresh()
    } finally {
      setRemovingSlot(null)
    }
  }

  if (state.loading) {
    return (
      <div className="bg-un1t-dark border border-un1t-gray rounded-2xl p-5 mb-4 flex items-center gap-2 text-xs text-un1t-light">
        <Loader2 size={14} className="animate-spin" /> Loading BCA pack…
      </div>
    )
  }

  // Feature flag off at this location — render nothing. (The car
  // detail parent already gates on this, but defence in depth.)
  if (!state.config) return null

  const { config, staged } = state
  const totalSlots = config.documents.length
  const filledCount = config.documents.filter(d => staged[d.slug]).length
  const allFilled = filledCount === totalSlots
  const hasActiveSubmission = (state.submissions || []).some(s => !s.superseded_at && !s.postmark_error_code)

  return (
    <div className="bg-un1t-dark border border-un1t-gray rounded-2xl p-5 mb-4">
      <div className="flex items-center justify-between mb-3 gap-3">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-un1t-light">BCA Submit</h3>
        <BcaStatusPill
          hasActive={hasActiveSubmission}
          filled={filledCount}
          totalSlots={totalSlots}
          ukVatRefunded={car.uk_vat_refund_received}
        />
      </div>

      <p className="text-xs text-un1t-light mb-3">
        Upload all {totalSlots} document{totalSlots === 1 ? '' : 's'} required for the UK VAT claim, then submit to BCA.
        Once submitted, the merged PDF is emailed to{' '}
        <span className="text-un1t-white font-mono">{config.send_to || '—'}</span>{' '}
        from <span className="text-un1t-white font-mono">{config.send_from || '—'}</span>
        {config.cc && <>{' '}(cc <span className="text-un1t-white font-mono">{config.cc}</span>)</>}
        .
      </p>

      {state.error && (
        <div className="bg-red-500/10 border border-red-500/30 text-red-400 text-xs rounded-md p-2 mb-3 flex items-start gap-2">
          <AlertCircle size={12} className="mt-0.5 shrink-0" /> {state.error}
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-2 mb-4">
        {config.documents.map((doc, idx) => (
          <BcaSlot
            key={doc.slug}
            index={idx + 1}
            label={doc.label}
            slug={doc.slug}
            file={staged[doc.slug] || null}
            uploading={uploadingSlot === doc.slug}
            removing={removingSlot === doc.slug}
            onUpload={f => upload(doc.slug, f)}
            onRemove={() => remove(doc.slug)}
          />
        ))}
      </div>

      <div className="flex items-center justify-between gap-3 pt-3 border-t border-un1t-gray/40">
        <div className="text-xs text-un1t-light">
          {filledCount} / {totalSlots} document{totalSlots === 1 ? '' : 's'} staged.
          {!allFilled && (
            <span className="text-amber-400">
              {' '}Submit available when all {totalSlots} {totalSlots === 1 ? 'is' : 'are'} uploaded.
            </span>
          )}
        </div>
        <button
          type="button"
          disabled
          title={`Coming in Phase 2 — submit will merge the ${totalSlots} doc${totalSlots === 1 ? '' : 's'} into one PDF and email BCA.`}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-un1t-gray/40 text-un1t-mid text-xs font-semibold cursor-not-allowed"
        >
          <Send size={11} /> Submit to BCA
        </button>
      </div>

      <p className="text-[11px] text-un1t-mid mt-3">
        Slot labels + recipient address are configured at{' '}
        <a href={`/settings/locations/${car.location_id}/bca`} className="underline hover:text-un1t-light">
          Settings → BCA Submit
        </a>
        .
      </p>
    </div>
  )
}

function BcaStatusPill({ hasActive, filled, totalSlots, ukVatRefunded }) {
  if (ukVatRefunded) {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] uppercase font-semibold bg-green-500/20 text-green-400">
        <Check size={10} /> Refunded
      </span>
    )
  }
  if (hasActive) {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] uppercase font-semibold bg-amber-500/20 text-amber-400">
        <Send size={10} /> Submitted — awaiting refund
      </span>
    )
  }
  if (filled === totalSlots) {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] uppercase font-semibold bg-blue-500/20 text-blue-400">
        Ready to submit
      </span>
    )
  }
  return (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] uppercase font-semibold bg-red-500/20 text-red-400">
      <AlertCircle size={10} /> Not submitted
    </span>
  )
}

function BcaSlot({ index, label, slug, file, uploading, removing, onUpload, onRemove }) {
  const inputRef = useRef(null)
  const [dragOver, setDragOver] = useState(false)

  function pick() {
    if (uploading || removing) return
    inputRef.current?.click()
  }
  function onChange(e) {
    const f = e.target.files?.[0]
    if (f) onUpload(f)
    e.target.value = ''
  }
  function onDrop(e) {
    e.preventDefault()
    setDragOver(false)
    if (uploading || removing) return
    const f = e.dataTransfer?.files?.[0]
    if (f) onUpload(f)
  }
  function onDragOver(e) { e.preventDefault(); setDragOver(true) }
  function onDragLeave(e) { e.preventDefault(); setDragOver(false) }

  return (
    <div
      onDrop={onDrop}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      className={`border rounded-md p-2.5 transition-colors ${
        dragOver
          ? 'border-blue-400 bg-blue-500/10'
          : file
            ? 'border-green-500/40 bg-green-500/5'
            : 'border-un1t-gray'
      }`}
    >
      <input
        ref={inputRef}
        type="file"
        className="hidden"
        accept="application/pdf,image/jpeg,image/png,image/webp"
        onChange={onChange}
      />

      <div className="flex items-start justify-between gap-2 mb-1">
        <div className="min-w-0 flex-1">
          <div className="text-[10px] text-un1t-mid font-mono">{slug.toUpperCase()} · slot {index}</div>
          <div className="text-sm text-un1t-white truncate" title={label}>{label}</div>
        </div>
        {file
          ? <Check size={14} className="text-green-500 shrink-0 mt-0.5" />
          : <span className="text-[10px] uppercase text-amber-400 mt-0.5">Required</span>
        }
      </div>

      {file ? (
        <div className="flex items-center gap-2">
          <FileText size={12} className="text-un1t-light shrink-0" />
          <span className="text-xs text-un1t-light truncate flex-1" title={file.filename}>
            {file.filename}
          </span>
          <div className="flex items-center gap-1 shrink-0">
            {file.signed_url && (
              <a
                href={file.signed_url}
                target="_blank"
                rel="noopener noreferrer"
                className="text-un1t-light hover:text-un1t-white p-0.5"
                title="Preview"
              >
                <Eye size={12} />
              </a>
            )}
            <button
              type="button"
              onClick={pick}
              disabled={uploading || removing}
              className="text-un1t-light hover:text-un1t-white p-0.5 disabled:opacity-40"
              title="Replace"
            >
              <Upload size={12} />
            </button>
            <button
              type="button"
              onClick={onRemove}
              disabled={uploading || removing}
              className="text-un1t-light hover:text-red-500 p-0.5 disabled:opacity-40"
              title="Remove"
            >
              {removing ? <Loader2 size={12} className="animate-spin" /> : <X size={12} />}
            </button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          onClick={pick}
          disabled={uploading}
          className="w-full inline-flex items-center justify-center gap-1.5 px-2 py-1.5 rounded-md bg-un1t-gray/30 hover:bg-un1t-gray/50 text-xs text-un1t-light hover:text-un1t-white disabled:opacity-50"
        >
          {uploading
            ? <><Loader2 size={11} className="animate-spin" /> Uploading…</>
            : <><Upload size={11} /> Upload (PDF / JPG / PNG)</>
          }
        </button>
      )}
    </div>
  )
}
