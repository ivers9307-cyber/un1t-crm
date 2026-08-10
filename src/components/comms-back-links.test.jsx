// @vitest-environment jsdom
//
// COMMSLAYOUT.4 — the back-links out of the channel detail views.
//
// PILLAR2 folded the per-channel lists into one Sends history and the merge
// retired the old /email and /whatsapp hubs, but the detail views kept pointing
// at the old parents. Each one either 404-by-redirect-hop'd through a stub or
// landed a level too high (the Communications hub instead of the list the user
// had just clicked out of). Every link below must now go DIRECTLY to the page
// that linked here, with no redirect stub in between:
//
//   /email/campaigns/[id]            → /communications/sent
//   /whatsapp/broadcasts/[id]        → /communications/sent
//   /communications/sms/broadcasts/[id] → /communications/sent
//   /email/templates/[id]            → /communications/templates?channel=email
//   /whatsapp/templates/[id]         → /communications/templates?channel=whatsapp
//
// The assertion is deliberately "the first link in the header", because that is
// the affordance the user actually clicks.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, cleanup } from '@testing-library/react'

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), back: vi.fn() }),
  usePathname: () => '/',
  useSearchParams: () => new URLSearchParams(),
  redirect: vi.fn(),
}))
vi.mock('@/lib/supabase', () => ({ createBrowserClient: () => ({}) }))
vi.mock('./AudienceBuilder', () => ({ default: () => <div /> }))
vi.mock('./communications/AudienceCount', () => ({ default: () => <div /> }))
vi.mock('./communications/SendQuietHoursNotice', () => ({ default: () => <div /> }))
vi.mock('./communications/CopyAssist', () => ({ default: () => <div /> }))
vi.mock('./CampaignLinkReport.jsx', () => ({ default: () => <div /> }))
vi.mock('./CampaignOutcomeReport.jsx', () => ({ default: () => <div /> }))

import CampaignDetail from './CampaignDetail.jsx'
import CampaignEditor from './CampaignEditor.jsx'
import WABroadcastEditor from './WABroadcastEditor.jsx'
import SMSBroadcastEditor from './SMSBroadcastEditor.jsx'
import TemplateEditor from './TemplateEditor.jsx'
import WATemplateEditor from './WATemplateEditor.jsx'

const SENDS = '/communications/sent'

function firstLink(container) {
  return container.querySelector('a')?.getAttribute('href')
}

beforeEach(() => cleanup())

describe('channel detail back-links (COMMSLAYOUT.4)', () => {
  it('email campaign detail goes back to the Sends list', () => {
    const { container } = render(
      <CampaignDetail
        campaign={{ id: 'c1', name: 'Spring', subject: 'Hi', status: 'sent', location_id: 'loc-1' }}
        recipients={[]}
        stats={{ recipients: 0, sent: 0, opened: 0, clicked: 0, bounced: 0, unsubscribed: 0 }}
        abStats={null}
        resendChild={null}
        resendParent={null}
        locationId="loc-1"
        userId="u1"
      />
    )
    expect(firstLink(container)).toBe(SENDS)
  })

  it('email campaign editor goes back to the Sends list', () => {
    const { container } = render(
      <CampaignEditor
        campaign={{ id: 'c1', name: 'Draft', status: 'draft', location_id: 'loc-1' }}
        locationId="loc-1"
        userId="u1"
      />
    )
    expect(firstLink(container)).toBe(SENDS)
  })

  it('WhatsApp broadcast detail goes back to the Sends list', () => {
    const { container } = render(
      <WABroadcastEditor
        broadcast={{ id: 'b1', name: 'Blast', status: 'draft', location_id: 'loc-1', whatsapp_broadcast_recipients: [] }}
        templates={[]}
        locationId="loc-1"
        userId="u1"
      />
    )
    expect(firstLink(container)).toBe(SENDS)
  })

  it('SMS broadcast detail goes back to the Sends list', () => {
    const { container } = render(
      <SMSBroadcastEditor
        broadcast={{ id: 's1', name: 'Blast', status: 'draft', location_id: 'loc-1' }}
        locationId="loc-1"
        userId="u1"
      />
    )
    expect(firstLink(container)).toBe(SENDS)
  })

  it('email template editor goes back to the email templates list', () => {
    const { container } = render(
      <TemplateEditor template={{ id: 't1', name: 'Welcome' }} locationId="loc-1" userId="u1" />
    )
    expect(firstLink(container)).toBe('/communications/templates?channel=email')
  })

  it('WhatsApp template editor goes back to the WhatsApp templates list', () => {
    const { container } = render(
      <WATemplateEditor template={null} locationId="loc-1" userId="u1" />
    )
    expect(firstLink(container)).toBe('/communications/templates?channel=whatsapp')
  })
})
