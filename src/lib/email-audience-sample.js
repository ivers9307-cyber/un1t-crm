// MCPEMAIL.2 — a masked sample of who an email audience would reach, for the
// staff MCP `sample_email_audience` tool. Same query path as the audience
// preview route (the send path's own eligibility builder), same masking, and a
// narrower row: first name, masked email, pipeline stage. Never an id or phone.
import { buildEligibleAudienceQuery } from '@/lib/audience-eligibility'
import { maskEmail, PREVIEW_COLUMNS, PREVIEW_MAX_PAGE_SIZE } from '@/lib/audience-preview'

function firstNameOf(row) {
  const first = String(row?.first_name ?? '').trim()
  if (first) return first
  const word = String(row?.name ?? '').trim().split(/\s+/)[0]
  return word || null
}

export async function emailAudienceSample(db, { filter, locationId, limit = PREVIEW_MAX_PAGE_SIZE }) {
  const size = Math.min(Math.max(Number(limit) || PREVIEW_MAX_PAGE_SIZE, 1), PREVIEW_MAX_PAGE_SIZE)
  const { query } = await buildEligibleAudienceQuery({
    db, channel: 'email', filter, locationId, columns: PREVIEW_COLUMNS,
  })
  // Deterministic order, as the preview route does.
  const { data, error } = await query.order('id', { ascending: true }).range(0, size - 1)
  if (error) throw new Error(`Failed to sample audience: ${error.message}`)
  return (data || []).map((r) => ({
    first_name: firstNameOf(r),
    email: maskEmail(r.email),
    stage: r.pipeline_stage_slug ?? null,
  }))
}
