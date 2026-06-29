'use client'

// WA-MEDIA.1 — render inbound WhatsApp media inline in the web inbox.
//
// Fetches a short-lived signed URL from /api/whatsapp/media/[id] (which
// re-hosts the bytes from Meta on first view) and renders the right
// element for the kind. Image/video/audio play inline; documents show a
// download link. Falls back to a small "unavailable" note if Meta has
// expired the media or the fetch fails — never a broken-image icon.

import { useEffect, useState } from 'react'
import { mediaRenderKind } from '@shared/whatsapp-media'

export default function WAMediaContent({ message }) {
  const kind = mediaRenderKind(message.message_type, message.media_mime_type)
  const [status, setStatus] = useState('loading') // loading | ready | error
  const [url, setUrl] = useState(null)

  useEffect(() => {
    let cancelled = false
    setStatus('loading')
    setUrl(null)
    fetch(`/api/whatsapp/media/${message.id}`)
      .then(r => (r.ok ? r.json() : null))
      .then(data => {
        if (cancelled) return
        if (data?.success && data.url) {
          setUrl(data.url)
          setStatus('ready')
        } else {
          setStatus('error')
        }
      })
      .catch(() => { if (!cancelled) setStatus('error') })
    return () => { cancelled = true }
  }, [message.id])

  if (!kind) return null

  if (status === 'loading') {
    return <div className="text-xs italic text-un1t-text/50 py-3 px-1">Loading {kind}…</div>
  }
  if (status === 'error' || !url) {
    return <div className="text-xs italic text-un1t-text/50 py-1">[{kind} unavailable]</div>
  }

  if (kind === 'image') {
    return (
      <a href={url} target="_blank" rel="noopener noreferrer" className="block">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={url}
          alt="Shared image"
          className="rounded-md max-h-72 w-auto object-contain cursor-zoom-in"
        />
      </a>
    )
  }
  if (kind === 'video') {
    return <video src={url} controls className="rounded-md max-h-72 w-auto" />
  }
  if (kind === 'audio') {
    return <audio src={url} controls className="w-full max-w-[260px]" />
  }
  // file
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex items-center gap-1.5 text-sm underline text-un1t-text/90"
    >
      📎 Download document
    </a>
  )
}
