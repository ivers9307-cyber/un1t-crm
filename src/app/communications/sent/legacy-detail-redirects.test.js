// COMMS-IA.1 — the retired detail URLs must never 404.
//
// /email/campaigns/[id], /whatsapp/broadcasts/[id] and
// /communications/sms/broadcasts/[id] are live URLs: they are bookmarked, and
// /email/campaigns/[id] in particular is linked from notification email. The
// consolidation moved all three under /communications/sent/[channel]/[id], so
// each old path keeps a redirect stub — the same mechanism the retired hub
// pages (/email, /whatsapp, /communications/campaigns, …) already use.
//
// /email/campaigns/new is the orphan composer (COMMS-IA.2). Nothing in src/
// linked to it, but it may be bookmarked, so it redirects to the primary
// composer rather than 404ing.

import { describe, it, expect, vi } from 'vitest'

vi.mock('next/navigation', () => ({
  redirect: vi.fn((url) => { throw new Error(`NEXT_REDIRECT:${url}`) }),
}))

import EmailCampaignRedirect from '../../email/campaigns/[id]/page.js'
import EmailCampaignNewRedirect from '../../email/campaigns/new/page.js'
import WaBroadcastRedirect from '../../whatsapp/broadcasts/[id]/page.js'
import SmsBroadcastRedirect from '../sms/broadcasts/[id]/page.js'

function run(page, params, searchParams = {}) {
  return page({ params: Promise.resolve(params), searchParams: Promise.resolve(searchParams) })
}

describe('retired channel-detail URLs redirect to the consolidated route', () => {
  it('/email/campaigns/[id] → /communications/sent/email/[id]', async () => {
    await expect(run(EmailCampaignRedirect, { id: 'c1' }))
      .rejects.toThrow('NEXT_REDIRECT:/communications/sent/email/c1')
  })

  it('/email/campaigns/[id]?edit=1 keeps the edit flag', async () => {
    await expect(run(EmailCampaignRedirect, { id: 'c1' }, { edit: '1' }))
      .rejects.toThrow('NEXT_REDIRECT:/communications/sent/email/c1?edit=1')
  })

  it('/whatsapp/broadcasts/[id] → /communications/sent/whatsapp/[id]', async () => {
    await expect(run(WaBroadcastRedirect, { id: 'b1' }))
      .rejects.toThrow('NEXT_REDIRECT:/communications/sent/whatsapp/b1')
  })

  it('/communications/sms/broadcasts/[id] → /communications/sent/sms/[id]', async () => {
    await expect(run(SmsBroadcastRedirect, { id: 's1' }))
      .rejects.toThrow('NEXT_REDIRECT:/communications/sent/sms/s1')
  })
})

describe('the orphan composer redirects instead of 404ing (COMMS-IA.2)', () => {
  it('/email/campaigns/new → /communications/send', async () => {
    await expect(run(EmailCampaignNewRedirect, {}))
      .rejects.toThrow('NEXT_REDIRECT:/communications/send')
  })
})
