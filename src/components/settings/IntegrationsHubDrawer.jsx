'use client'

// INTEG hub inline #4 (Phase 1) — the per-card "Manage" slide-over.
//
// A right-side drawer that hosts the EXISTING per-location management
// surfaces inline in the Integrations hub, so an owner connects / tests /
// disconnects without leaving the hub:
//   ads       → AdsIntegrationTab (the same tab the Edit-Location page
//               renders), saving via PUT /api/settings/ads and testing via
//               POST /api/settings/ads/test.
//   instagram → ConnectionsSection (embedded), saving via
//               /api/locations/[id]/channels (+ /[connId]) create/patch/delete.
//
// No new route and no new secret path: both hosted components already mask
// tokens (write-only — a blank field keeps the stored secret) and the routes
// enforce their own per-location guards. On a successful save/connect/
// disconnect the drawer calls onChanged() so the hub re-grades its chip +
// attention strip from a single scoped GET /api/integrations/hub — no full
// navigation.
//
// Accessibility: role=dialog + aria-modal, ESC closes, a focus trap keeps Tab
// inside the panel, focus returns to the opener on close, body scroll is
// locked, and the slide/scrim transitions are gated behind motion-safe (so
// prefers-reduced-motion users get an instant, motionless open). Every
// non-submit control is type="button".

import { useEffect, useId, useRef, useState } from 'react'
import Link from 'next/link'
import { X } from 'lucide-react'
import { buttonClasses } from '@/components/ui'
import AdsIntegrationTab from './integrations/AdsIntegrationTab'
import ConnectionsSection from '@/components/customer-agent/ConnectionsSection'

const TITLES = { ads: 'Meta Ads', instagram: 'Instagram' }

// The advanced/old-tab deep-link key for each card. The old
// ?tab=<key> surfaces still render post-B4; we surface a subtle link only
// where the tab exposes config the drawer doesn't — Ads carries the daily
// report-recipient settings inside AdsIntegrationTab itself, but the link is
// still a useful escape hatch for the full Edit-Location context.
const TAB_KEY = { ads: 'ads', instagram: 'instagram' }

const FOCUSABLE =
  'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])'

export default function IntegrationsHubDrawer({ cardKey, locationId, locationName, onClose, onChanged }) {
  const panelRef = useRef(null)
  const titleId = useId()
  const [entered, setEntered] = useState(false)

  // Slide-in on mount (motion-safe only — see className).
  useEffect(() => {
    const raf = requestAnimationFrame(() => setEntered(true))
    return () => cancelAnimationFrame(raf)
  }, [])

  // Focus trap + ESC + scroll-lock, with focus restored to the opener.
  useEffect(() => {
    const panel = panelRef.current
    if (!panel) return undefined
    const opener = document.activeElement
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'

    const focusables = () => Array.from(panel.querySelectorAll(FOCUSABLE))
    // Initial focus: first control, else the panel itself.
    ;(focusables()[0] || panel).focus()

    function onKey(e) {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
        return
      }
      if (e.key !== 'Tab') return
      const items = focusables()
      if (items.length === 0) {
        e.preventDefault()
        panel.focus()
        return
      }
      const first = items[0]
      const last = items[items.length - 1]
      const active = document.activeElement
      if (e.shiftKey && (active === first || active === panel)) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && active === last) {
        e.preventDefault()
        first.focus()
      }
    }

    panel.addEventListener('keydown', onKey)
    return () => {
      panel.removeEventListener('keydown', onKey)
      document.body.style.overflow = prevOverflow
      if (opener && typeof opener.focus === 'function') opener.focus()
    }
  }, [onClose])

  const title = TITLES[cardKey] || 'Integration'

  return (
    <>
      {/* Scrim — click to close; fades in only when motion is allowed. */}
      <div
        className={`fixed inset-0 z-40 bg-black/30 motion-safe:transition-opacity motion-safe:duration-200 ${entered ? 'opacity-100' : 'opacity-0'}`}
        onMouseDown={onClose}
        aria-hidden="true"
      />
      <aside
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className={`fixed inset-y-0 right-0 z-50 w-[540px] max-w-[94vw] flex flex-col bg-un1t-bg border-l border-un1t-border shadow-2xl outline-none transform motion-safe:transition-transform motion-safe:duration-200 ${entered ? 'translate-x-0' : 'translate-x-full'}`}
      >
        {/* Header */}
        <div className="flex items-start justify-between gap-3 border-b border-un1t-border px-5 py-3">
          <div className="min-w-0">
            <h2 id={titleId} className="text-sm font-semibold text-un1t-text">Manage {title}</h2>
            {locationName && <p className="text-xs text-un1t-subtle mt-0.5 truncate">{locationName}</p>}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="shrink-0 rounded-md p-1 text-un1t-subtle hover:bg-un1t-surface hover:text-un1t-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-un1t-accent"
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>

        {/* Body — the existing management surface, hosted inline. */}
        <div className="flex-1 overflow-y-auto px-5 py-4">
          {cardKey === 'ads' && (
            <AdsIntegrationTab
              location={{ id: locationId, name: locationName }}
              canEdit
              onChanged={onChanged}
            />
          )}
          {cardKey === 'instagram' && (
            <ConnectionsSection
              locationId={locationId}
              locationName={locationName}
              embedded
              onChanged={onChanged}
            />
          )}
        </div>

        {/* Footer — subtle escape hatch to the full Edit-Location tab. */}
        {TAB_KEY[cardKey] && (
          <div className="border-t border-un1t-border px-5 py-2.5">
            <Link
              href={`/settings/locations/${locationId}?tab=${TAB_KEY[cardKey]}`}
              className={buttonClasses({ variant: 'secondary', size: 'sm' })}
            >
              Advanced settings
            </Link>
          </div>
        )}
      </aside>
    </>
  )
}
