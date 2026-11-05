'use client'

// Public client island for the `video_testimonials` block. Each tile
// renders ONLY a poster <img> + play button until tapped — no <video>
// element, so the section's first paint downloads zero video bytes
// (the whole point of "load quickly"). Tapping swaps in a native
// <video> with controls + sound. The pure BlockRenderers components
// can't hold the per-tile playing state, so this lives on its own
// (same pattern as WaitlistWidget for the lead-form block).
//
// MOBILEFUNNEL.1 — below `md` the tiles are a sideways swipe (scroll-snap):
// each card about 70% of the screen wide with the next one peeking, instead
// of three full-height videos stacked (~2,000px on a phone). From `md` the
// three-column grid as before.

import { useState } from 'react'
import { Play } from 'lucide-react'

export default function VideoTestimonials({ items = [] }) {
  const clips = (Array.isArray(items) ? items : []).filter((it) => it && it.video_url).slice(0, 3)
  if (clips.length === 0) return null
  return (
    <div data-video-swipe="" className="flex overflow-x-auto snap-x snap-mandatory [scrollbar-width:none] [&::-webkit-scrollbar]:hidden -mx-6 px-6 scroll-px-6 md:mx-auto md:px-0 md:scroll-px-0 md:grid md:grid-cols-3 md:overflow-visible md:snap-none gap-4 md:gap-6 max-w-4xl">
      {clips.map((clip, i) => (
        <VideoTile key={clip.video_url || i} clip={clip} />
      ))}
    </div>
  )
}

function VideoTile({ clip }) {
  const [playing, setPlaying] = useState(false)
  return (
    <figure className="relative shrink-0 w-[70%] snap-start md:w-auto aspect-[9/16] overflow-hidden rounded-2xl bg-white/5 border border-white/10 transition-all duration-300 hover:border-white/30 hover:shadow-[0_20px_60px_-20px_rgba(255,255,255,0.15)]">
      {playing ? (
        <video
          src={clip.video_url}
          poster={clip.poster_url || undefined}
          className="absolute inset-0 w-full h-full object-cover bg-black"
          autoPlay
          controls
          playsInline
        />
      ) : (
        <button
          type="button"
          onClick={() => setPlaying(true)}
          className="absolute inset-0 w-full h-full group"
          aria-label={clip.name ? `Play ${clip.name}'s testimonial` : 'Play testimonial'}
        >
          {clip.poster_url ? (

            <img
              src={clip.poster_url}
              alt=""
              className="absolute inset-0 w-full h-full object-cover"
              loading="lazy"
              draggable={false}
            />
          ) : (
            <span className="absolute inset-0 bg-gradient-to-br from-white/10 to-black/40" aria-hidden="true" />
          )}
          <span className="absolute inset-0 flex items-center justify-center">
            <span className="w-16 h-16 rounded-full bg-black/50 backdrop-blur flex items-center justify-center transition group-hover:bg-black/70 group-hover:scale-105">
              <Play size={28} className="text-white translate-x-0.5" fill="currentColor" />
            </span>
          </span>
          {clip.name && (
            <span className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/80 to-transparent p-3 text-left text-sm font-medium text-white">
              {clip.name}
            </span>
          )}
        </button>
      )}
    </figure>
  )
}
