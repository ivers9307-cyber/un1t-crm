'use client'

// "Your page" (HOSTPORTAL.1) — the host's public /h/[slug] page: its link, QR
// and the editor in visitor order, then the standalone signup form's link.
// Plain data in (urls, count, copy values); the handlers live here. Replaces
// the dashboard card's drawer.

import { useState } from 'react'
import HostListPageEditor from '@/components/host/HostListPageEditor'
import CopyLinkButton from '@/components/host/CopyLinkButton'

const BTN = 'rounded-lg border border-white/15 text-white/80 text-xs font-semibold px-3 py-1.5 hover:bg-white/10 hover:text-white'

export default function HostYourPage({ url, joinUrl, signupCount, copyValues }) {
  const [copy, setCopy] = useState(copyValues)

  return (
    <div>
      <div data-testid="your-page-link" className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-medium">Your public page</p>
          <p className="mt-1 text-xs text-white/50 break-all">{url}</p>
          {signupCount != null && (
            <p className="mt-1 text-xs text-emerald-300">{signupCount} list signup{signupCount === 1 ? '' : 's'}</p>
          )}
        </div>
        <div className="shrink-0 flex items-center gap-2">
          <a href={url} target="_blank" rel="noopener noreferrer" className={BTN}>Open</a>
          <CopyLinkButton url={url} />
          <a href="/api/host/signup-qr" className={BTN}>QR code</a>
        </div>
      </div>

      <HostListPageEditor
        layout="sections"
        initial={copy}
        previewUrl={url}
        onSaved={(v) => setCopy(v)}
      />

      {joinUrl && (
        <div data-testid="signup-form-link" className="mt-8 border-t border-white/10 pt-4 flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="text-sm font-medium">Signup form only</p>
            <p className="mt-1 text-xs text-white/50 break-all">{joinUrl}</p>
            <p className="mt-1 text-xs text-white/40">Just the form, for bios and stories.</p>
          </div>
          <div className="shrink-0 flex items-center gap-2">
            <CopyLinkButton url={joinUrl} />
            <a href={joinUrl} target="_blank" rel="noopener noreferrer" className={BTN}>Open</a>
            <a href="/api/host/signup-qr?page=join" className={BTN}>QR code</a>
          </div>
        </div>
      )}
    </div>
  )
}
