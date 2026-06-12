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
