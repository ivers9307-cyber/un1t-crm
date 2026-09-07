// HOST-EMAIL.4 — shared validation for host campaign drafts (POST create +
// PATCH update). Lives outside the route files because Next route modules
// may only export HTTP methods.

// HOST-SCHEDULE.1 — one row shape for every host-campaign list/create/
// schedule response. Typed once here (route modules may only export
// handlers) and reused by the emails list route (GET + POST) and the
// schedule/unschedule routes, so a column added to one response is added
// to all of them.
export const HOST_CAMPAIGN_LIST_COLUMNS = 'id, subject, status, audience_kind, audience_event_id, audience_campaign_id, email_type, recipient_count, sent_count, created_at, sent_at, scheduled_for, schedule_error'

// The design document is host-authored JSON we store verbatim — cap its
// serialized size so a hostile client can't balloon the row.
export function designJsonTooBig(designJson) {
  if (designJson == null) return false
  try { return JSON.stringify(designJson).length > 500000 } catch { return true }
}

// The audience event must be one of THIS host's events (404-shaped error
// keeps ids unenumerable). A read error is a distinct failure — the caller
// (PATCH) maps any non-null string here to a 404, so a query that actually
// failed (not "no rows") must NOT read as "no such event"; keep the string
// contract but make its text distinguishable ('Could not check the event.')
// rather than silently swallowing `error` and reporting 'Event not found'.
export async function assertAudienceEventOwned(db, hostId, audienceEventId) {
  if (!audienceEventId) return null
  const { data, error } = await db
    .from('race_events')
    .select('id')
    .eq('id', audienceEventId)
    .eq('host_id', hostId)
    .maybeSingle()
  if (error) return 'Could not check the event.'
  return data ? null : 'Event not found'
}

/** HOST-EMAILS.2 — subject for a copied/reminder draft, capped at the column's 200. */
export function copySubject(subject, prefix = 'Copy of ') {
  return (prefix + (subject || '')).slice(0, 200)
}
