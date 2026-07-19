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

export default function XeroIntegrationTab({ location, connection }) {
  return (
    <div className="space-y-3">
      <div className="text-xs text-un1t-subtle">
        Connect this location to a Xero organisation. Used today to push customer invoices
        when a car is marked completed, and to forward supplier-invoice docs into Xero's
        Bills inbox via auto-OCR.
      </div>
      <XeroLocationCard location={location} connection={connection || null} />
    </div>
  )
}
