'use client'

// INTEG hub inline #4 / INTEGONE.1 — the per-card "Manage" slide-over.
//
// The hub is the ONLY integrations surface. This drawer hosts the FULL
// per-provider tab each card manages, the same components the per-location
// Integrations tab on /settings/locations/[id] used (that tab is retired, and
// its URLs redirect here), unchanged, so nothing here links back out for "the
// rest of" an integration.
// The thin credential forms (IntegrationCredForm + PROVIDER_SPECS), the
// compact Xero / WhatsApp panels and the "Advanced settings" footer link are
// gone: they were a second, partial copy of those tabs.
//
// CONTEXT. Most hosted tabs take what that page assembled for them on the
// server (the shaped location row, the Xero connection, the BCA sample car,
// the membership-source state) plus props derived from the viewer's role AT
// this location. The drawer reads all of it from ONE route when it opens,
// GET /api/integrations/hub/locations/[id] (src/lib/integrations-hub-location.js),
// which judges the roles server-side, so the drawer never reasons about them:
//   loading  → a spinner
//   error    → "Could not load …" with Try again (ReadFailedNote), and no tab:
//              a tab rendered over unread data is how a working connection
//              gets overwritten (CHANNELREAD.1)
//   404      → not available to this viewer (owner here or master only)
//   ready    → the hosted tab, with the props the old page gave it
// Ads and Instagram need no context: they host as they did in Phase 1.
//
// REFRESH. A hosted tab that saves either calls onChanged (Ads, Instagram,
// WhatsApp) or router.refresh() (the rest, as on the old page). Both reach
// here: onChanged re-reads this context and asks the hub to re-grade its
// cards; a router.refresh() re-renders the hub page, whose new payload the hub
// hands down as a new `refreshKey`, and the context is re-read quietly then
// too (the tab stays mounted; a failed quiet re-read keeps the last good one).
//
// WhatsApp is the LIVE customer channel. This only HOSTS the existing studio
// tab; no send, routing or number-resolution code is touched here.
//
// Accessibility (unchanged): role=dialog + aria-modal, ESC closes, focus trap,
// focus restored to the opener, body-scroll lock, motion-safe transitions,
// type="button" on every non-submit control.

import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { X, Loader2 } from 'lucide-react'
import ReadFailedNote from './ReadFailedNote'
import AdsIntegrationTab from './integrations/AdsIntegrationTab'
import ConnectionsSection from '@/components/customer-agent/ConnectionsSection'
import GlofoxIntegrationTab from './integrations/GlofoxIntegrationTab'
import Un1tOnlineIntegrationTab from './integrations/Un1tOnlineIntegrationTab'
import PaymentsIntegrationTab from './integrations/PaymentsIntegrationTab'
import XeroIntegrationTab from './integrations/XeroIntegrationTab'
import WhatsAppIntegrationTab from './integrations/WhatsAppIntegrationTab'
import UnifiIntegrationTab from './integrations/UnifiIntegrationTab'
import AcDevicesIntegrationTab from './integrations/AcDevicesIntegrationTab'
import BcaIntegrationTab from './integrations/BcaIntegrationTab'
import MembershipSourceCard from './MembershipSourceCard'
import { hubManageHref } from '@/lib/integrations-hub-links'

export const DRAWER_TITLES = {
  'membership-source': 'Membership source',
  glofox: 'Glofox',
  'un1t-online': 'un1t.online',
  payments: 'Payments',
  whatsapp: 'WhatsApp',
  instagram: 'Instagram',
  xero: 'Xero',
  ads: 'Meta Ads',
  unifi: 'UniFi Access',
  climate: 'Climate devices',
  bca: 'BCA Submit',
}

// Cards whose hosted component needs no server context.
const NO_CONTEXT = new Set(['ads', 'instagram'])

export const hubLocationContextUrl = (locationId) =>
  `/api/integrations/hub/locations/${encodeURIComponent(locationId)}`

const FOCUSABLE =
  'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])'

export default function IntegrationsHubDrawer({ cardKey, locationId, locationName, refreshKey = 0, onClose, onChanged }) {
  const panelRef = useRef(null)
  const titleId = useId()
  const [entered, setEntered] = useState(false)
  const needsContext = !NO_CONTEXT.has(cardKey)
  // status: loading | ready | error | notFound
  const [ctx, setCtx] = useState({ status: needsContext ? 'loading' : 'ready', data: null })
  const seq = useRef(0)

  useEffect(() => {
    const raf = requestAnimationFrame(() => setEntered(true))
    return () => cancelAnimationFrame(raf)
  }, [])

  // mode: 'initial' (shows the spinner), 'retry' (Try again: the note stays
  // mounted so it can say "Still could not load"), 'refresh' (after a save:
  // the tab stays mounted, and a failure keeps the last good context).
  const load = useCallback(async (mode = 'initial') => {
    if (!needsContext) return true
    const mine = ++seq.current
    if (mode === 'initial') setCtx({ status: 'loading', data: null })
    let res = null
    let body = null
    try {
      res = await fetch(hubLocationContextUrl(locationId), { credentials: 'same-origin', cache: 'no-store' })
      body = await res.json().catch(() => null)
    } catch {
      res = null
    }
    if (mine !== seq.current) return false // a newer read owns the state
    if (res?.ok && body?.success && body.data) {
      setCtx({ status: 'ready', data: body.data })
      return true
    }
    if (mode === 'refresh') return false
    setCtx({ status: res?.status === 404 ? 'notFound' : 'error', data: null })
    return false
  }, [locationId, needsContext])

  useEffect(() => { load('initial') }, [load])

  // The hub page re-rendered (a hosted tab called router.refresh()).
  const lastRefreshKey = useRef(refreshKey)
  useEffect(() => {
    if (refreshKey === lastRefreshKey.current) return
    lastRefreshKey.current = refreshKey
    load('refresh')
  }, [refreshKey, load])

  const handleChanged = useCallback(() => {
    onChanged?.()
    load('refresh')
  }, [onChanged, load])

  useEffect(() => {
    const panel = panelRef.current
    if (!panel) return undefined
    const opener = document.activeElement
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'

    const focusables = () => Array.from(panel.querySelectorAll(FOCUSABLE))
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

  const title = DRAWER_TITLES[cardKey] || 'Integration'
  const where = locationName || 'this location'

  return (
    <>
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
        className={`fixed inset-y-0 right-0 z-50 w-[720px] max-w-[96vw] flex flex-col bg-un1t-bg border-l border-un1t-border shadow-2xl outline-none transform motion-safe:transition-transform motion-safe:duration-200 ${entered ? 'translate-x-0' : 'translate-x-full'}`}
      >
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

        <div className="flex-1 overflow-y-auto px-5 py-4">
          {cardKey === 'ads' && (
            <AdsIntegrationTab location={{ id: locationId, name: locationName }} canEdit onChanged={onChanged} />
          )}
          {cardKey === 'instagram' && (
            <ConnectionsSection locationId={locationId} locationName={locationName} embedded onChanged={onChanged} />
          )}

          {needsContext && ctx.status === 'loading' && (
            <div role="status" className="flex items-center gap-2 text-xs text-un1t-subtle py-6">
              <Loader2 size={14} className="animate-spin" aria-hidden="true" /> {`Loading ${title} settings…`}
            </div>
          )}
          {needsContext && ctx.status === 'error' && (
            <ReadFailedNote what={`${title} for ${where}`} onRetry={() => load('retry')} />
          )}
          {needsContext && ctx.status === 'notFound' && (
            <p className="text-xs text-un1t-subtle bg-un1t-surface border border-un1t-border rounded-md px-3 py-2">
              {`${title} for ${where} is managed by an owner at that location or a master. Ask one of them to make changes here.`}
            </p>
          )}
          {needsContext && ctx.status === 'ready' && ctx.data && (
            <HostedTab
              cardKey={cardKey}
              context={ctx.data}
              onChanged={handleChanged}
              onRetry={() => load('retry')}
            />
          )}
        </div>
      </aside>
    </>
  )
}

// The hosted component per card, with exactly the props the retired
// per-location Integrations tab gave it (roles from the server's `viewer` flags).
function HostedTab({ cardKey, context, onChanged, onRetry }) {
  const { location, xeroConnection, xeroReadFailed, sampleBcaCar, membershipSource, hasUn1tOnlineConnection } = context
  const viewer = context.viewer || {}
  if (!location) return null

  switch (cardKey) {
    case 'membership-source':
      return <MembershipSourceCard locationId={location.id} membershipSource={membershipSource} canEdit={!!viewer.isOwnerOrMaster} />
    case 'glofox':
      return <GlofoxIntegrationTab location={location} canEdit={!!viewer.isOwnerOrMaster} />
    case 'un1t-online': {
      // UN1TSYNC.7's offer rule, kept from the old tab strip: a studio already
      // on un1t.online, on 'none' (connecting selects it), or holding an active
      // token (so it can always be disconnected). A Glofox studio is not offered it.
      const source = location.membership_source ?? 'none'
      if (!(hasUn1tOnlineConnection || source === 'un1t_online' || source === 'none')) {
        return (
          <p className="text-xs text-un1t-subtle">
            un1t.online is not offered here while this studio&apos;s membership source is Glofox. Change the membership source first.
          </p>
        )
      }
      return <Un1tOnlineIntegrationTab location={location} canEdit={!!viewer.isOwnerOrMaster} />
    }
    case 'payments':
      return <PaymentsIntegrationTab location={location} canEdit={!!viewer.isOwnerOrMaster} />
    case 'xero':
      return (
        <XeroIntegrationTab
          location={location}
          connection={xeroConnection}
          readFailed={!!xeroReadFailed}
          showCallbackNotice={false}
          onRetry={onRetry}
          returnTo={hubManageHref(location.id, 'xero')}
        />
      )
    case 'whatsapp':
      // WA-MULTI.1's rule from the old tab strip: the feature is on here (or a
      // master is looking), and the viewer owns WhatsApp at this location.
      if (!((location.features?.whatsapp !== false || viewer.isMaster) && viewer.ownsWhatsAppHere)) {
        return <p className="text-xs text-un1t-subtle">WhatsApp is switched off for this location.</p>
      }
      return (
        <WhatsAppIntegrationTab
          location={location}
          canEdit={!!viewer.ownsWhatsAppHere}
          canManageNumbers={!!viewer.canManageNumbers}
          canSwitch={!!viewer.canSwitchWhatsApp}
          onChanged={onChanged}
        />
      )
    case 'unifi':
      return <UnifiIntegrationTab location={location} canEdit={!!viewer.isMaster} />
    case 'climate':
      return <AcDevicesIntegrationTab location={location} canEdit={!!viewer.isOwnerOrMaster} canManage={!!viewer.isMaster} />
    case 'bca':
      return <BcaIntegrationTab location={location} canEdit={!!viewer.isMaster} sampleCar={sampleBcaCar} />
    default:
      return null
  }
}
