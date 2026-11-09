'use client'

// "Copy a link for" row on an event's Promote tab (HOSTPORTAL.4): one button
// per share source, each copying the event URL tagged with that source, plus
// the QR download. Plain data in (url string, eventId string, onSale boolean).

import { useEffect, useRef, useState } from 'react'
import { SHARE_SOURCES, taggedEventUrl } from '@/lib/event-share-links'

const BTN = 'rounded-lg border border-white/15 text-white/80 text-xs font-semibold px-3 py-1.5 hover:bg-white/10 hover:text-white'

export default function EventShareLinks({ url, eventId, onSale }) {
  const [copied, setCopied] = useState(null)
  const [fallback, setFallback] = useState('') // the tagged link, shown to select by hand when the clipboard refuses
  const timer = useRef(null)
  useEffect(() => () => clearTimeout(timer.current), [])

  async function copy(token) {
    const tagged = taggedEventUrl(url, token)
    try {
      await navigator.clipboard.writeText(tagged)
      setFallback('')
      setCopied(token)
      clearTimeout(timer.current)
      timer.current = setTimeout(() => setCopied(null), 2000)
    } catch {
      // Clipboard unavailable (permissions/http): show the tagged link to
      // select by hand. The plain link above lacks the source tag.
      setFallback(tagged)
    }
  }

  return (
    <div className="mt-4">
      <p className="text-xs font-semibold uppercase tracking-wide text-white/50">Copy a link for</p>
      <div className="mt-2 flex flex-wrap gap-2">
        {SHARE_SOURCES.map(({ token, label }) => (
          <button key={token} type="button" onClick={() => copy(token)} className={BTN}>
            {copied === token ? 'Copied' : label}
          </button>
        ))}
        <a href={`/api/host/events/${eventId}/qr`} target="_blank" rel="noopener noreferrer" className={BTN}>QR code</a>
      </div>
      {fallback && (
        <div className="mt-2">
          <label htmlFor="share-link-fallback" className="text-xs text-white/60">Copy this link:</label>
          <input
            id="share-link-fallback"
            readOnly
            value={fallback}
            onFocus={(e) => e.target.select()}
            className="mt-1 w-full rounded-lg border border-white/15 bg-transparent px-3 py-1.5 text-xs text-white/80"
          />
        </div>
      )}
      <p className="mt-2 text-xs text-white/50">Bookings from each link show up by source on the Insights tab.</p>
      {!onSale && (
        <p className="mt-2 text-xs text-white/60">This event is not on sale yet, so these links will not open for the public.</p>
      )}
    </div>
  )
}
