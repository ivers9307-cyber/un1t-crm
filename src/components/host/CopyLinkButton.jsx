'use client'

// Copy-link button: writes the url to the clipboard and reads "Copied" for two
// seconds. Plain data in (a url string).

import { useEffect, useRef, useState } from 'react'

const BTN = 'rounded-lg border border-white/15 text-white/80 text-xs font-semibold px-3 py-1.5 hover:bg-white/10 hover:text-white'

export default function CopyLinkButton({ url }) {
  const [copied, setCopied] = useState(false)
  const timer = useRef(null)
  useEffect(() => () => clearTimeout(timer.current), [])
  async function copyLink() {
    try {
      await navigator.clipboard.writeText(url)
      setCopied(true)
      clearTimeout(timer.current)
      timer.current = setTimeout(() => setCopied(false), 2000)
    } catch {
      // Clipboard unavailable (permissions/http) — the URL is visible to
      // select manually, so no error surface needed.
    }
  }
  return <button type="button" onClick={copyLink} className={BTN}>{copied ? 'Copied' : 'Copy link'}</button>
}
