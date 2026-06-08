'use client'

// LogoSwapper — iframe-only swap affordance for the site logo
// (Phase 3c.5). Lives in its own 'use client' file because it
// needs useRef + useState; keeping BlockRenderers.jsx framework-
// agnostic means SiteHeader can still be rendered from a server
// component (the public welcome page) without forcing a client
// boundary.
//
// Two visual states:
//   - filled (src present): renders the logo at its width with
//     a hover overlay (Change / Remove).
//   - empty: dashed-border "+ Add logo" button replacing the
//     wordmark text. Uses a sensible default size since the
//     operator hasn't picked widthPx yet.
//
// Upload pipeline: same /api/landing-page-settings/media route as
// every other media swap. On success calls onChange(url); the
// EditModeOverlay then posts an 'edit-chrome' message to the
// parent which updates logoUrl in the form state.

import { useRef, useState } from 'react'
import { uploadLandingMedia } from '@/lib/landing-media-upload'

export default function LogoSwapper({ src, alt, widthPx = 200, locationId, onChange }) {
  const inputRef = useRef(null)
  const [hover, setHover] = useState(false)
  const [uploading, setUploading] = useState(false)

  async function handleFile(file) {
    if (!file || !locationId) return
    setUploading(true)
    const res = await uploadLandingMedia({ file, locationId, kind: 'image' })
    if (res.success && res.url) onChange?.(res.url)
    setUploading(false)
  }

  return (
    <span
      className="relative inline-block"
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onClick={(e) => e.stopPropagation()}
    >
      {src ? (
         
        <img
          src={src}
          alt={alt || 'Site logo'}
          style={{ width: `${widthPx}px`, height: 'auto' }}
          className="object-contain"
        />
      ) : (
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          className="inline-flex items-center gap-1 bg-white/5 border-2 border-dashed border-white/30 hover:border-white/60 rounded-md px-3 py-2 text-xs text-white/70 hover:text-white"
        >
          {uploading ? 'Uploading…' : '+ Add logo'}
        </button>
      )}
      {/* Hover overlay — only visible when a logo is set + the
          mouse is over it. Pointer-events-none when not hovered
          so the underlying logo image's ARIA / right-click menu
          isn't shadowed in normal browsing. */}
      {src && (
        <span
          className={`absolute inset-0 z-30 flex items-center justify-center gap-2 bg-black/60 text-white text-[11px] font-semibold rounded transition-opacity ${
            uploading || hover ? 'opacity-100' : 'opacity-0 pointer-events-none'
          }`}
          onClick={(e) => { e.stopPropagation(); inputRef.current?.click() }}
          role="button"
          aria-label="Replace logo"
        >
          {uploading ? 'Uploading…' : (
            <>
              <span>Change</span>
              <span className="text-white/40">|</span>
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); onChange?.(null) }}
                className="text-red-300 hover:text-red-200"
              >
                Remove
              </button>
            </>
          )}
        </span>
      )}
      <input
        ref={inputRef}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0]
          if (f) handleFile(f)
          e.target.value = ''
        }}
      />
    </span>
  )
}
