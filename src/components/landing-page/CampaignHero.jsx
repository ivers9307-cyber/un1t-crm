'use client'

// CampaignHero — FIFTYPLUS.1: the top of a campaign page (/50plus). The coach
// video with the eyebrow, heading and sub-copy over its lower edge, and the
// booking card as `children`: stacked on a phone (video, then card), two
// columns from `lg` (video left, card right; brainstorm direction C1).
//
// The video autoplays MUTED (every browser refuses sound before a gesture on
// the page; iOS always) and loops, with the poster as its still. One large
// button unmutes in a tap; the clip should carry burned-in captions so the
// message lands before the tap. No video: the poster alone; neither: the
// words on black.
//
// The video box is the one dark island on a light page: `bg-black` sits on
// the element whose text is white, which is the rule no-low-contrast-accent-
// text asks for.
import { useRef, useState } from 'react'

export default function CampaignHero({ videoUrl, posterUrl, soundLabel = 'Tap for sound', eyebrow, heading, subhead, children }) {
  const videoRef = useRef(null)
  const [muted, setMuted] = useState(true)

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
              className="absolute inset-0 w-full h-full object-cover"
              src={videoUrl}
              poster={posterUrl || undefined}
              autoPlay
              muted
              loop
              playsInline
              preload="metadata"
            />
          ) : posterUrl ? (

            <img src={posterUrl} alt="" className="absolute inset-0 w-full h-full object-cover" />
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
            {eyebrow && <div className="text-[11px] uppercase tracking-[0.3em] font-semibold text-white/75 mb-3">{eyebrow}</div>}
            <h1 className="font-display font-extrabold uppercase text-[clamp(2rem,6vw,3.5rem)] leading-[1.02] tracking-tight">{heading}</h1>
            {subhead && <p className="mt-4 text-base sm:text-lg text-white/85 max-w-xl leading-relaxed">{subhead}</p>}
          </div>
        </div>
        <div className="flex items-center justify-center lg:justify-stretch">
          {children}
        </div>
      </div>
    </section>
  )
}
