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
import { useRouter } from 'next/navigation'
import {
  FileText, Upload, X, Check, AlertCircle, Send, Loader2, Eye,
  Download, ChevronDown, ChevronRight, Mail, MousePointerClick,
  Globe, RefreshCw,
} from 'lucide-react'

export default function BcaSubmitCard({ car }) {
  const router = useRouter()
  const [state, setState] = useState({ loading: true, config: null, staged: {}, submissions: [], error: null })
  const [uploadingSlot, setUploadingSlot] = useState(null)
  const [removingSlot, setRemovingSlot] = useState(null)
  const [submitting, setSubmitting] = useState(false)
  const [submitResult, setSubmitResult] = useState(null)  // {messageId, attachmentName, sizeBytes} | null
  const [historyOpen, setHistoryOpen] = useState(false)

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

  async function submit() {
    if (!confirm(
      `Submit this ${totalSlots}-document pack to BCA?\n\n` +
      `Email will go to ${config.send_to}` +
      (config.cc ? ` (cc ${config.cc})` : '') +
      ` from ${config.send_from}.\n\n` +
      `Once sent, this becomes the active submission for this car.`
    )) return
    setSubmitting(true)
    setSubmitResult(null)
    setState(s => ({ ...s, error: null }))
    try {
      const r = await fetch(`/api/cars/${car.id}/bca/submit`, { method: 'POST' })
      const j = await r.json()
      if (!r.ok || j.success === false) {
        setState(s => ({ ...s, error: j.error || `Submit failed (${r.status})` }))
        return
      }
      setSubmitResult({
        messageId: j.data.postmark_message_id,
        attachmentName: j.data.attachment_name,
        sizeBytes: j.data.attachment_size_bytes,
      })
      setHistoryOpen(true)
      await refresh()
      // Bump the server-rendered view so completionGaps re-evaluates
      // with the new active submission and the Mark Completed gate
      // unblocks without requiring a manual reload.
      router.refresh()
    } catch (e) {
      setState(s => ({ ...s, error: e.message || 'Network error' }))
    } finally {
      setSubmitting(false)
    }
  }

  if (state.loading) {
    return (
      <div className="bg-un1t-surface border border-un1t-border rounded-2xl p-5 mb-4 flex items-center gap-2 text-xs text-un1t-subtle">
        <Loader2 size={14} className="animate-spin" /> Loading BCA pack…
      </div>
    )
  }

  // Feature flag off at this location — render nothing. (The car
  // detail parent already gates on this, but defence in depth.)
  if (!state.config) return null

  const { config, staged, submissions } = state
  const totalSlots = config.documents.length
  const filledCount = config.documents.filter(d => staged[d.slug]).length
  const allFilled = filledCount === totalSlots
  const activeSubmission = (submissions || []).find(
    s => !s.superseded_at && s.postmark_message_id
  ) || null
  const hasActiveSubmission = !!activeSubmission
  const canSubmit = allFilled && !submitting && !!config.send_from && !!config.send_to

  return (
    <div className="bg-un1t-surface border border-un1t-border rounded-2xl p-5 mb-4">
      <div className="flex items-center justify-between mb-3 gap-3">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-un1t-subtle">BCA Submit</h3>
        <BcaStatusPill
          hasActive={hasActiveSubmission}
          filled={filledCount}
          totalSlots={totalSlots}
          ukVatRefunded={car.uk_vat_refund_received}
        />
      </div>

      <p className="text-xs text-un1t-subtle mb-3">
        Upload all {totalSlots} document{totalSlots === 1 ? '' : 's'} required for the UK VAT claim, then submit to BCA.
        Once submitted, the merged PDF is emailed to{' '}
        <span className="text-un1t-text font-mono">{config.send_to || '—'}</span>{' '}
        from <span className="text-un1t-text font-mono">{config.send_from || '—'}</span>
        {config.cc && <>{' '}(cc <span className="text-un1t-text font-mono">{config.cc}</span>)</>}
        .
      </p>

      {activeSubmission && (
        <div className="bg-un1t-border/20 border border-un1t-border/40 rounded-md p-2.5 mb-3">
          <div className="text-[10px] uppercase tracking-wider text-un1t-muted mb-1">
            Activity on the active submission
          </div>
          <BcaMetricStrip row={activeSubmission} />
        </div>
      )}

      {state.error && (
        <div className="bg-red-500/10 border border-red-500/30 text-red-700 text-xs rounded-md p-2 mb-3 flex items-start gap-2">
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

      {submitResult && (
        <div className="bg-green-500/10 border border-green-500/30 text-green-700 text-xs rounded-md p-3 mb-3 flex items-start gap-2">
          <Check size={14} className="mt-0.5 shrink-0" />
          <div>
            <div className="font-semibold">Sent to BCA</div>
            <div className="text-un1t-subtle mt-1">
              {submitResult.attachmentName} · {(submitResult.sizeBytes / 1024).toFixed(0)} KB ·
              Postmark message id <span className="font-mono">{submitResult.messageId}</span>
            </div>
          </div>
        </div>
      )}

      <div className="flex items-center justify-between gap-3 pt-3 border-t border-un1t-border/40">
        <div className="text-xs text-un1t-subtle">
          {filledCount} / {totalSlots} document{totalSlots === 1 ? '' : 's'} staged.
          {!allFilled && (
            <span className="text-amber-400">
              {' '}Submit available when all {totalSlots} {totalSlots === 1 ? 'is' : 'are'} uploaded.
            </span>
          )}
          {allFilled && (!config.send_from || !config.send_to) && (
            <span className="text-amber-400">
              {' '}Configure send-from + send-to in Settings → BCA Submit before submitting.
            </span>
          )}
        </div>
        <button
          type="button"
          onClick={submit}
          disabled={!canSubmit}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-un1t-text text-un1t-bg text-xs font-semibold hover:bg-un1t-accent disabled:bg-un1t-border/40 disabled:text-un1t-muted disabled:cursor-not-allowed"
        >
          {submitting
            ? <><Loader2 size={11} className="animate-spin" /> Submitting…</>
            : <><Send size={11} /> {hasActiveSubmission ? 'Resubmit to BCA' : 'Submit to BCA'}</>
          }
        </button>
      </div>

      <p className="text-[11px] text-un1t-muted mt-3">
        Slot labels + recipient address are configured at{' '}
        <a href={`/settings/locations/${car.location_id}/bca`} className="underline hover:text-un1t-subtle">
          Settings → BCA Submit
        </a>
        .
      </p>

      {submissions && submissions.length > 0 && (
        <BcaSubmissionHistory
          submissions={submissions}
          open={historyOpen}
          onToggle={() => setHistoryOpen(o => !o)}
        />
      )}
    </div>
  )
}

function BcaSubmissionHistory({ submissions, open, onToggle }) {
  return (
    <div className="mt-4 pt-3 border-t border-un1t-border/40">
      <button
        type="button"
        onClick={onToggle}
        className="inline-flex items-center gap-1 text-xs text-un1t-subtle hover:text-un1t-text"
      >
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        Submission history ({submissions.length})
      </button>
      {open && (
        <ul className="mt-2 space-y-2">
          {submissions.map(s => (
            <li key={s.id} className="border border-un1t-border/40 rounded-md p-2.5 text-xs">
              <div className="flex items-center justify-between gap-2 mb-1">
                <span className="text-un1t-text">
                  {new Date(s.submitted_at).toLocaleString()}
                </span>
                <BcaSubmissionStatus row={s} />
              </div>
              <div className="text-un1t-subtle truncate" title={s.email_subject}>
                <span className="text-un1t-muted">Subject:</span> {s.email_subject}
              </div>
              <div className="text-un1t-subtle mt-0.5">
                <span className="text-un1t-muted">To:</span> {s.email_to}
                {' · '}
                <span className="text-un1t-muted">From:</span> {s.email_from}
              </div>
              {s.merged_pdf_size > 0 && (
                <div className="text-un1t-subtle mt-0.5">
                  <span className="text-un1t-muted">Merged PDF:</span>{' '}
                  {(s.merged_pdf_size / 1024).toFixed(0)} KB
                  {' · '}
                  {Array.isArray(s.documents) ? s.documents.length : 0} source doc{(s.documents?.length || 0) === 1 ? '' : 's'}
                </div>
              )}
              <BcaMetricStrip row={s} />
              {s.postmark_error_msg && (
                <div className="text-red-400 mt-1 flex items-start gap-1">
                  <AlertCircle size={11} className="mt-0.5 shrink-0" />
                  <span>Postmark error {s.postmark_error_code}: {s.postmark_error_msg}</span>
                </div>
              )}
              {s.postmark_message_id && (
                <div className="text-[10px] text-un1t-muted mt-1 font-mono truncate">
                  Postmark id: {s.postmark_message_id}
                </div>
              )}
              <div className="flex flex-wrap items-center gap-3 mt-2">
                {s.merged_pdf_signed_url && (
                  <a
                    href={s.merged_pdf_signed_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 text-un1t-subtle hover:text-un1t-text"
                  >
                    <Download size={11} /> Download merged PDF
                  </a>
                )}
                {s.public_download_url && (
                  <a
                    href={s.public_download_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    title={s.download_expires_at
                      ? `Public re-download link for BCA — expires ${new Date(s.download_expires_at).toLocaleDateString()}`
                      : 'Public re-download link for BCA'}
                    className="inline-flex items-center gap-1 text-un1t-subtle hover:text-un1t-text"
                  >
                    <Eye size={11} /> Public link
                    {s.download_expires_at && (
                      <span className="text-[10px] text-un1t-muted">
                        (exp {new Date(s.download_expires_at).toLocaleDateString()})
                      </span>
                    )}
                  </a>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

// Per-row metric strip: email delivery / open / click / bounce / spam
// (from Postmark webhooks) + link page-views and merged-PDF downloads
// (from the /api/public/bca tracking redirects). Nothing renders for
// metric categories with no data — keeps the row tight until BCA
// actually engages.
function BcaMetricStrip({ row }) {
  const chips = []

  if (row.delivered_at) {
    chips.push({
      key: 'delivered',
      Icon: Mail,
      label: `Delivered ${shortDate(row.delivered_at)}`,
      cls: 'text-green-400',
    })
  }
  if (row.open_count > 0) {
    chips.push({
      key: 'opened',
      Icon: Eye,
      label: `Opened ${row.open_count}× · last ${shortDate(row.last_opened_at)}`,
      cls: 'text-blue-400',
    })
  }
  if (row.click_count > 0) {
    chips.push({
      key: 'clicked',
      Icon: MousePointerClick,
      label: `Clicked ${row.click_count}×`,
      cls: 'text-cyan-400',
    })
  }
  if (row.bounced_at) {
    chips.push({
      key: 'bounced',
      Icon: AlertCircle,
      label: `Bounced (${row.bounce_type || 'unknown'})`,
      cls: 'text-red-400',
    })
  }
  if (row.complaint_at) {
    chips.push({
      key: 'complaint',
      Icon: AlertCircle,
      label: 'Spam complaint',
      cls: 'text-red-400',
    })
  }
  if (row.view_count > 0) {
    chips.push({
      key: 'viewed',
      Icon: Globe,
      label: `Page viewed ${row.view_count}× · last ${shortDate(row.last_viewed_at)}`,
      cls: 'text-amber-300',
    })
  }
  if (row.merged_download_count > 0) {
    chips.push({
      key: 'merged_dl',
      Icon: Download,
      label: `Merged PDF downloaded ${row.merged_download_count}×`,
      cls: 'text-amber-300',
    })
  }

  // Nothing yet (most likely: just-sent, BCA hasn't opened) — render
  // a small "waiting on activity" hint so the strip doesn't disappear
  // entirely from the row layout.
  if (chips.length === 0) {
    return (
      <div className="mt-1.5 text-[10px] text-un1t-muted inline-flex items-center gap-1">
        <RefreshCw size={10} /> No activity yet from BCA.
      </div>
    )
  }

  return (
    <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1">
      {chips.map(({ key, Icon, label, cls }) => (
        <span key={key} className={`inline-flex items-center gap-1 text-[10px] ${cls}`}>
          <Icon size={10} /> {label}
        </span>
      ))}
    </div>
  )
}

function shortDate(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

function BcaSubmissionStatus({ row }) {
  if (row.postmark_error_code) {
    return (
      <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[10px] uppercase font-semibold bg-red-500/20 text-red-700">
        <AlertCircle size={9} /> Failed
      </span>
    )
  }
  if (row.superseded_at) {
    return (
      <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[10px] uppercase font-semibold bg-un1t-border/40 text-un1t-subtle">
        Superseded
      </span>
    )
  }
  if (row.postmark_message_id) {
    return (
      <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[10px] uppercase font-semibold bg-green-500/20 text-green-700">
        <Check size={9} /> Active
      </span>
    )
  }
  return (
    <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[10px] uppercase font-semibold bg-amber-500/20 text-amber-700">
      Pending
    </span>
  )
}

function BcaStatusPill({ hasActive, filled, totalSlots, ukVatRefunded }) {
  if (ukVatRefunded) {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] uppercase font-semibold bg-green-500/20 text-green-700">
        <Check size={10} /> Refunded
      </span>
    )
  }
  if (hasActive) {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] uppercase font-semibold bg-amber-500/20 text-amber-700">
        <Send size={10} /> Submitted — awaiting refund
      </span>
    )
  }
  if (filled === totalSlots) {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] uppercase font-semibold bg-blue-500/20 text-blue-700">
        Ready to submit
      </span>
    )
  }
  return (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] uppercase font-semibold bg-red-500/20 text-red-700">
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
            : 'border-un1t-border'
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
          <div className="text-[10px] text-un1t-muted font-mono">{slug.toUpperCase()} · slot {index}</div>
          <div className="text-sm text-un1t-text truncate" title={label}>{label}</div>
        </div>
        {file
          ? <Check size={14} className="text-green-500 shrink-0 mt-0.5" />
          : <span className="text-[10px] uppercase text-amber-400 mt-0.5">Required</span>
        }
      </div>

      {file ? (
        <div className="flex items-center gap-2">
          <FileText size={12} className="text-un1t-subtle shrink-0" />
          <span className="text-xs text-un1t-subtle truncate flex-1" title={file.filename}>
            {file.filename}
          </span>
          <div className="flex items-center gap-1 shrink-0">
            {file.signed_url && (
              <a
                href={file.signed_url}
                target="_blank"
                rel="noopener noreferrer"
                className="text-un1t-subtle hover:text-un1t-text p-0.5"
                title="Preview"
              >
                <Eye size={12} />
              </a>
            )}
            <button
              type="button"
              onClick={pick}
              disabled={uploading || removing}
              className="text-un1t-subtle hover:text-un1t-text p-0.5 disabled:opacity-40"
              title="Replace"
            >
              <Upload size={12} />
            </button>
            <button
              type="button"
              onClick={onRemove}
              disabled={uploading || removing}
              className="text-un1t-subtle hover:text-red-500 p-0.5 disabled:opacity-40"
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
          className="w-full inline-flex items-center justify-center gap-1.5 px-2 py-1.5 rounded-md bg-un1t-border/30 hover:bg-un1t-border/50 text-xs text-un1t-subtle hover:text-un1t-text disabled:opacity-50"
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
