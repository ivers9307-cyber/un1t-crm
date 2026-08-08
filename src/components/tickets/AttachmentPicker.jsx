'use client'

// EMAIL-OUTBOUND-ATTACH.1 — attaching files to a reply or a new email.
//
// ONE PICKER, TWO COMPOSERS. The reply box and the New email modal mount the
// same component and differ only in what they authorise against (`scope`), so
// the size rules, the wording and the failure states cannot drift between "I
// replied with a photo" and "I emailed them a photo".
//
// ══ THE BYTES NEVER GO THROUGH THE CRM ══════════════════════════════
// Vercel rejects a request body over ~4.5 MB before any route handler runs, so
// a 6 MB attachment posted to /reply would 413 with nothing to say for itself.
// Each file therefore uploads DIRECTLY to the private email-attachments bucket:
//
//   1. POST /api/email/attachments/upload-sign — the server authorises the
//      upload (the same gate the send will apply) and mints a one-shot token
//      for a path IT chose. The browser never proposes a path.
//   2. supabase.storage.uploadToSignedUrl(path, token, file) — no CRM in the
//      middle, so file size is bounded by Postmark's ceiling and nothing else.
//   3. The send request carries { draft_id, index, filename, mime } per file.
//
// ══ WHY EACH FILE UPLOADS THE MOMENT IT IS CHOSEN ═══════════════════
// Not on submit. An operator who picks a 6 MB PDF, writes a reply and then
// discovers the upload is slow has already lost the thing that matters — the
// waiting happens while they type instead of after they click Send. It also
// means "Send" can be honestly disabled while anything is still moving, rather
// than appearing to work and then hanging.
//
// ══ REMOVE ACTUALLY REMOVES ═════════════════════════════════════════
// The × discards the object as well as the chip (POST …/discard, which can only
// ever address the caller's own drafts). A picker that only forgot the file
// would leave paid-for bytes in a bucket every time someone attached the wrong
// thing — the ordinary case, not the exotic one.

import { useCallback, useId, useRef, useState } from 'react'
import { Paperclip, X, Loader2, AlertCircle } from 'lucide-react'
import { createBrowserClient } from '@/lib/supabase'
import { EMAIL_ATTACHMENT_BUCKET, formatBytes } from '@/lib/email-attachment-quota'
import {
  MAX_OUTBOUND_ATTACHMENTS,
  MAX_OUTBOUND_ATTACHMENT_TOTAL_BYTES,
  draftBudget,
  outboundFileTooLargeError,
} from '@/lib/email-outbound-attachments'

/**
 * The references the send route wants, for the files that are actually ready.
 *
 * A file still uploading, or one that failed, contributes NOTHING — the send is
 * blocked while anything is in flight (see `uploading`), so this can never
 * quietly send a subset of what is on screen.
 */
export function readyDrafts(files) {
  return (files || [])
    .filter(f => f.status === 'ready')
    .map(f => ({ draft_id: f.draftId, index: f.index, filename: f.filename, mime: f.mime }))
}

/** Is anything still moving? The composers disable Send on this. */
export function hasPendingUploads(files) {
  return (files || []).some(f => f.status === 'uploading')
}

/**
 * @param {object} props
 * @param {{ticket_id?: string, mailbox_id?: string}} props.scope what the upload
 *   is authorised against — an existing ticket, or the mailbox a new email will
 *   be sent from. Passed straight to the sign route, which applies the SEND's
 *   own gate to it.
 * @param {Array} props.files    the picker's list, owned by the composer so it
 *   survives re-renders and can be cleared after a successful send.
 * @param {Function} props.onChange a React state setter — it is always called
 *   with an updater function, because uploads finish out of order and a stale
 *   snapshot would drop whichever chip resolved second.
 * @param {boolean} props.disabled
 */
export default function AttachmentPicker({ scope, files = [], onChange, disabled = false }) {
  const inputId = useId()
  const inputRef = useRef(null)
  // One composer session = one draft uuid. Slots are handed out monotonically
  // and never reused, so removing file 1 and adding another gives the new one
  // slot 2 — two chips can never address one object.
  const draftIdRef = useRef(null)
  const nextIndexRef = useRef(0)
  const [error, setError] = useState(null)

  if (draftIdRef.current === null) {
    draftIdRef.current = typeof crypto !== 'undefined' && crypto.randomUUID
      ? crypto.randomUUID()
      : `${Date.now()}`
  }

  const budget = draftBudget(files)

  const update = useCallback((key, patch) => {
    onChange(prev => prev.map(f => (f.key === key ? { ...f, ...patch } : f)))
  }, [onChange])

  async function uploadOne(entry, file) {
    try {
      const signRes = await fetch('/api/email/attachments/upload-sign', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...scope,
          draft_id: entry.draftId,
          index: entry.index,
          filename: entry.filename,
          mime: entry.mime,
          size: entry.size,
        }),
      })
      const sign = await signRes.json()
      if (!signRes.ok || !sign?.success || !sign?.data?.token) {
        update(entry.key, { status: 'failed', error: sign?.error || 'Could not start that upload.' })
        return
      }

      const supabase = createBrowserClient()
      const { error: upErr } = await supabase.storage
        .from(EMAIL_ATTACHMENT_BUCKET)
        .uploadToSignedUrl(sign.data.path, sign.data.token, file, { contentType: entry.mime })
      if (upErr) {
        update(entry.key, { status: 'failed', error: `Upload failed: ${upErr.message}` })
        return
      }
      update(entry.key, { status: 'ready', error: null })
    } catch {
      update(entry.key, { status: 'failed', error: 'Upload failed — check your connection.' })
    }
  }

  function handlePick(e) {
    const picked = [...(e.target.files || [])]
    // Clearing the input is what lets the same file be chosen twice in a row
    // after a removal; without it the change event never fires again.
    e.target.value = ''
    if (picked.length === 0) return
    setError(null)

    let running = budget.used
    let count = files.length
    const added = []

    for (const file of picked) {
      if (count >= MAX_OUTBOUND_ATTACHMENTS) {
        setError(`You can attach up to ${MAX_OUTBOUND_ATTACHMENTS} files to one email.`)
        break
      }
      // Client-side because it is kinder, NOT because it is the gate: the send
      // route re-measures the real downloaded bytes and refuses there too.
      if (running + file.size > MAX_OUTBOUND_ATTACHMENT_TOTAL_BYTES) {
        setError(outboundFileTooLargeError(file.name, file.size))
        break
      }
      const index = nextIndexRef.current
      if (index >= MAX_OUTBOUND_ATTACHMENTS) {
        setError('Too many files have been attached and removed on this email — send it and start another.')
        break
      }
      nextIndexRef.current = index + 1
      running += file.size
      count += 1
      added.push({
        key: `${draftIdRef.current}:${index}`,
        draftId: draftIdRef.current,
        index,
        filename: file.name,
        mime: file.type || 'application/octet-stream',
        size: file.size,
        status: 'uploading',
        error: null,
        file,
      })
    }

    if (added.length === 0) return
    onChange(prev => [...prev, ...added.map(({ file, ...rest }) => rest)])
    for (const entry of added) uploadOne(entry, entry.file)
  }

  async function remove(entry) {
    onChange(prev => prev.filter(f => f.key !== entry.key))
    setError(null)
    // Fire and forget: the chip is already gone, and a failed cleanup is a
    // storage cost rather than something the operator can act on. Logged
    // server-side.
    //
    // Removing a file that is STILL UPLOADING can race — the discard may land
    // before the upload does, leaving the object with no chip pointing at it.
    // Accepted rather than serialised: the residue is one unmetered object
    // under `outbound/` (quota is charged only when a message row is filed),
    // and making Remove wait for an upload the operator has already abandoned
    // would be the worse trade.
    if (entry.status !== 'failed') {
      fetch('/api/email/attachments/discard', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          draft_id: entry.draftId,
          index: entry.index,
          filename: entry.filename,
          mime: entry.mime,
        }),
      }).catch(() => {})
    }
  }

  const full = files.length >= MAX_OUTBOUND_ATTACHMENTS

  return (
    <div className="mt-2">
      <div className="flex flex-wrap items-center gap-2">
        <input
          ref={inputRef}
          id={inputId}
          type="file"
          multiple
          className="sr-only"
          disabled={disabled || full}
          onChange={handlePick}
        />
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          disabled={disabled || full}
          className="inline-flex items-center gap-1.5 rounded-full border border-un1t-border px-2.5 py-1 text-xs text-un1t-subtle transition-colors hover:text-un1t-text disabled:opacity-50"
        >
          <Paperclip size={12} aria-hidden="true" />
          Attach files
        </button>
        {files.length > 0 && (
          <span className={`text-[11px] ${budget.over ? 'text-red-700' : 'text-un1t-muted'}`}>
            {formatBytes(budget.used)} of {formatBytes(budget.limit)}
          </span>
        )}
      </div>

      {files.length > 0 && (
        <ul className="mt-2 flex flex-wrap gap-1.5">
          {files.map(f => (
            <li
              key={f.key}
              className={`flex max-w-[15rem] items-center gap-1 rounded-lg border pl-2 pr-1 text-[11px] ${
                f.status === 'failed'
                  ? 'border-red-500/60 bg-red-500/10 text-red-700'
                  : 'border-un1t-border bg-un1t-surface text-un1t-text'
              }`}
            >
              {f.status === 'uploading'
                ? <Loader2 size={11} className="shrink-0 animate-spin" aria-hidden="true" />
                : <Paperclip size={11} className="shrink-0" aria-hidden="true" />}
              <span className="truncate py-1" title={f.error || f.filename}>{f.filename}</span>
              <span className="shrink-0 text-un1t-muted">
                {f.status === 'uploading' ? 'Uploading…' : formatBytes(f.size)}
              </span>
              <button
                type="button"
                onClick={() => remove(f)}
                disabled={disabled}
                aria-label={`Remove ${f.filename}`}
                className="shrink-0 rounded p-1 hover:bg-un1t-bg disabled:opacity-50"
              >
                <X size={11} aria-hidden="true" />
              </button>
            </li>
          ))}
        </ul>
      )}

      {files.some(f => f.status === 'failed') && (
        <p className="mt-1 text-[11px] text-red-700" role="alert">
          A file did not upload. Remove it and try again — it will not be sent.
        </p>
      )}

      {error && (
        <p className="mt-1 flex items-start gap-1.5 text-[11px] text-red-700" role="alert">
          <AlertCircle size={11} className="mt-0.5 shrink-0" aria-hidden="true" />
          {error}
        </p>
      )}
    </div>
  )
}
