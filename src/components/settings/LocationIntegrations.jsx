'use client'

// LocationIntegrations — tabbed container for all the per-location
// credential-bearing integrations on /settings/locations/[id].
//
// Each tab is its own focused component (XeroIntegrationTab,
// GlofoxIntegrationTab, etc.) with its own state + save endpoint.
// The parent only owns:
//   - the tab strip (which tabs to show, which is active)
//   - active-tab state via the ?tab= query param so the URL is
//     shareable / bookmarkable / back-forward-able
//   - the unified header chrome
//
// Visibility rule per Phase 5 spec: hide tabs whose feature is OFF
// at this location. Toggling a feature back on (in Features above)
// auto-shows the tab on next router.refresh() — LocationFeatures
// already calls refresh after saves.

import { useRouter, useSearchParams } from 'next/navigation'
import {
  Plug, Zap, DoorOpen, Snowflake, FileCheck, MessageSquare, MessageCircle,
  AlertCircle, CheckCircle2,
} from 'lucide-react'
import { isFeatureEnabledAtLocation } from '@shared/permissions'

import XeroIntegrationTab from './integrations/XeroIntegrationTab'
import GlofoxIntegrationTab from './integrations/GlofoxIntegrationTab'
import UnifiIntegrationTab from './integrations/UnifiIntegrationTab'
import SensiboIntegrationTab from './integrations/SensiboIntegrationTab'
import BcaIntegrationTab from './integrations/BcaIntegrationTab'
import TwilioIntegrationTab from './integrations/TwilioIntegrationTab'
import WhatsAppIntegrationTab from './integrations/WhatsAppIntegrationTab'

export default function LocationIntegrations({ location, xeroConnection, user, sampleBcaCar }) {
  const router = useRouter()
  const searchParams = useSearchParams()

  // Build the visible tab list based on this location's features +
  // the caller's role. Hidden tabs aren't rendered at all so the URL
  // can't be deep-linked to a tab that doesn't apply here.
  const features = location.features || {}
  const isMaster = user.role === 'master'
  const isOwnerOrMaster = user.role === 'master' || user.role === 'owner'

  const tabs = []
  // Xero is a platform-wide finance integration, not a car-processing
  // add-on. The invoice-ingest queue (INVOICES-QUEUE.1) pushes every
  // location's supplier invoices to that location's connected Xero org,
  // and car_processing locations additionally push car invoices. Show
  // it to owner/master at every location — this page is already
  // owner/master-only. Previously gated on `car_processing`, which hid
  // it (and the chart-of-accounts / contacts sync) from non-CCF
  // locations like Stillorgan that still need a Xero connection.
  if (isOwnerOrMaster) {
    tabs.push({
      key: 'xero',
      label: 'Xero',
      Icon: Plug,
      status: xeroConnection?.tenant_id ? 'connected' : 'not-configured',
    })
  }
  if (location.settings?.glofox || features.bookings || features.contacts) {
    tabs.push({
      key: 'glofox',
      label: 'Glofox',
      Icon: Zap,
      status: location.settings?.glofox?.api_key ? 'connected' : 'not-configured',
    })
  }
  // Twilio (SMS) — alpha sender ID. Twilio account creds are global
  // env vars; this tab is only useful when SMS feature is on at the
  // location AND the operator wants a per-location branded sender.
  if (isOwnerOrMaster && (features.sms !== false || location.twilio_alpha_sender_id)) {
    tabs.push({
      key: 'twilio',
      label: 'Twilio (SMS)',
      Icon: MessageSquare,
      status: location.twilio_alpha_sender_id ? 'connected' : 'not-configured',
    })
  }
  // WA-MULTI.1 — WhatsApp per-location numbers. Tab is visible when
  // the location has the whatsapp feature on, OR when the master is
  // looking (so a not-yet-enabled location still surfaces the
  // first-time setup path). Statuses come from the API on render.
  if ((features.whatsapp !== false || isMaster) && isOwnerOrMaster) {
    tabs.push({
      key: 'whatsapp',
      label: 'WhatsApp',
      Icon: MessageCircle,
      status: 'not-configured', // populated lazily by the tab component
    })
  }
  if (isFeatureEnabledAtLocation(location, 'studio_management') && isMaster) {
    tabs.push({
      key: 'unifi',
      label: 'UniFi Access',
      Icon: DoorOpen,
      status: location.settings?.unifi?.api_token ? 'connected' : 'not-configured',
    })
  }
  // Sensibo / AC — master + owner. Always visible when at least one
  // of the two is set (otherwise show only to master so they can
  // turn it on for a location for the first time).
  if (isOwnerOrMaster) {
    tabs.push({
      key: 'sensibo',
      label: 'Sensibo / AC',
      Icon: Snowflake,
      status: location.sensibo_api_key ? 'connected' : 'not-configured',
    })
  }
  if (features.bca_submit === true && isOwnerOrMaster) {
    tabs.push({
      key: 'bca',
      label: 'BCA Submit',
      Icon: FileCheck,
      status: location.bca_config?.send_from ? 'connected' : 'not-configured',
    })
  }

  if (tabs.length === 0) {
    return null  // No integrations apply at this location — hide entirely
  }

  // Active tab from URL; fallback to first tab.
  const activeTabKey = searchParams.get('tab') || tabs[0].key
  const validKeys = new Set(tabs.map(t => t.key))
  const activeKey = validKeys.has(activeTabKey) ? activeTabKey : tabs[0].key

  function switchTab(key) {
    const params = new URLSearchParams(searchParams.toString())
    params.set('tab', key)
    router.replace(`?${params.toString()}`, { scroll: false })
  }

  return (
    <section className="mt-10">
      <div className="flex items-center gap-2 mb-3">
        <Plug size={16} className="text-un1t-light" />
        <h3 className="text-lg font-semibold">Integrations</h3>
      </div>

      <div className="bg-un1t-dark border border-un1t-gray rounded-lg overflow-hidden">
        {/* Tab strip */}
        <div className="flex border-b border-un1t-gray overflow-x-auto">
          {tabs.map(({ key, label, Icon, status }) => {
            const isActive = key === activeKey
            return (
              <button
                key={key}
                type="button"
                onClick={() => switchTab(key)}
                className={`flex-shrink-0 inline-flex items-center gap-2 px-4 py-3 text-sm font-medium border-b-2 transition-colors ${
                  isActive
                    ? 'border-un1t-white text-un1t-white bg-un1t-gray/30'
                    : 'border-transparent text-un1t-light hover:text-un1t-white hover:bg-un1t-gray/20'
                }`}
              >
                <Icon size={14} />
                <span>{label}</span>
                <StatusDot status={status} />
              </button>
            )
          })}
        </div>

        {/* Active tab content */}
        <div className="p-5">
          {activeKey === 'xero' && (
            <XeroIntegrationTab location={location} connection={xeroConnection} />
          )}
          {activeKey === 'glofox' && (
            <GlofoxIntegrationTab location={location} canEdit={isOwnerOrMaster} />
          )}
          {activeKey === 'unifi' && (
            <UnifiIntegrationTab location={location} canEdit={isMaster} />
          )}
          {activeKey === 'sensibo' && (
            <SensiboIntegrationTab location={location} canEdit={isOwnerOrMaster} />
          )}
          {activeKey === 'bca' && (
            <BcaIntegrationTab location={location} canEdit={isMaster} sampleCar={sampleBcaCar} />
          )}
          {activeKey === 'twilio' && (
            <TwilioIntegrationTab location={location} canEdit={isOwnerOrMaster} />
          )}
          {activeKey === 'whatsapp' && (
            <WhatsAppIntegrationTab location={location} canEdit={isOwnerOrMaster} />
          )}
        </div>
      </div>
    </section>
  )
}

function StatusDot({ status }) {
  if (status === 'connected') {
    return <CheckCircle2 size={10} className="text-green-500" />
  }
  if (status === 'error') {
    return <AlertCircle size={10} className="text-red-400" />
  }
  // not-configured: small grey dot
  return <span className="w-2 h-2 rounded-full bg-un1t-mid inline-block" />
}
