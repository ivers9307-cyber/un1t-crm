// GET /api/communications/campaigns/[id]/recipients-csv — EXPORTCSV.1
//
// Everyone an email campaign went to, as a CSV: name, email, status and when
// it was sent, delivered, opened and clicked, plus any bounce. `email` at the
// campaign's studio (loadCampaignForUser, 404 for another studio's campaign).
// Paginated past the 1,000-row cap. Opens include only those recorded as
// people since MACHINEOPEN.1; earlier rows may include mail-app fetches.

import { withAuth } from '@/lib/with-auth'
import { loadCampaignForUser, serverError } from '@/lib/campaign-session-access'
import { selectAll } from '@/lib/select-all'
import { csvCell } from '@/lib/attendee-csv'
import { logError } from '@/lib/log'

export const dynamic = 'force-dynamic'

const HEADER = ['Name', 'Email', 'Status', 'Sent', 'Delivered', 'Opened', 'Clicked', 'Bounced', 'Bounce type', 'Unsubscribed']

export const GET = withAuth({ permission: null, location: false }, async ({ user, db, params }) => {
  const { campaign, response } = await loadCampaignForUser(db, user, params?.id, 'id, name, location_id')
  if (response) return response

  let rows
  try {
    rows = await selectAll((from, to) => db
      .from('campaign_recipients')
      .select('id, status, sent_at, delivered_at, opened_at, clicked_at, bounced_at, bounce_type, unsubscribed_at, contacts!contact_id(name, email)')
      .eq('campaign_id', campaign.id)
      .order('id', { ascending: true })
      .range(from, to))
  } catch (e) {
    logError('campaigns', 'recipient export failed', { campaignId: campaign.id, message: e?.message })
    return serverError('Could not read the recipients. Try again.')
  }

  const lines = [HEADER.join(',')]
  for (const r of rows) {
    const c = r.contacts || {}
    lines.push([c.name, c.email, r.status, r.sent_at, r.delivered_at, r.opened_at, r.clicked_at, r.bounced_at, r.bounce_type, r.unsubscribed_at].map(csvCell).join(','))
  }
  const safeName = String(campaign.name || 'campaign').replace(/[^A-Za-z0-9 _-]+/g, '').trim().slice(0, 60) || 'campaign'
  return new Response(lines.join('\r\n') + '\r\n', {
    status: 200,
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${safeName} recipients.csv"`,
      'Cache-Control': 'no-store',
    },
  })
})
