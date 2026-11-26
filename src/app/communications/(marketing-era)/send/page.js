// PILLAR2 Phase 1 — the unified "send a message off the cuff" surface.
// Audience-first. WhatsApp only since QUICKEMAIL-RETIRE.1 (email: /communications/new-email;
// SMS retired in TWILIO-RETIRE.1).
// A facade over the existing broadcast records + send routes — see
// UnifiedSendComposer + docs/PILLAR2_UNIFIED_SEND_2026-06.md.
import { getCurrentUser } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import { createServerClient } from '@/lib/supabase'
import { redirect } from 'next/navigation'
import UnifiedSendComposer from '@/components/communications/UnifiedSendComposer'
import { zoneOfLocation } from '@/lib/location-time'

export const dynamic = 'force-dynamic'

export default async function SendPage(props) {
  const searchParams = await props.searchParams
  const user = await getCurrentUser()
  if (!user) redirect('/login')

  // QUICKEMAIL-RETIRE.1 — WhatsApp only. Email is written in the full editor,
  // so an email-only holder is sent to /communications/new-email, carrying a
  // Segments deep link with them.
  const canEmail = hasPermission(user, 'email')
  if (!hasPermission(user, 'whatsapp')) {
    if (!canEmail) redirect('/communications')
    const qs = new URLSearchParams()
    if (typeof searchParams?.segment === 'string') qs.set('segment', searchParams.segment)
    if (typeof searchParams?.segment_id === 'string') qs.set('segment_id', searchParams.segment_id)
    const q = qs.toString()
    redirect(`/communications/new-email${q ? `?${q}` : ''}`)
  }

  const locationId = user.activeLocation?.id
  if (!locationId) redirect('/communications')

  // Approved WhatsApp templates for the picker (server-side — no client fetch).
  const db = createServerClient()
  const { data } = await db.from('whatsapp_templates')
    .select('id, name, language, category, components, status, quality_rating, display_group')
    .eq('location_id', locationId)
    .eq('status', 'APPROVED')
    .order('name')
  const templates = data || []

  // ?segment=<tag> deep-link (from SegmentsGrid) — pre-seed the audience with
  // that tag clause (same shape /email/campaigns/new uses).
  const seg = searchParams?.segment
  const initialAudienceFilter = seg
    ? { logic: 'and', filters: [{ field: 'tag', op: 'eq', value: String(seg) }] }
    : null

  // SEGPICK.1 — ?segment_id=<uuid> deep-link (from the Saved segments cards on
  // /communications/segments). A DIFFERENT thing from ?segment=<tag> above:
  // this applies a whole saved contact_segments filter, the tag form seeds one
  // clause. Resolved client-side against the location-scoped
  // GET /api/contacts/segments the composer already fetches, so a foreign id
  // resolves to nothing rather than leaking a filter across locations.
  const initialSegmentId = searchParams?.segment_id ? String(searchParams.segment_id) : null

  return (
    <div>
      <div className="mb-5">
        <h1 className="text-xl font-semibold text-un1t-text">Send a WhatsApp</h1>
        <p className="text-sm text-un1t-subtle">Pick who, write once, send now or schedule.</p>
      </div>
      <UnifiedSendComposer locationId={locationId} locationTimeZone={zoneOfLocation(user.activeLocation)} canEmail={canEmail} templates={templates} initialAudienceFilter={initialAudienceFilter} initialSegmentId={initialSegmentId} />
    </div>
  )
}
