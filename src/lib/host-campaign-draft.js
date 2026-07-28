// HOST-EMAIL.4 — shared validation for host campaign drafts (POST create +
// PATCH update). Lives outside the route files because Next route modules
// may only export HTTP methods.

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
