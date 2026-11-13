// MCPEMAIL.2 — the email templates Claude may see and use. `email_templates`
// holds marketing designs AND the booking/event confirmations and reminders
// the CRM sends on its own; only the marketing ones are offered. A template
// is withheld when its category is transactional/reminder, or when an event
// type (confirmation, per-reminder) or a race event (confirmation, reminder)
// at the studio points at it. A failed read of any of those links throws:
// never list templates on a guess about what is linked.

export const EXCLUDED_TEMPLATE_CATEGORIES = ['transactional', 'reminder']

const TEMPLATE_CAP = 50
const PAGE = 1000
const IN_CHUNK = 200

// Every row of a query, paged under PostgREST's 1,000-row cap (ordered by id).
async function allRows(build) {
  const out = []
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await build().order('id').range(from, from + PAGE - 1)
    if (error) throw new Error(`Failed to read linked email templates: ${error.message}`)
    const rows = data || []
    out.push(...rows)
    if (rows.length < PAGE) return out
  }
}

/** Every template id a confirmation or reminder column at the studio references. */
export async function usedTemplateIds(db, locationId) {
  const used = new Set()
  const add = (v) => { if (v) used.add(v) }

  const eventTypes = await allRows(() => db.from('event_types')
    .select('id, confirmation_email_template_id').eq('location_id', locationId))
  for (const r of eventTypes) add(r.confirmation_email_template_id)

  // event_type_reminders has no location_id: scope it by the studio's event types.
  const ids = eventTypes.map((r) => r.id)
  for (let i = 0; i < ids.length; i += IN_CHUNK) {
    const chunk = ids.slice(i, i + IN_CHUNK)
    const rows = await allRows(() => db.from('event_type_reminders')
      .select('id, email_template_id').in('event_type_id', chunk))
    for (const r of rows) add(r.email_template_id)
  }

  const races = await allRows(() => db.from('race_events')
    .select('id, confirmation_email_template_id, reminder_email_template_id').eq('location_id', locationId))
  for (const r of races) { add(r.confirmation_email_template_id); add(r.reminder_email_template_id) }

  return used
}

const isExcludedCategory = (c) => EXCLUDED_TEMPLATE_CATEGORIES.includes(c)

/** The studio's marketing templates, by name, at most 50. */
export async function listMarketingTemplates(db, locationId) {
  const used = await usedTemplateIds(db, locationId)
  const rows = await allRows(() => db.from('email_templates')
    .select('id, name, subject, category, description').eq('location_id', locationId))
  return rows
    .filter((t) => !isExcludedCategory(t.category) && !used.has(t.id))
    .sort((a, b) => String(a.name).localeCompare(String(b.name)) || String(a.id).localeCompare(String(b.id)))
    .slice(0, TEMPLATE_CAP)
    .map((t) => ({ id: t.id, name: t.name, subject: t.subject ?? null, category: t.category ?? null, description: t.description ?? null }))
}

/** One marketing template at the studio, or null (other studio, excluded, or linked). */
export async function loadMarketingTemplate(db, locationId, templateId) {
  const { data, error } = await db.from('email_templates')
    .select('id, name, subject, category, html_content, design_json')
    .eq('id', templateId).eq('location_id', locationId).maybeSingle()
  if (error) throw new Error(`Failed to load the email template: ${error.message}`)
  if (!data || isExcludedCategory(data.category)) return null
  const used = await usedTemplateIds(db, locationId)
  if (used.has(data.id)) return null
  return { id: data.id, name: data.name, subject: data.subject ?? null, html_content: data.html_content ?? '', design_json: data.design_json ?? null }
}
