'use client'

// WAATTACH.1 — send a photo or PDF from the WhatsApp inbox thread.
//
// Opened from the composer's "+" menu, which only shows while the 24-hour
// window is open (a file is a session message; outside the window only a
// template can go). The panel still says when the window closes, and the
// server refuses a send after it has.
//
// On Send: a photo over the 5 MB limit is shrunk in the browser first
// (compressImageForUpload); the file is judged by the same rules the server
// applies (src/lib/wa-outbound-attachment.js); the server mints a slot in the
// private bucket under this thread's studio (…/attachments/sign); the bytes
// go straight to Storage (Vercel caps a request body at ~4.5 MB); then the
// send route checks what Storage holds and sends it with a link it mints.
// Errors show in the panel, never in a browser alert.

import { useRef, useState } from 'react'
import { FileText, Image as ImageIcon, Paperclip, X } from 'lucide-react'
import { createBrowserClient } from '@/lib/supabase'
import { compressImageForUpload } from '@/lib/landing-media-upload'
import { WHATSAPP_MEDIA_BUCKET } from '@shared/whatsapp-media'
import { WA_ATTACHMENT_ACCEPT, WA_ATTACHMENT_RULES, judgeWaAttachment } from '@/lib/wa-outbound-attachment'

const CAPTION_MAX = 1024

const readJson = async (res) => {
  try { return await res.json() } catch { return { success: false, error: `Request failed (${res.status}).` } }
}

const sizeLabel = (bytes) => (bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`)

export default function WAAttachmentComposer({ conversationId, windowExpiry, onSent, onClose, storageClient }) {
  const inputRef = useRef(null)
  const [file, setFile] = useState(null)
  const [caption, setCaption] = useState('')
  const [stage, setStage] = useState('idle') // idle | preparing | uploading | sending
  const [error, setError] = useState(null)
  // Sent, but the thread row or the conversation could not be updated.
  const [notice, setNotice] = useState(null)
  const busy = stage !== 'idle'

  function pick(e) {
    const picked = e.target.files?.[0] || null
    e.target.value = ''
    setError(null)
    setNotice(null)
    if (!picked) return
    const type = String(picked.type || '').toLowerCase()
    const judged = judgeWaAttachment({ mime: type, size: picked.size })
    // A photo over the limit is shrunk on Send, so it is not refused here.
    const shrinkable = WA_ATTACHMENT_RULES[type]?.kind === 'image' && picked.size > 0
    if (!judged.ok && !shrinkable) {
      setFile(null)
      setError(judged.error)
      return
    }
    setFile(picked)
  }

  async function send() {
    if (!file || busy) return
    setError(null)
    setNotice(null)
    try {
      setStage('preparing')
      let toSend = file
      const rule = WA_ATTACHMENT_RULES[String(file.type || '').toLowerCase()]
      if (rule?.kind === 'image' && file.size > rule.maxBytes) {
        toSend = (await compressImageForUpload(file)) || file
      }
      const judged = judgeWaAttachment({ mime: toSend.type, size: toSend.size })
      if (!judged.ok) { setError(judged.error); return }

      const signRes = await fetch(`/api/whatsapp/conversations/${conversationId}/attachments/sign`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ file_name: file.name || 'file', mime: judged.contentType, size: toSend.size }),
      })
      const sign = await readJson(signRes)
      if (!sign.success) { setError(sign.error || 'Could not start the upload. Try again.'); return }

      setStage('uploading')
      const storage = (storageClient || createBrowserClient()).storage
      const { error: upErr } = await storage
        .from(WHATSAPP_MEDIA_BUCKET)
        .uploadToSignedUrl(sign.data.path, sign.data.token, toSend, { contentType: sign.data.content_type })
      if (upErr) { setError(`Upload failed: ${upErr.message}`); return }

      setStage('sending')
      const sendRes = await fetch(`/api/whatsapp/conversations/${conversationId}/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: sign.data.kind,
          attachment_path: sign.data.path,
          file_name: file.name || undefined,
          caption: caption.trim() || undefined,
        }),
      })
      const sent = await readJson(sendRes)
      if (!sent.success) { setError(sent.error || 'The file was not sent. Try again.'); return }
      setFile(null)
      setCaption('')
      if (sent.warnings?.length) setNotice(sent.warnings.join(' '))
      onSent?.(sent.warnings || [])
    } catch {
      setError('The file was not sent. Check your connection and try again.')
    } finally {
      setStage('idle')
    }
  }

  const isPdf = file?.type === 'application/pdf'
  const label = { preparing: 'Preparing…', uploading: 'Uploading…', sending: 'Sending…' }[stage] || 'Send'

  return (
    <div className="mt-2 rounded-md border border-un1t-border bg-un1t-bg p-3" data-wa-attachment>
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs font-medium text-un1t-text flex items-center gap-1.5">
          <Paperclip size={13} /> Send a photo or PDF
        </p>
        <button
          type="button"
          onClick={onClose}
          disabled={busy}
          className="text-un1t-subtle hover:text-un1t-text disabled:opacity-50"
          aria-label="Close"
        >
          <X size={14} />
        </button>
      </div>
      <p className="mt-1 text-[11px] text-un1t-subtle">
        Photos (JPEG or PNG) up to 5 MB, PDFs up to 16 MB.
        {windowExpiry ? ` Window open until ${windowExpiry}.` : ''}
      </p>

      <input
        ref={inputRef}
        type="file"
        accept={WA_ATTACHMENT_ACCEPT}
        onChange={pick}
        className="sr-only"
        aria-label="Choose a photo or PDF"
        data-testid="wa-attachment-input"
      />
      {file ? (
        <div className="mt-2 flex items-center gap-2 text-sm text-un1t-text">
          {isPdf ? <FileText size={15} /> : <ImageIcon size={15} />}
          <span className="truncate">{file.name}</span>
          <span className="text-xs text-un1t-subtle shrink-0">{sizeLabel(file.size)}</span>
          <button
            type="button"
            onClick={() => inputRef.current?.click()}
            disabled={busy}
            className="ml-auto text-xs underline text-un1t-muted hover:text-un1t-text disabled:opacity-50 shrink-0"
          >
            Change
          </button>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          className="mt-2 text-xs px-3 py-1.5 rounded-md border border-un1t-border text-un1t-text hover:bg-un1t-border/40"
        >
          Choose file
        </button>
      )}

      <textarea
        value={caption}
        onChange={(e) => setCaption(e.target.value.slice(0, CAPTION_MAX))}
        placeholder="Add a caption (optional)"
        aria-label="Caption"
        rows={2}
        disabled={busy}
        className="mt-2 w-full bg-un1t-surface border border-un1t-border rounded-md px-3 py-2 text-sm text-un1t-text placeholder:text-un1t-muted focus:outline-none focus:border-un1t-muted"
      />

      {error && <p role="alert" className="mt-1 text-xs text-red-700">{error}</p>}
      {notice && <p role="status" className="mt-1 text-xs text-amber-700">{notice}</p>}

      <div className="mt-2 flex justify-end">
        <button
          type="button"
          onClick={send}
          disabled={!file || busy}
          className="text-xs px-3 py-1.5 rounded-md bg-green-600 text-white hover:bg-green-700 disabled:opacity-50"
        >
          {label}
        </button>
      </div>
    </div>
  )
}
