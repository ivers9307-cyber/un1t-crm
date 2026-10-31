'use client'

// HeroMediaTools — small floating toolbar in the top-right of the
// hero in edit mode (Phase 3c.3). Lets the operator swap or remove
// the hero background image and/or video without leaving the
// iframe preview. Uses the same /api/landing-page-settings/media
// upload route the form uses.
//
// Lives in its own 'use client' file (rather than in
// BlockRenderers.jsx) because it needs useRef. Keeping
// BlockRenderers TZ-agnostic — usable from both the server-
// rendered public page AND the client edit overlay — means
// reaching for hooks here would force the whole renderer file
// to be client-only and ship more JS to public visitors.

import { useRef, useState } from 'react'
import { uploadLandingMedia } from '@/lib/landing-media-upload'
import MediaPicker from './MediaPicker'

export default function HeroMediaTools({
  imageUrl, videoUrl, locationId, pageId = null,
  onChangeImage, onChangeVideo,
}) {
  const imgInput = useRef(null)
  const vidInput = useRef(null)
  // Video uploads now transcode in-browser (can take ~1-2 min) — show
  // the compress/upload status so the toolbar doesn't look frozen.
  const [status, setStatus] = useState(null) // null | { phase, percent }
  // MEDIALIB.1 — "Choose existing": which kind the picker is open for.
  const [picking, setPicking] = useState(null) // null | 'image' | 'video'
  const canChoose = Boolean(pageId || locationId)
  return (
    <div
      className="absolute top-4 right-4 z-30 flex items-center gap-2 bg-black/70 backdrop-blur rounded-md p-1 text-xs text-white"
      // Stop click bubbling so clicking a toolbar button doesn't
      // also fire the wrapping block's select-on-click handler.
      onClick={(e) => e.stopPropagation()}
    >
      <ToolButton
        label={imageUrl ? 'Change image' : 'Add image'}
        onClick={() => imgInput.current?.click()}
      />
      {canChoose && (
        <ToolButton
          label="Choose existing"
          title="Pick an image already uploaded for your pages"
          onClick={() => setPicking('image')}
        />
      )}
      {imageUrl && (
        <ToolButton
          label="✕"
          title="Remove image"
          onClick={() => onChangeImage?.(null)}
        />
      )}
      <span className="text-white/30">|</span>
      <ToolButton
        label={videoUrl ? 'Change video' : 'Add video'}
        onClick={() => vidInput.current?.click()}
      />
      {canChoose && (
        <ToolButton
          label="Choose existing"
          title="Pick a video already uploaded for your pages"
          onClick={() => setPicking('video')}
        />
      )}
      {videoUrl && (
        <ToolButton
          label="✕"
          title="Remove video"
          onClick={() => onChangeVideo?.(null)}
        />
      )}
      {status && (
        <span className="px-2 py-1 text-white/80 whitespace-nowrap">
          {status.phase === 'compress'
            ? `Compressing… ${Math.round(status.percent || 0)}%`
            : 'Uploading…'}
        </span>
      )}
      <input
        ref={imgInput}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        className="hidden"
        onChange={(e) => uploadAndApply(e, 'image', { locationId, pageId }, onChangeImage)}
      />
      <input
        ref={vidInput}
        type="file"
        accept="video/*"
        className="hidden"
        onChange={(e) => uploadAndApply(e, 'video', { locationId, pageId }, onChangeVideo, setStatus)}
      />
      {/* The chosen URL goes through the same setter an upload uses. */}
      <MediaPicker
        open={picking !== null}
        kind={picking || 'image'}
        onClose={() => setPicking(null)}
        onPick={(item) => { if (picking === 'video') onChangeVideo?.(item.url); else onChangeImage?.(item.url) }}
      />
    </div>
  )
}

function ToolButton({ label, title, onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className="px-2 py-1 rounded hover:bg-white/15 transition-colors"
    >
      {label}
    </button>
  )
}

async function uploadAndApply(e, kind, { locationId, pageId }, onChange, setStatus) {
  const file = e.target.files?.[0]
  e.target.value = ''
  if (!file || !(pageId || locationId)) return
  const isVideo = kind === 'video'
  if (isVideo) setStatus?.({ phase: 'compress', percent: 0 })
  const res = await uploadLandingMedia({
    file,
    ...(pageId ? { pageId } : { locationId }),
    kind,
    onProgress: isVideo ? (p) => setStatus?.(p) : undefined,
  })
  if (isVideo) setStatus?.(null)
  if (res.success && res.url) onChange?.(res.url)
  // Errors stay quiet here — the form's upload UI surfaces detailed
  // messages; the in-iframe toolbar stays calm and the operator retries.
}
