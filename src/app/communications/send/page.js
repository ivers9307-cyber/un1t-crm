// PILLAR2 Phase 1 — the unified "send a message off the cuff" surface.
// Audience-first, channel-aware (SMS + WhatsApp; email joins in Phase 2).
// A facade over the existing broadcast records + send routes — see
// UnifiedSendComposer + docs/PILLAR2_UNIFIED_SEND_2026-06.md.
import { getCurrentUser } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import { createServerClient } from '@/lib/supabase'
import { redirect } from 'next/navigation'
import Link from 'next/link'
import UnifiedSendComposer from '@/components/communications/UnifiedSendComposer'

export const dynamic = 'force-dynamic'

export default async function SendPage(props) {
  const searchParams = await props.searchParams
  const user = await getCurrentUser()
  if (!user) redirect('/login')

  const channels = []
  if (hasPermission(user, 'sms')) channels.push('sms')
  if (hasPermission(user, 'whatsapp')) channels.push('whatsapp')
  if (hasPermission(user, 'email')) channels.push('email')
  if (channels.length === 0) redirect('/communications')

  const locationId = user.activeLocation?.id
  if (!locationId) redirect('/communications')

  // Approved WhatsApp templates for the picker (server-side — no client fetch).
  let templates = []
  if (channels.includes('whatsapp')) {
    const db = createServerClient()
    const { data } = await db.from('whatsapp_templates')
      .select('id, name, language, category, components, status, quality_rating')
      .eq('location_id', locationId)
      .eq('status', 'APPROVED')
      .order('name')
    templates = data || []
  }

  // ?segment=<tag> deep-link (from SegmentsGrid) — pre-seed the audience with
  // that tag clause (same shape /email/campaigns/new uses).
  const seg = searchParams?.segment
  const initialAudienceFilter = seg
    ? { logic: 'and', filters: [{ field: 'tag', op: 'eq', value: String(seg) }] }
    : null

  return (
    <div>
      <div className="mb-5">
        <Link href="/communications" className="text-xs text-un1t-subtle hover:text-un1t-text">← Communications</Link>
        <h1 className="text-xl font-semibold text-un1t-text mt-1">Send a message</h1>
        <p className="text-sm text-un1t-subtle">Pick who, write once, send now{(channels.includes('sms') || channels.includes('email')) ? ' or schedule' : ''}.</p>
      </div>
      <UnifiedSendComposer locationId={locationId} channels={channels} templates={templates} initialAudienceFilter={initialAudienceFilter} />
    </div>
  )
}
