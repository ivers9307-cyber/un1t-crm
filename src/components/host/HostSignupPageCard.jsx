'use client'

// "Your signup page" card (HOST-GROWTH.A) — surfaces the host's public
// /h/[slug] lead-capture page: full URL + copy, open, QR download, and
// the mailing-list signup count. Pure presentation; the server dashboard
// resolves url/count and handles the degraded (no-slug) case.

import { useState } from 'react'
import HostListPageEditor from '@/components/host/HostListPageEditor'

export default function HostSignupPageCard({ url, signupCount, copyValues }) {
  const [copied, setCopied] = useState(false)
  const [editing, setEditing] = useState(false)
  const [copy, setCopy] = useState(copyValues)

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(url)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // Clipboard unavailable (permissions/http) — the URL is visible to
      // select manually, so no error surface needed.
    }
  }

  const btn = 'rounded-lg border border-white/15 text-white/80 text-xs font-semibold px-3 py-1.5 hover:bg-white/10 hover:text-white'

  return (
    <div className="rounded-xl border border-white/10 bg-white/[0.03] px-4 py-3 flex flex-wrap items-center justify-between gap-3">
      <div className="min-w-0">
        <p className="text-sm font-medium">Your signup page</p>
        <p className="mt-1 text-xs text-white/50 break-all">
          {url}
          {signupCount != null && (
            <span className="text-emerald-300"> · {signupCount} signup{signupCount === 1 ? '' : 's'}</span>
          )}
        </p>
      </div>
      <div className="shrink-0 flex items-center gap-2">
        <button type="button" onClick={copyLink} className={btn}>{copied ? 'Copied' : 'Copy link'}</button>
        <a href={url} target="_blank" rel="noopener noreferrer" className={btn}>Open</a>
        <a href="/api/host/signup-qr" className={btn}>QR code</a>
        <button type="button" onClick={() => setEditing((v) => !v)} className={btn}>Customise</button>
      </div>
      {editing && (
        <div className="w-full">
          <HostListPageEditor
            initial={copy}
            previewUrl={url}
            onClose={() => setEditing(false)}
            onSaved={(v) => { setCopy(v); setEditing(false) }}
          />
        </div>
      )}
    </div>
  )
}
