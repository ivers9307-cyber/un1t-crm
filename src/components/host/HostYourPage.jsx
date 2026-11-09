'use client'

// "Your page" (HOSTPORTAL.1) — the host's public /h/[slug] page: its link, QR
// and the editor in visitor order, then the standalone signup form's link.
// Plain data in (urls, count, copy values); the handlers live here. Replaces
// the dashboard card's drawer.

import { useEffect, useState } from 'react'
import HostListPageEditor from '@/components/host/HostListPageEditor'
import CopyLinkButton from '@/components/host/CopyLinkButton'
import { HOST_BTN_SM } from '@/components/host/host-ui'

const BTN = HOST_BTN_SM

const WIDE = '(min-width: 1024px)'
const PREVIEW_ID = 'host-page-preview'

// The page's own path on THIS origin (the site only frames itself, so the
// customer-facing host in `url` cannot be framed). Only a bare /h/<slug>.
function previewPathOf(url) {
  try {
    const { pathname } = new URL(url)
    return /^\/h\/[^/]+$/.test(pathname) ? pathname : null
  } catch {
    return null
  }
}

// True from `lg` up. The preview is one iframe, so CSS alone cannot hide it;
// the component decides whether to mount it.
function useIsWide() {
  const [wide, setWide] = useState(false)
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return undefined
    const mql = window.matchMedia(WIDE)
    const sync = () => setWide(mql.matches)
    sync()
    // Older Safari only has the deprecated addListener/removeListener.
    if (typeof mql.addEventListener === 'function') {
      mql.addEventListener('change', sync)
      return () => mql.removeEventListener('change', sync)
    }
    if (typeof mql.addListener === 'function') {
      mql.addListener(sync)
      return () => mql.removeListener(sync)
    }
    return undefined
  }, [])
  return wide
}

export default function HostYourPage({ url, joinUrl, signupCount, copyValues }) {
  const [copy, setCopy] = useState(copyValues)
  const [saves, setSaves] = useState(0)
  const [open, setOpen] = useState(false)
  const wide = useIsWide()
  const previewPath = previewPathOf(url)
  const showPreview = open || wide

  return (
    <div>
      <div data-testid="your-page-link" className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-medium">Your public page</p>
          <p className="mt-1 text-xs text-host-hint break-all">{url}</p>
          {signupCount != null && (
            <p className="mt-1 text-xs text-host-ok">{signupCount} list signup{signupCount === 1 ? '' : 's'}</p>
          )}
        </div>
        <div className="shrink-0 flex items-center gap-2">
          <a href={url} target="_blank" rel="noopener noreferrer" className={BTN}>Open</a>
          <CopyLinkButton url={url} />
          <a href="/api/host/signup-qr" className={BTN}>QR code</a>
        </div>
      </div>

      <div className={previewPath ? 'lg:grid lg:grid-cols-[minmax(0,1fr)_minmax(0,24rem)] lg:gap-8 lg:items-start' : ''}>
        <div className="min-w-0">
          <HostListPageEditor
            layout="sections"
            initial={copy}
            previewUrl={url}
            onSaved={(v) => { setCopy(v); setSaves((n) => n + 1) }}
          />
          {previewPath && (
            <button
              type="button"
              aria-expanded={open}
              aria-controls={PREVIEW_ID}
              onClick={() => setOpen((o) => !o)}
              className={`${BTN} mt-4 lg:hidden`}
            >
              {open ? 'Hide preview' : 'Show preview'}
            </button>
          )}
        </div>
        {previewPath && (
          <div id={PREVIEW_ID} className="lg:sticky lg:top-4 min-w-0">
            {showPreview && (
              <div className="mt-4 lg:mt-0">
                <div className="overflow-hidden rounded-lg border border-host-edge bg-host-panel">
                  <iframe
                    key={saves}
                    title="Preview of your public page"
                    src={previewPath}
                    loading="lazy"
                    className="block h-[min(640px,calc(100vh-6rem))] w-full"
                  />
                </div>
                <p className="mt-2 text-xs text-host-hint">This shows your saved page. Save to update it.</p>
              </div>
            )}
          </div>
        )}
      </div>

      {joinUrl && (
        <div data-testid="signup-form-link" className="mt-8 border-t border-host-border pt-4 flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="text-sm font-medium">Signup form only</p>
            <p className="mt-1 text-xs text-host-hint break-all">{joinUrl}</p>
            <p className="mt-1 text-xs text-host-hint">Just the form, for bios and stories.</p>
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
