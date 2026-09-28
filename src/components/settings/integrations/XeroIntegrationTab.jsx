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

// CHANNELREAD.1 — `readFailed`: the page's xero_connections read failed.
// Rendering XeroLocationCard with connection=null would say "Not connected."
// and offer Connect Xero (an OAuth REBIND of this location) over a live
// connection. The data is server-rendered, so Try again re-opens this tab.
export default function XeroIntegrationTab({ location, connection, readFailed = false }) {
  return (
    <div className="space-y-3">
      <div className="text-xs text-un1t-subtle">
        Connect this location to a Xero organisation. Used today to push customer invoices
        when a car is marked completed, and to forward supplier-invoice docs into Xero's
        Bills inbox via auto-OCR.
      </div>
      {readFailed ? (
        <ReadFailedNote what="this location's Xero connection" href={`/settings/locations/${location.id}?tab=xero`} />
      ) : (
        <XeroLocationCard location={location} connection={connection || null} />
      )}
    </div>
  )
}
