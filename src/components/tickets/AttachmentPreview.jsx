'use client'

// EMAIL-ATTACH-PREVIEW.1 — the attachment overlay: look at a member's file
// without downloading it first, and download it from the same place.
//
// The model is the one every mail client uses, and the one Richard asked for:
// the thread shows a CHIP per file, clicking a chip opens THIS, and there is
// always a Download button whether or not anything renders. Nothing is
// previewed inline in the thread — a member sending four 2 MB photos must not
// turn the thread into something you have to scroll past.
//
// ══ WHAT THIS FILE MUST NEVER GET WRONG ═════════════════════════════
//
// 1. IT NEVER DECIDES WHAT IS PREVIEWABLE. `preview_kind` arrives from the
//    server (the thread payload, and again on the preview response). The
//    allow-list lives in src/lib/email-attachment-preview.js and is enforced by
//    the …/preview route and by the signer beneath it. This component reads a
//    verdict; it does not form one. In particular an SVG never reaches an
//    <img>, an <object>, an <iframe> or a same-origin tab, because no inline
//    URL is ever minted for one.
//
// 2. THE PDF FRAME IS ONLY EVER CROSS-ORIGIN. A signed URL lives on the
//    Supabase Storage origin, so a framed PDF is walled off from this page's
//    DOM, cookies and Supabase session by the same-origin policy. That is the
//    property that makes framing a stranger's document acceptable — so it is
//    CHECKED at render time (isCrossOriginUrl) rather than assumed, and a URL
//    that ever came back same-origin degrades to the download-only panel.
//
//    No `sandbox` attribute is set on that frame, and that is a considered
//    choice rather than an omission: the browser's built-in PDF viewer is
//    itself script-driven, so a sandbox without `allow-scripts` renders a blank
//    box in Chrome, and `allow-scripts allow-same-origin` on a document that is
//    already cross-origin grants nothing the origin boundary has not already
//    taken away. What a sandbox would genuinely add is `allow-top-navigation`
//    denial — i.e. stopping a link inside the PDF from navigating the CRM tab
//    when an operator clicks it. That residual risk is stated rather than
//    hidden, and it is the same risk the thread's email frame already accepts
//    for links (it grants allow-popups so a clicked link opens at all), and the
//    same risk as opening the file after downloading it.
//
// 3. A FILE THAT WAS NEVER STORED NEVER GETS HERE. The chip for a skipped
//    attachment shows its reason and is not clickable — there are no bytes, and
//    an overlay that spun and then failed would bury the one sentence the
//    operator needs ("mailbox was full — ask them to resend").
//
// ══ EXPIRY ══════════════════════════════════════════════════════════
//
// The signed URL is minted WHEN THE OVERLAY OPENS, not when the thread loads,
// so it is always fresh at the moment it is used — which is most of the answer.
// A thread left open for an hour holds no URLs at all. The remaining case is an
// overlay left open past the TTL: an image is already decoded and unaffected, a
// PDF may fail to page, and both are covered by the same visible "Try again"
// control, which re-mints. At most one file is ever open, so a refresh is one
// request by construction — there is no herd to stampede.

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  Download, FileText, FileSpreadsheet, FileArchive, Presentation,
  Image as ImageIcon, File as FileIcon, AlertCircle, RefreshCw,
} from 'lucide-react'
import { Button, Modal, Loading } from '@/components/ui'
import { formatBytes } from '@/lib/email-attachment-quota'
import {
  attachmentIconKind,
  attachmentPreviewNotice,
  isCrossOriginUrl,
} from '@/lib/email-attachment-preview'

/**
 * The icon for a file's family — a chip's first glance at what it is.
 *
 * Written as a switch rather than a lookup that RETURNS a component, so no
 * component is ever created during render (react-hooks/static-components).
 * Purely cosmetic: attachmentIconKind() may consult the filename when the MIME
 * type says nothing, and neither one is allowed anywhere near what may be
 * previewed.
 */
export function AttachmentIcon({ mimeType, filename, ...props }) {
  switch (attachmentIconKind(mimeType, filename)) {
    case 'image': return <ImageIcon {...props} />
    case 'pdf': return <FileText {...props} />
    case 'doc': return <FileText {...props} />
    case 'sheet': return <FileSpreadsheet {...props} />
    case 'slides': return <Presentation {...props} />
    case 'archive': return <FileArchive {...props} />
    case 'text': return <FileText {...props} />
    default: return <FileIcon {...props} />
  }
}

/**
 * The overlay. Rendered once by the thread, for whichever attachment is open.
 *
 * @param {object} props
 * @param {string} props.ticketId
 * @param {object|null} props.attachment  the row from the thread payload, or
 *   null when nothing is open. Carries `preview_kind` from the server.
 * @param {()=>void} props.onClose
 */
export default function AttachmentPreview({ ticketId, attachment, onClose }) {
  const [state, setState] = useState({ status: 'idle', url: null, error: null })
  const [downloading, setDownloading] = useState(false)
  const [downloadError, setDownloadError] = useState(null)
  // Which attachment the in-flight request belongs to, so a fast click through
  // two files cannot land the first file's URL in the second file's overlay.
  const requestFor = useRef(null)

  const open = !!attachment
  const attachmentId = attachment?.id || null
  const previewKind = attachment?.preview_kind || null

  const loadPreview = useCallback(async () => {
    if (!ticketId || !attachmentId || !previewKind) return
    requestFor.current = attachmentId
    setState({ status: 'loading', url: null, error: null })
    try {
      const res = await fetch(`/api/email/tickets/${ticketId}/attachments/${attachmentId}/preview`)
      const j = await res.json().catch(() => ({}))
      if (requestFor.current !== attachmentId) return // superseded
      if (!res.ok || !j.success || !j.data?.url) {
        // A 404 here means the server declined to preview this type — the
        // download-only panel is the right render, not an error.
        setState({
          status: res.status === 404 ? 'unsupported' : 'error',
          url: null,
          error: j.error || 'That preview could not be loaded.',
        })
        return
      }
      setState({ status: 'ready', url: j.data.url, error: null })
    } catch {
      if (requestFor.current !== attachmentId) return
      setState({ status: 'error', url: null, error: 'That preview could not be loaded.' })
    }
  }, [ticketId, attachmentId, previewKind])

  useEffect(() => {
    setDownloadError(null)
    if (!open) {
      requestFor.current = null
      setState({ status: 'idle', url: null, error: null })
      return
    }
    if (!previewKind) {
      // Nothing to fetch: this type is download-only, and asking the server
      // would only be asking it to say so again.
      setState({ status: 'unsupported', url: null, error: null })
      return
    }
    loadPreview()
  }, [open, previewKind, loadPreview])

  async function download() {
    if (!ticketId || !attachmentId || downloading) return
    setDownloading(true)
    setDownloadError(null)
    try {
      const res = await fetch(`/api/email/tickets/${ticketId}/attachments/${attachmentId}`)
      const j = await res.json().catch(() => ({}))
      if (!res.ok || !j.success || !j.data?.url) {
        setDownloadError(j.error || 'That file could not be downloaded.')
        return
      }
      // noopener/noreferrer: the signed URL points at Supabase Storage, which
      // is a different origin, and the opened tab must not hold a handle back
      // to the CRM. The response carries Content-Disposition: attachment, so
      // the browser saves it under the sanitised filename rather than
      // rendering it.
      window.open(j.data.url, '_blank', 'noopener,noreferrer')
    } catch {
      setDownloadError('That file could not be downloaded.')
    } finally {
      setDownloading(false)
    }
  }

  if (!open) return null

  return (
    <Modal
      open
      onClose={onClose}
      size="xl"
      title={attachment.filename}
      footer={
        <>
          <span className="mr-auto text-[11px] text-un1t-muted">
            {formatBytes(attachment.size_bytes)}
            {attachment.mime_type ? ` · ${attachment.mime_type}` : ''}
          </span>
          <Button variant="secondary" size="sm" onClick={onClose}>Close</Button>
          <Button size="sm" icon={Download} loading={downloading} onClick={download}>
            Download
          </Button>
        </>
      }
    >
      <PreviewBody
        attachment={attachment}
        state={state}
        previewKind={previewKind}
        onRetry={loadPreview}
      />
      {downloadError && (
        <p className="mt-3 flex items-center gap-1.5 text-xs text-red-700" role="alert">
          <AlertCircle size={12} className="shrink-0" aria-hidden="true" />
          {downloadError}
        </p>
      )}
    </Modal>
  )
}

function PreviewBody({ attachment, state, previewKind, onRetry }) {
  const [imageFailed, setImageFailed] = useState(false)
  const url = state.url

  // A new URL is a new chance: an <img> that failed because its URL had expired
  // must not stay failed once a fresh one arrives.
  useEffect(() => { setImageFailed(false) }, [url])

  if (state.status === 'loading' || state.status === 'idle') {
    return <div className="py-16"><Loading label="Opening…" /></div>
  }

  if (state.status === 'error') {
    return (
      <Unavailable
        attachment={attachment}
        message={state.error || 'That preview could not be loaded.'}
        onRetry={onRetry}
        tone="error"
      />
    )
  }

  if (state.status === 'unsupported' || !url) {
    // The honest panel, never a blank box: the icon, one sentence saying why
    // there is no preview and what to do instead, and the Download button
    // already sitting in the footer.
    return <Unavailable attachment={attachment} message={attachmentPreviewNotice(attachment.mime_type, attachment.filename)} />
  }

  if (previewKind === 'image') {
    if (imageFailed) {
      return (
        <Unavailable
          attachment={attachment}
          message="That image could not be displayed. It may have expired while this was open, or the file may be damaged."
          onRetry={onRetry}
          tone="error"
        />
      )
    }
    return (
      <div className="flex justify-center">
        {/* A plain <img>, not next/image: the source is a signed, short-lived,
            cross-origin Storage URL, so the optimiser would need the host
            allow-listed and would proxy a private object it must not cache.
            <img> is also the SAFE container — even if a file's bytes turn out
            to be something other than the type claimed, an <img> is a
            script-disabled context. */}
        <img
          src={url}
          alt={attachment.filename}
          onError={() => setImageFailed(true)}
          className="max-h-[70vh] w-auto max-w-full rounded-lg object-contain"
        />
      </div>
    )
  }

  if (previewKind === 'pdf') {
    // Layer 2 of the PDF story: the origin separation is checked, not assumed.
    // See the header — a same-origin signed URL would mean a stranger's
    // document sharing this page's origin, and the download panel is the
    // correct answer to that rather than a frame.
    const pageOrigin = typeof window === 'undefined' ? '' : window.location.origin
    if (!isCrossOriginUrl(url, pageOrigin)) {
      return (
        <Unavailable
          attachment={attachment}
          message="This PDF can’t be previewed safely here. Download it to open it locally."
        />
      )
    }
    return (
      <div>
        <iframe
          src={url}
          title={attachment.filename}
          referrerPolicy="no-referrer"
          className="h-[70vh] w-full rounded-lg border border-un1t-border bg-white"
        />
        <p className="mt-2 text-[11px] text-un1t-muted">
          If the PDF doesn’t appear, download it instead.{' '}
          <button type="button" onClick={onRetry} className="text-un1t-accent hover:underline">
            Reload preview
          </button>
        </p>
      </div>
    )
  }

  // Unreachable today (preview_kind is 'image' | 'pdf' | null), and a panel
  // rather than nothing if a third kind is ever added without a renderer.
  return <Unavailable attachment={attachment} message={attachmentPreviewNotice(attachment.mime_type, attachment.filename)} />
}

/** The "no preview" panel. Always says what to do next. */
function Unavailable({ attachment, message, onRetry, tone }) {
  return (
    <div className="flex flex-col items-center gap-3 px-6 py-12 text-center">
      {tone === 'error' ? (
        <AlertCircle size={40} className="text-red-700" aria-hidden="true" />
      ) : (
        <AttachmentIcon
          mimeType={attachment?.mime_type}
          filename={attachment?.filename}
          size={40}
          className="text-un1t-muted"
          aria-hidden="true"
        />
      )}
      <p className={`max-w-md text-sm ${tone === 'error' ? 'text-red-700' : 'text-un1t-subtle'}`} role={tone === 'error' ? 'alert' : undefined}>
        {message}
      </p>
      {onRetry && (
        <Button variant="secondary" size="sm" icon={RefreshCw} onClick={onRetry}>
          Try again
        </Button>
      )}
    </div>
  )
}
