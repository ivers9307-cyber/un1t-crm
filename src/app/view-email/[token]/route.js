// GET /view-email/[token] — WEBVIEW.1, the public hosted copy of a campaign.
//
// PUBLIC BY DESIGN, and public the way CLAUDE.md requires it:
//   1. It lives at the TOP LEVEL of src/app/, outside every auth-gated segment
//      (a layout auth gate runs before the leaf, so a public surface nested
//      under one is never actually public).
//   2. `/view-email/` is in the `publicPaths` allowlist in src/proxy.js.
//   3. `/view-email` is in `PUBLIC_PATHS` in src/components/AppShell.jsx.
// The third is the one that keeps getting missed (it is what LOCCOMMS.4 hit
// with /preferences), so it is listed here explicitly.
//
// A route handler rather than a page: what we serve is a complete HTML
// document authored in Unlayer, so it must not be wrapped in the app's layout,
// <head> or fonts. Returning it as text/html gives the recipient exactly what
// their mail client would have rendered.
//
// AUTHORISATION is the signed token and nothing else. It names one campaign,
// carries no contact, and cannot be forged without SUPABASE_SERVICE_ROLE_KEY.
// See src/lib/campaign-web-view.js for why it carries no contact.
//
// 404 for everything that is not a campaign that actually went out: a bad
// signature, an unknown id, and any campaign still in draft / scheduled /
// queued. Draft content has never been sent to anyone and must not be readable
// from an unauthenticated URL just because someone shared a preview link. All
// four cases return the same response, so the endpoint is not an oracle for
// which campaigns exist.

import { createServerClient } from '@/lib/supabase'
import { verifyCampaignViewToken, renderCampaignWebView } from '@/lib/campaign-web-view'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// Only a campaign that has actually been mailed has a hosted copy. 'sending'
// is included because the link is live in inboxes from the first chunk.
const VIEWABLE_STATUSES = ['sending', 'sent']

function notFound() {
  return new Response(
    '<!doctype html><meta charset="utf-8"><title>Not found</title><p>This link is not valid any more.</p>',
    { status: 404, headers: { 'content-type': 'text/html; charset=utf-8' } },
  )
}

export async function GET(_request, props) {
  const params = await props.params
  const claim = verifyCampaignViewToken(params?.token)
  if (!claim) return notFound()

  const db = createServerClient()
  // Tenant scoping is the token: it resolves to exactly one campaign id, which
  // is the row we read. There is nothing to filter by location because there
  // is no caller-supplied id to widen.
  const { data: campaign, error } = await db
    .from('campaigns')
    .select('id, status, html_content, subject, location_id, locations(name)')
    .eq('id', claim.campaignId)
    .single()

  if (error || !campaign) return notFound()
  if (!VIEWABLE_STATUSES.includes(campaign.status)) return notFound()

  const html = renderCampaignWebView(campaign)
  if (!html) return notFound()

  return new Response(html, {
    status: 200,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      // The hosted copy is identical for every recipient (no merge-tag data),
      // so it is safe to cache. Short, because CAMPHIST.1 still permits a
      // 'sending' campaign's row to change status underneath us.
      'cache-control': 'public, max-age=300',
      // Nothing here should be framed or sniffed, and the page must not leak
      // its own URL (which is a capability) to any asset host in the design.
      'x-content-type-options': 'nosniff',
      'x-frame-options': 'DENY',
      'referrer-policy': 'no-referrer',
    },
  })
}
