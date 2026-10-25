'use client'

// "Your signup page" card (HOST-GROWTH.A) — surfaces the host's public
// /h/[slug] lead-capture page: full URL + copy, open, QR download, and
// the mailing-list signup count. Since HOST-JOIN-PAGE.1 it also shows the
// standalone signup form at /h/[slug]/join (`joinUrl`; the form alone, for
// socials) with its own copy/open/QR. Pure presentation; the server
// dashboard resolves the urls/count and handles the degraded (no-slug) case.

import { useState } from 'react'
import HostListPageEditor from '@/components/host/HostListPageEditor'

const BTN = 'rounded-lg border border-white/15 text-white/80 text-xs font-semibold px-3 py-1.5 hover:bg-white/10 hover:text-white'

function CopyLinkButton({ url }) {
  const [copied, setCopied] = useState(false)
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
  return <button type="button" onClick={copyLink} className={BTN}>{copied ? 'Copied' : 'Copy link'}</button>
}

export default function HostSignupPageCard({ url, joinUrl, signupCount, copyValues }) {
  const [editing, setEditing] = useState(false)
  const [copy, setCopy] = useState(copyValues)
  const btn = BTN

  return (
    <div className="rounded-xl border border-white/10 bg-white/[0.03] px-4 py-3 flex flex-wrap items-center justify-between gap-3">
      <div className="min-w-0">
        <p className="text-sm font-medium">Your public page</p>
        <p className="mt-1 text-xs text-white/50 break-all">
          {url}
          {signupCount != null && (
            <span className="text-emerald-300"> · {signupCount} signup{signupCount === 1 ? '' : 's'}</span>
          )}
        </p>
      </div>
      <div className="shrink-0 flex items-center gap-2">
        <CopyLinkButton url={url} />
        <a href={url} target="_blank" rel="noopener noreferrer" className={btn}>Open</a>
        <a href="/api/host/signup-qr" className={btn}>QR code</a>
        <button type="button" onClick={() => setEditing((v) => !v)} className={btn}>Customise</button>
      </div>
      {joinUrl && (
        <div className="w-full flex flex-wrap items-center justify-between gap-3 border-t border-white/10 pt-3">
          <div className="min-w-0">
            <p className="text-sm font-medium">Signup form only</p>
            <p className="mt-1 text-xs text-white/50 break-all">{joinUrl}</p>
          </div>
          <div className="shrink-0 flex items-center gap-2">
            <CopyLinkButton url={joinUrl} />
            <a href={joinUrl} target="_blank" rel="noopener noreferrer" className={btn}>Open</a>
            <a href="/api/host/signup-qr?page=join" className={btn}>QR code</a>
          </div>
        </div>
      )}
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
