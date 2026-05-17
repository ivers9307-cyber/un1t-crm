'use client'

// Xero integration tab. Wraps the existing XeroLocationCard which
// already handles the OAuth start + status display + reconnect /
// disconnect. The cross-location overview at /settings/integrations
// stays as-is (kept per the SETTINGS.1 spec) — this tab is the
// single-location surface.

import XeroLocationCard from '@/components/settings/XeroLocationCard'

export default function XeroIntegrationTab({ location, connection }) {
  return (
    <div className="space-y-3">
      <div className="text-xs text-un1t-light">
        Connect this location to a Xero organisation. Used today to push customer invoices
        when a car is marked completed, and to forward supplier-invoice docs into Xero's
        Bills inbox via auto-OCR.
      </div>
      <XeroLocationCard location={location} connection={connection || null} />
    </div>
  )
}
