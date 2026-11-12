// MCPEMAIL.1 — `list_email_campaigns`: the studio's email campaigns, newest first.

import { z } from 'zod'
import { uuidLike } from '@/lib/schemas'
import { defineTool } from './registry.js'
import { campaignDisplayStats, loadCampaignRecipientStats } from '@/lib/campaign-display-stats'
import { emailGate, LIST_CAP, RESULT_STATUSES } from './_email-campaign.js'

const LIST_COLS = 'id, name, subject, status, scheduled_at, created_via, created_at, total_recipients, total_sent, '
  + 'total_delivered, total_opened, total_clicked, total_bounced, total_complained, total_unsubscribed'

export default defineTool({
  name: 'list_email_campaigns',
  title: 'Email campaigns',
  description: 'Lists the studio\'s email campaigns, newest first, up to 50, with status and (once sent) how many went out '
    + 'and the open and click rates. Optionally filter by status (for example "draft" or "sent"). '
    + 'Use get_email_campaign for one campaign in full.',
  inputSchema: z.object({
    studio_id: uuidLike.optional().describe('A studio id; omit for the default studio.'),
    status: z.string().min(1).max(30).optional().describe('Only campaigns with this status, e.g. "draft", "scheduled", "sent".'),
  }),
  gate: (user, studioId) => emailGate(user, studioId),
  run: async (input, ctx) => {
    const { db, studio } = ctx
    let query = db.from('campaigns').select(LIST_COLS).eq('location_id', studio.id)
    if (input.status) query = query.eq('status', input.status)
    const { data, error } = await query
      .order('created_at', { ascending: false })
      .order('id')
      .limit(LIST_CAP + 1)
    if (error) throw new Error(`Failed to load campaigns: ${error.message}`)
    const rows = data || []
    const page = rows.slice(0, LIST_CAP)

    // Stats only for ids the studio-scoped query above returned.
    const withResults = page.filter((c) => RESULT_STATUSES.includes(c.status))
    const stats = withResults.length ? await loadCampaignRecipientStats(db, withResults.map((c) => c.id)) : null

    return {
      campaigns: page.map((c) => {
        const shown = stats && RESULT_STATUSES.includes(c.status) ? campaignDisplayStats(c, stats) : null
        return {
          id: c.id,
          name: c.name,
          subject: c.subject,
          status: c.status,
          scheduled_at: c.scheduled_at ?? null,
          created_via: c.created_via,
          sent: shown ? shown.sent : null,
          open_rate: shown ? shown.open_rate : null,
          click_rate: shown ? shown.click_rate : null,
        }
      }),
      capped: rows.length > LIST_CAP,
    }
  },
})
