// Xero integration tab. Wraps the existing XeroLocationCard which
// already handles the OAuth start + status display + reconnect /
// disconnect. Hosted in the Integrations hub's Manage drawer
// (/settings/integrations-hub?manage=xero&location=<id>, INTEGONE.1), the
// only Xero settings surface — the old cross-location overview at
// /settings/integrations was retired (INTEG-A4), and the per-location
// Integrations tab (/settings/locations/[id]?tab=xero) redirects there.
//
// RSC-AUDIT.2: no own state / events / browser APIs — every
// interactive bit lives in XeroLocationCard. Its host,
// IntegrationsHubDrawer, is a Client Component, so this gets
// implicit-client-bundled with the same end result and one less
// directive cluttering the file.

import XeroLocationCard from '@/components/settings/XeroLocationCard'
import ReadFailedNote from '@/components/settings/ReadFailedNote'
import XeroCallbackNotice from '@/components/settings/XeroCallbackNotice'
import { hubManageHref } from '@/lib/integrations-hub-links'

// CHANNELREAD.1 — `readFailed`: the xero_connections read failed.
// Rendering XeroLocationCard with connection=null would say "Not connected."
// and offer Connect Xero (an OAuth REBIND of this location) over a live
// connection. Try again re-reads: the drawer passes `onRetry` (it re-reads its
// own context); without one, the note links to this drawer's hub URL, which
// re-opens it from a fresh page load.
//
// INTEGONE.1 — hosted in the Integrations hub's Manage drawer. GET
// /api/xero/callback lands on the hub (with this drawer open) by default, and
// the hub page renders XeroCallbackNotice itself, so the drawer passes
// showCallbackNotice=false and the outcome is not shown twice. Connect
// bounces back to the hub with this drawer open (returnTo).
export default function XeroIntegrationTab({ location, connection, readFailed = false, showCallbackNotice = true, onRetry = null, returnTo = null }) {
  return (
    <div className="space-y-3">
      <div className="text-xs text-un1t-subtle">
        Connect this location to a Xero organisation. Used today to push customer invoices
        when a car is marked completed, and to forward supplier-invoice docs into Xero's
        Bills inbox via auto-OCR.
      </div>
      {showCallbackNotice && <XeroCallbackNotice />}
      {readFailed ? (
        onRetry
          ? <ReadFailedNote what="this location's Xero connection" onRetry={onRetry} />
          : <ReadFailedNote what="this location's Xero connection" href={hubManageHref(location.id, 'xero')} />
      ) : (
        <XeroLocationCard location={location} connection={connection || null} returnTo={returnTo} />
      )}
    </div>
  )
}
