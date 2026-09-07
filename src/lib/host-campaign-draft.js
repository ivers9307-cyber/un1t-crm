// HOST-EMAIL.4 — shared validation for host campaign drafts (POST create +
// PATCH update). Lives outside the route files because Next route modules
// may only export HTTP methods.

// HOST-SCHEDULE.1 — one row shape for every host-campaign list/create/
// schedule response. Typed once here (route modules may only export
// handlers) and reused by the emails list route (GET + POST) and the
// schedule/unschedule routes, so a column added to one response is added
// to all of them.
export const HOST_CAMPAIGN_LIST_COLUMNS = 'id, subject, status, audience_kind, audience_event_id, email_type, recipient_count, sent_count, created_at, sent_at, scheduled_for, schedule_error'

// The design document is host-authored JSON we store verbatim — cap its
// serialized size so a hostile client can't balloon the row.
export function designJsonTooBig(designJson) {
  if (designJson == null) return false
  try { return JSON.stringify(designJson).length > 500000 } catch { return true }
}

// The audience event must be one of THIS host's events (404-shaped error
// keeps ids unenumerable).
export async function assertAudienceEventOwned(db, hostId, audienceEventId) {
  if (!audienceEventId) return null
  const { data } = await db
    .from('race_events')
    .select('id')
    .eq('id', audienceEventId)
    .eq('host_id', hostId)
    .maybeSingle()
  return data ? null : 'Event not found'
}
