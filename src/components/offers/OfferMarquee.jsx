'use client'

// OfferMarquee — the scrolling strip above the /offers hero (OFFERSPOLISH.1).
//
// The strip repeats the page's own headline, so its words stay hidden from
// screen readers. It moves for ever beside other content, so it needs a
// control that stops it (WCAG 2.2.2): a pause button, which the keyboard
// reaches. Someone who asked their device for reduced motion gets a still
// strip and no button (offers.css), because there is nothing to pause.
import { useState } from 'react'

export default function OfferMarquee({ text }) {
  const [paused, setPaused] = useState(false)
  return (
    <div className="ofr-strip" data-paused={paused ? 'true' : 'false'}>
      <span aria-hidden="true">{text}</span>
      <button
        type="button"
        className="ofr-strip-toggle"
        aria-label={paused ? 'Play the scrolling banner' : 'Pause the scrolling banner'}
        onClick={() => setPaused((p) => !p)}
      >
        <span aria-hidden="true">{paused ? '▶' : '❚❚'}</span>
      </button>
    </div>
  )
}
