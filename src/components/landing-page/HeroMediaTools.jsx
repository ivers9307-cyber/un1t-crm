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

import { useRef } from 'react'

export default function HeroMediaTools({
  imageUrl, videoUrl, locationId,
  onChangeImage, onChangeVideo,
}) {
  const imgInput = useRef(null)
  const vidInput = useRef(null)
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
      {videoUrl && (
        <ToolButton
          label="✕"
          title="Remove video"
          onClick={() => onChangeVideo?.(null)}
        />
      )}
      <input
        ref={imgInput}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        className="hidden"
        onChange={(e) => uploadAndApply(e, 'image', locationId, onChangeImage)}
      />
      <input
        ref={vidInput}
        type="file"
        accept="video/mp4,video/webm"
        className="hidden"
        onChange={(e) => uploadAndApply(e, 'video', locationId, onChangeVideo)}
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

async function uploadAndApply(e, kind, locationId, onChange) {
  const file = e.target.files?.[0]
  e.target.value = ''
  if (!file || !locationId) return
  try {
    const fd = new FormData()
    fd.append('file', file)
    fd.append('location_id', locationId)
    fd.append('kind', kind)
    const r = await fetch('/api/landing-page-settings/media', { method: 'POST', body: fd })
    const j = await r.json()
    if (r.ok && j.success !== false && j.url) onChange?.(j.url)
  } catch {
    // Swallow — operator can retry. The form's upload UI surfaces
    // detailed errors; in the iframe we keep the toolbar quiet.
  }
}
