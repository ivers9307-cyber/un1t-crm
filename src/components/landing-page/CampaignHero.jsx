'use client'

// CampaignHero — FIFTYPLUS.1: the top of a campaign page (/50plus). The coach
// video with the eyebrow, heading and sub-copy over its lower edge, and the
// booking card as `children`: stacked on a phone (video, then card), two
// columns from `lg` (video left, card right; brainstorm direction C1).
//
// HEROVIDEO.1 — two operator choices off the block (campaignFunnelCopy):
//   videoFocus   'top' | 'center' | 'bottom': which edge of the clip the box
//                keeps when it crops (object-position). A talking coach has
//                their face at the top, so 'top' is the default; 'center' was
//                the old behaviour and cut the top of the frame off.
//   soundDefault 'on' | 'muted': whether the clip ASKS to start with sound.
//                Every browser refuses sound before a gesture on the page
//                (iOS always; Chrome unless the site has engagement), and the
//                `autoplay` attribute fails silently, so with 'on' the hero
//                calls play() itself after mount: if the browser refuses, the
//                clip falls back to muted autoplay with the Tap for sound
//                button, exactly the old behaviour. So "sound on" means "with
//                sound wherever the browser allows it, muted otherwise", and
//                the clip should still carry burned-in captions.
// No video: the poster alone; neither: the words on black.
//
// PAGES.1 — `renderText(path, value)` (optional) renders the eyebrow,
// heading and sub-copy instead of the plain words: the editor's preview
// passes EditableText through it (path ['eyebrow'] | ['heading'] |
// ['subhead']). Without it the hero renders exactly as before.
//
// The video box is the one dark island on a light page: `bg-black` sits on
// the element whose text is white, which is the rule no-low-contrast-accent-
// text asks for.
import { useEffect, useRef, useState } from 'react'

// Literal class names so Tailwind sees them.
const FOCUS_CLASS = Object.freeze({ top: 'object-top', center: 'object-center', bottom: 'object-bottom' })

export function heroFocusClass(videoFocus) {
  return FOCUS_CLASS[videoFocus] || FOCUS_CLASS.top
}

export default function CampaignHero({
  videoUrl, posterUrl, soundLabel = 'Tap for sound', videoFocus = 'top', soundDefault = 'on',
  eyebrow, heading, subhead, children, renderText = null,
}) {
  const text = (key, value) => (renderText ? renderText([key], value) : value)
  const videoRef = useRef(null)
  const wantSound = soundDefault === 'on'
  const [muted, setMuted] = useState(!wantSound)
  const focusClass = heroFocusClass(videoFocus)

  // Sound on: ask to play with sound; a refusal (the autoplay policy) falls
  // back to muted autoplay, never to a frozen poster.
  useEffect(() => {
    const v = videoRef.current
    if (!v || !videoUrl || !wantSound) return
    let cancelled = false
    const fallBack = () => {
      if (cancelled) return
      v.muted = true
      setMuted(true)
      try { const q = v.play(); if (q && q.catch) q.catch(() => {}) } catch { /* no autoplay at all: the poster stays */ }
    }
    v.muted = false
    try {
      const p = v.play()
      if (p && p.catch) p.catch(fallBack)
    } catch { fallBack() }
    return () => { cancelled = true }
  }, [videoUrl, wantSound])

  function toggleSound() {
    const v = videoRef.current
    if (!v) return
    const nextMuted = !muted
    v.muted = nextMuted
    if (!nextMuted) { try { const p = v.play(); if (p && p.catch) p.catch(() => {}) } catch { /* autoplay policy */ } }
    setMuted(nextMuted)
  }

  return (
    <section className="bg-white text-black pt-20 lg:pt-28 pb-10 lg:pb-16">
      <div className="max-w-6xl mx-auto px-4 sm:px-6 grid gap-5 lg:gap-8 lg:grid-cols-[1.6fr_1fr] lg:items-stretch">
        <div className="relative overflow-hidden rounded-3xl bg-black text-white aspect-[4/5] sm:aspect-[16/10] lg:aspect-auto lg:min-h-[560px]">
          {videoUrl ? (
            <video
              ref={videoRef}
              className={`absolute inset-0 w-full h-full object-cover ${focusClass}`}
              src={videoUrl}
              poster={posterUrl || undefined}
              autoPlay
              muted={muted}
              loop
              playsInline
              preload="metadata"
              data-sound-default={soundDefault}
            />
          ) : posterUrl ? (

            <img src={posterUrl} alt="" className={`absolute inset-0 w-full h-full object-cover ${focusClass}`} />
          ) : null}
          <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-black/20 to-transparent pointer-events-none" aria-hidden="true" />
          {videoUrl && (
            <button
              type="button"
              onClick={toggleSound}
              aria-pressed={!muted}
              className="absolute top-4 right-4 z-10 rounded-full bg-black/65 backdrop-blur px-4 py-2.5 text-sm font-semibold text-white border border-white/25"
            >
              {muted ? `🔊 ${soundLabel}` : '🔇 Sound on'}
            </button>
          )}
          <div className="absolute inset-x-0 bottom-0 p-6 sm:p-8">
            {eyebrow && <div className="text-[11px] uppercase tracking-[0.3em] font-semibold text-white/75 mb-3">{text('eyebrow', eyebrow)}</div>}
            <h1 className="font-display font-extrabold uppercase text-[clamp(2rem,6vw,3.5rem)] leading-[1.02] tracking-tight">{text('heading', heading)}</h1>
            {subhead && <p className="mt-4 text-base sm:text-lg text-white/85 max-w-xl leading-relaxed">{text('subhead', subhead)}</p>}
          </div>
        </div>
        <div className="flex items-center justify-center lg:justify-stretch">
          {children}
        </div>
      </div>
    </section>
  )
}
