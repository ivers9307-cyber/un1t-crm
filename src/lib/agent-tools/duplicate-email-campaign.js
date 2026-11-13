// MCPEMAIL.2 — `duplicate_email_campaign`: copy a past marketing campaign at
// the studio as a new DRAFT, using the CRM's own duplicate allowlist. It never
// sends: only the signed-in confirm page releases a campaign.

import { z } from 'zod'
import { uuidLike } from '@/lib/schemas'
import { buildCampaignDuplicate } from '@/lib/campaign-duplicate'
import { defineTool, ToolRefusal } from './registry.js'
import { emailGate, htmlSha256 } from './_email-campaign.js'
import { sendsAs, throwWriteError } from './_email-draft.js'

// What buildCampaignDuplicate reads, plus agent_blocks (a CRM duplicate has no
// use for it). Named columns only.
const SOURCE_COLS = 'id, location_id, name, subject, preview_text, from_name, from_email, reply_to, design_json, '
  + 'html_content, audience_filter, template_id, postmark_stream, ab_subject_b, ab_test_pct, ab_wait_hours, agent_blocks'

export default defineTool({
  name: 'duplicate_email_campaign',
  title: 'Duplicate email campaign',
  description: 'Copies a past marketing email campaign at the studio as a new draft (same subject, body, sender and '
    + 'audience; no recipients, results, schedule, A/B test or resend). It never sends: a person releases it from a signed-in page. '
    + 'Says whether the body can be edited from Claude. This writes to the CRM: confirm with the user first.',
  inputSchema: z.object({
    studio_id: uuidLike.optional().describe('A studio id; omit for the default studio.'),
    campaign_id: uuidLike.describe('The campaign to copy (from list_email_campaigns).'),
    name: z.string().trim().min(1).max(200).optional().describe('Name for the copy; defaults to "Copy of <name>".'),
  }),
  gate: (user, studioId) => emailGate(user, studioId),
  writes: true,
  run: async (input, ctx) => {
    const { db, user, studio } = ctx
    const { data: source, error: readErr } = await db
      .from('campaigns')
      .select(SOURCE_COLS)
      .eq('id', input.campaign_id)
      .eq('location_id', studio.id)
      .maybeSingle()
    if (readErr) throw new Error(`Failed to load campaign: ${readErr.message}`)
    if (!source) throw new ToolRefusal('not_found', 'Campaign not found.')
    if (source.postmark_stream !== 'broadcast') {
      throw new ToolRefusal('conflict', 'This is a service email. Duplicate it in the CRM.')
    }

    const copy = buildCampaignDuplicate(source, user.id)
    const row = {
      ...copy,
      name: input.name ?? copy.name,
      created_via: 'mcp',
      agent_blocks: source.agent_blocks ?? null,
      // A copy starts clean: no A/B test, no resend, no schedule, no parent.
      ab_subject_b: null,
      ab_test_pct: null,
      ab_wait_hours: null,
      resend_enabled: false,
      resend_wait_hours: null,
      resend_subject: null,
      parent_campaign_id: null,
      scheduled_at: null,
    }
    const { data, error } = await db.from('campaigns').insert(row).select('id, name, status').single()
    if (error || !data) throwWriteError(error, 'duplicate the campaign')

    const ab = source.agent_blocks
    const editable = ab != null && htmlSha256(source.html_content) === ab.html_sha256
    return {
      campaign: { id: data.id, name: data.name, status: data.status },
      body_editable_from_claude: editable,
      sends_as: source.from_email || await sendsAs(db, studio),
    }
  },
})
