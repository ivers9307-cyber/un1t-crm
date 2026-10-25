// Xero integration tab. Wraps the existing XeroLocationCard which
// already handles the OAuth start + status display + reconnect /
// disconnect. This tab (/settings/locations/[id]?tab=xero) is the
// only Xero settings surface — the old cross-location overview at
// /settings/integrations was retired (INTEG-A4).
//
// RSC-AUDIT.2: no own state / events / browser APIs — every
// interactive bit lives in XeroLocationCard. Parent
// LocationIntegrations is a Client Component, so this gets
// implicit-client-bundled with the same end result and one less
// directive cluttering the file.

import XeroLocationCard from '@/components/settings/XeroLocationCard'
import ReadFailedNote from '@/components/settings/ReadFailedNote'
import XeroCallbackNotice from '@/components/settings/XeroCallbackNotice'

// CHANNELREAD.1 — `readFailed`: the page's xero_connections read failed.
// Rendering XeroLocationCard with connection=null would say "Not connected."
// and offer Connect Xero (an OAuth REBIND of this location) over a live
// connection. The data is server-rendered, so Try again re-opens this tab.
// XeroCallbackNotice: this tab is where GET /api/xero/callback lands by
// default, so the connect's outcome (a code in the URL) is shown here.
//
// INTEGONE.1 — hosted in the Integrations hub's Manage drawer too. There the
// hub page already renders XeroCallbackNotice (showCallbackNotice=false, so
// the outcome is not shown twice), the drawer re-reads its own context on
// Try again (onRetry instead of the page href), and Connect bounces back to
// the hub with this drawer open (returnTo).
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
          : <ReadFailedNote what="this location's Xero connection" href={`/settings/locations/${location.id}?tab=xero`} />
      ) : (
        <XeroLocationCard location={location} connection={connection || null} returnTo={returnTo} />
      )}
    </div>
  )
}
