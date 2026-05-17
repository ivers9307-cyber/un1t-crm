'use client'

// EditableImage — image (or video) swapper used inside the iframe
// edit overlay (Phase 3c.3). Hover surface shows a "Click to
// change / add" overlay; clicking opens a hidden file input;
// uploading hits /api/landing-page-settings/media (same generic
// endpoint the form uses); on success calls onChange(newUrl) so
// the iframe can post 'edit-field' upstream to the parent state.
//
// Requires `locationId` (passed down from the iframe's edit-mode
// state, originally posted from the settings form). The iframe is
// loaded under the operator's session — cookies travel with the
// fetch, so the upload route validates auth normally without any
// extra plumbing.
//
// Two render modes:
//   - filled (src present): shows the media, hover reveals
//     "Click to change" overlay with a small Remove button.
//   - empty: shows a dashed-border "Click to add" placeholder
//     sized to the same className/style as a real image would be,
//     so block layout doesn't shift when an operator adds the
//     first photo.

import { useRef, useState } from 'react'

export default function EditableImage({
  src,
  alt = '',
  kind = 'image',          // 'image' | 'video'
  locationId,
  onChange,                // (newUrl: string | null) => void
  onError,                 // (msg: string) => void
  className = '',
  style,
  emptyLabel,
  // Some block layouts need to tweak how the media element renders
  // (e.g. background-image vs <img>). When backgroundMode is true
  // we render a <div> with the image as a CSS background instead
  // of an <img>. Used by the hero block's image backdrop.
  backgroundMode = false,
}) {
  const [uploading, setUploading] = useState(false)
  const [hover, setHover] = useState(false)
  const inputRef = useRef(null)

  async function handleFile(file) {
    if (!file || !locationId) return
    setUploading(true)
    try {
      const fd = new FormData()
      fd.append('file', file)
      fd.append('location_id', locationId)
      fd.append('kind', kind)
      const r = await fetch('/api/landing-page-settings/media', { method: 'POST', body: fd })
      const j = await r.json()
      if (!r.ok || j.success === false) {
        onError?.(j.error || `Upload failed (${r.status})`)
        return
      }
      onChange?.(j.url)
    } catch (e) {
      onError?.(e?.message || 'Upload failed')
    } finally {
      setUploading(false)
    }
  }

  const accept = kind === 'video'
    ? 'video/mp4,video/webm'
    : 'image/png,image/jpeg,image/webp'

  function openPicker(e) {
    e?.stopPropagation()
    inputRef.current?.click()
  }

  function handleRemove(e) {
    e?.stopPropagation()
    onChange?.(null)
  }

  return (
    <div
      className={`relative ${src ? '' : 'min-h-[80px]'} ${className}`}
      style={style}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      // Stop the wrapping block's click-to-select from firing —
      // clicking media should act on the media, not select the
      // block.
      onClick={(e) => e.stopPropagation()}
    >
      {/* Filled or empty render */}
      {src ? (
        backgroundMode ? (
          <div
            className="absolute inset-0 bg-cover bg-center"
            style={{ backgroundImage: `url(${src})` }}
            aria-hidden="true"
          />
        ) : kind === 'video' ? (
          <video
            src={src}
            className="w-full h-full object-cover"
            muted
            autoPlay
            loop
            playsInline
          />
        ) : (
           
          <img src={src} alt={alt} className="w-full h-full object-cover" />
        )
      ) : (
        <div
          className="absolute inset-0 bg-white/5 border-2 border-dashed border-white/30 flex items-center justify-center text-white/60 text-sm cursor-pointer"
          onClick={openPicker}
        >
          {uploading ? 'Uploading…' : (emptyLabel || `Add ${kind}`)}
        </div>
      )}

      {/* Edit overlay — visible on hover OR while uploading. Sits
          above the media so a half-transparent panel reveals what
          the operator is hovering over. */}
      {src && (
        <div
          className={`absolute inset-0 z-30 flex flex-col items-center justify-center gap-2 bg-black/60 text-white transition-opacity ${
            uploading || hover ? 'opacity-100' : 'opacity-0 pointer-events-none'
          }`}
          onClick={openPicker}
          role="button"
          aria-label={`Replace ${kind}`}
        >
          {uploading ? (
            <span className="text-sm font-semibold">Uploading…</span>
          ) : (
            <>
              <span className="text-sm font-semibold">Click to change {kind}</span>
              <button
                type="button"
                onClick={handleRemove}
                className="text-xs text-red-300 hover:text-red-200 underline underline-offset-2"
              >
                Remove
              </button>
            </>
          )}
        </div>
      )}

      <input
        ref={inputRef}
        type="file"
        accept={accept}
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0]
          if (f) handleFile(f)
          e.target.value = ''
        }}
      />
    </div>
  )
}
