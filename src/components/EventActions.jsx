'use client'

import { useState } from 'react'
import { ExternalLink, Copy, Check } from 'lucide-react'

export default function EventActions({ slug, eventId: _eventId }) {
  const [copied, setCopied] = useState(false)

  const bookingUrl = `${window?.location?.origin || ''}/book/${slug}`
  const embedCode = `<iframe src="${bookingUrl}" style="width:100%;min-height:700px;border:none;" title="Book Now"></iframe>`

  function copyEmbed() {
    navigator.clipboard.writeText(embedCode)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <div className="flex items-center gap-2">
      <a
        href={`/book/${slug}`}
        target="_blank"
        rel="noopener noreferrer"
        className="text-xs px-3 py-1.5 rounded border border-un1t-gray text-un1t-light hover:text-un1t-white hover:border-un1t-white/30 transition-colors flex items-center gap-1.5"
      >
        <ExternalLink size={12} />
        Preview
      </a>
      <button
        onClick={copyEmbed}
        className="text-xs px-3 py-1.5 rounded border border-un1t-gray text-un1t-light hover:text-un1t-white hover:border-un1t-white/30 transition-colors flex items-center gap-1.5"
      >
        {copied ? <Check size={12} /> : <Copy size={12} />}
        {copied ? 'Copied!' : 'Embed'}
      </button>
    </div>
  )
}
