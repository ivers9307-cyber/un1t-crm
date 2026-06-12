// KNOWLEDGE-IMPORT.1 — turn the Glofox timetable into agent knowledge.
//
// One entry per class TYPE (events dedupe by name), with the class
// description lifted from the event row (or its program_obj — both
// fields verified live on the Stillorgan tier, see fetchUpcomingEvents
// in glofox.js). Descriptions are member-facing copy already shown in
// the Glofox booking app, but often arrive as HTML — strip to plain
// text the agent can relay verbatim. Pure; the IO lives in the
// /api/agent/knowledge/import-classes route.

const MAX_CONTENT = 4000

/** Minimal HTML → text: strip tags, decode the common entities, collapse whitespace. */
function htmlToText(html) {
  return String(html || '')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Shape Glofox events into knowledge candidates: unique class names
 * with their description as plain text ('' when Glofox has none — an
 * empty draft the operator can fill; the prompt builder already
 * excludes empty-content entries from what the agent reads).
 *
 * @param {Array<{name?:string,description?:string,program_obj?:{description?:string}}>} events
 * @returns {Array<{title:string,content:string}>}
 */
export function shapeClassKnowledgeFromEvents(events) {
  const seen = new Set()
  const out = []
  for (const e of Array.isArray(events) ? events : []) {
    const title = String(e?.name || '').trim()
    if (!title) continue
    const key = title.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    const raw = e?.description || e?.program_obj?.description || ''
    out.push({ title, content: htmlToText(raw).slice(0, MAX_CONTENT) })
  }
  return out
}

/**
 * Run the import for one location: fetch the next two weeks of the
 * Glofox timetable, shape to one candidate per class type, insert
 * what's new. NEVER overwrites existing titles — operator edits win.
 * Returns { ok, imported, skipped, missing_description } (ok:false
 * carries a reason instead). Shared by the Knowledge "Import classes
 * from Glofox" button and the weekly sync-class-knowledge cron.
 */
export async function importClassKnowledge(db, locationId, { updatedBy = null } = {}) {
  const { glofoxCredentialsForLocation, fetchUpcomingEvents } = await import('@/lib/glofox')

  const creds = await glofoxCredentialsForLocation(db, locationId)
  if (!creds?.branchId || !creds?.apiKey || !creds?.apiToken) {
    return { ok: false, reason: 'glofox_not_connected' }
  }

  const now = Math.floor(Date.now() / 1000)
  const res = await fetchUpcomingEvents(creds, { start: now, end: now + 14 * 86400, limit: 200 })
  if (!res.ok) return { ok: false, reason: 'glofox_unreachable' }

  const candidates = shapeClassKnowledgeFromEvents(res.events)
  if (candidates.length === 0) {
    return { ok: true, imported: [], skipped: [], missing_description: [] }
  }

  const { data: existing } = await db.from('agent_knowledge')
    .select('title')
    .eq('location_id', locationId)
  const have = new Set((existing || []).map(r => String(r.title || '').trim().toLowerCase()))

  const fresh = candidates.filter(c => !have.has(c.title.toLowerCase()))
  const skipped = candidates.filter(c => have.has(c.title.toLowerCase())).map(c => c.title)

  let imported = []
  if (fresh.length > 0) {
    const { data, error } = await db.from('agent_knowledge')
      .insert(fresh.map(c => ({
        location_id: locationId,
        category: 'general',
        title: c.title,
        content: c.content,
        enabled: c.content.length > 0,
        sort_order: 0,
        updated_by: updatedBy,
      })))
      .select('id, category, title, content, enabled, sort_order, updated_at')
    if (error) return { ok: false, reason: error.message }
    imported = data || []
  }

  return { ok: true, imported, skipped, missing_description: fresh.filter(c => !c.content).map(c => c.title) }
}
