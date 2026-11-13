import { describe, it, expect } from 'vitest'
import {
  EXCLUDED_TEMPLATE_CATEGORIES, usedTemplateIds, listMarketingTemplates, loadMarketingTemplate,
} from './email-templates-for-agents.js'

const LOC = 'loc-1'

// tables: { table: { rows: [...] | error } }; supports eq/in/not/order/range/limit/maybeSingle.
function makeDb(tables) {
  const calls = []
  return {
    calls,
    from(table) {
      const q = { table, filters: [], range: null, limit: null }
      calls.push(q)
      const def = tables[table] ?? { rows: [] }
      const run = () => {
        if (def.error) return { data: null, error: { message: def.error } }
        let rows = def.rows.filter((r) => q.filters.every(([k, op, v]) => (op === 'eq' ? r[k] === v : op === 'in' ? v.includes(r[k]) : r[k] != null)))
        if (q.range) rows = rows.slice(q.range[0], q.range[1] + 1)
        if (q.limit != null) rows = rows.slice(0, q.limit)
        return { data: rows, error: null }
      }
      const b = {
        select: () => b,
        eq: (k, v) => { q.filters.push([k, 'eq', v]); return b },
        in: (k, v) => { q.filters.push([k, 'in', v]); return b },
        not: (k) => { q.filters.push([k, 'notnull']); return b },
        order: () => b,
        range: (a, z) => { q.range = [a, z]; return b },
        limit: (n) => { q.limit = n; return b },
        maybeSingle: async () => { const r = run(); return { data: r.data?.[0] ?? null, error: r.error } },
        then: (res, rej) => Promise.resolve(run()).then(res, rej),
      }
      return b
    },
  }
}

const T = (id, name, category = 'marketing', extra = {}) => ({
  id, location_id: LOC, name, subject: `${name} subject`, category, description: null,
  html_content: '<p>Hi {{first_name}}</p>', design_json: { a: 1 }, ...extra,
})

function fixture(over = {}) {
  return {
    email_templates: { rows: [
      T('t-promo', 'Promo'), T('t-news', 'Newsletter', null),
      T('t-trans', 'Booking confirmed', 'transactional'), T('t-rem', 'Reminder', 'reminder'),
      T('t-conf', 'Event confirmation'), T('t-evrem', 'Event reminder'), T('t-race', 'Race confirmation'),
      T('t-other', 'Other studio', 'marketing', { location_id: 'loc-2' }),
    ] },
    event_types: { rows: [{ id: 'et1', location_id: LOC, confirmation_email_template_id: 't-conf' }] },
    event_type_reminders: { rows: [{ event_type_id: 'et1', email_template_id: 't-evrem' }] },
    race_events: { rows: [{ id: 'r1', location_id: LOC, confirmation_email_template_id: 't-race', reminder_email_template_id: null }] },
    ...over,
  }
}

describe('email-templates-for-agents', () => {
  it('excludes the transactional and reminder categories', () => {
    expect(EXCLUDED_TEMPLATE_CATEGORIES).toEqual(['transactional', 'reminder'])
  })

  it('lists the studio\'s templates without transactional, reminder or confirmation/reminder-linked ones', async () => {
    const out = await listMarketingTemplates(makeDb(fixture()), LOC)
    expect(out.map((t) => t.id)).toEqual(['t-news', 't-promo'])
    expect(Object.keys(out[0]).sort()).toEqual(['category', 'description', 'id', 'name', 'subject'])
  })

  it('refuses by id a template an event type uses as its reminder', async () => {
    const db = makeDb(fixture())
    expect(await loadMarketingTemplate(db, LOC, 't-evrem')).toBeNull()
    expect(await loadMarketingTemplate(db, LOC, 't-conf')).toBeNull()
    expect(await loadMarketingTemplate(db, LOC, 't-race')).toBeNull()
    expect(await loadMarketingTemplate(db, LOC, 't-trans')).toBeNull()
    expect(await loadMarketingTemplate(db, LOC, 't-other')).toBeNull()
    expect(await loadMarketingTemplate(db, LOC, 't-promo')).toMatchObject({ id: 't-promo', html_content: '<p>Hi {{first_name}}</p>', design_json: { a: 1 } })
  })

  it('throws when the linked-template read fails, never listing everything', async () => {
    for (const table of ['event_types', 'event_type_reminders', 'race_events']) {
      const db = makeDb(fixture({ [table]: { error: 'boom' } }))
      await expect(listMarketingTemplates(db, LOC)).rejects.toThrow(/boom/)
      await expect(loadMarketingTemplate(db, LOC, 't-promo')).rejects.toThrow(/boom/)
    }
    await expect(usedTemplateIds(makeDb(fixture({ race_events: { error: 'x' } })), LOC)).rejects.toThrow()
  })

  it('collects every linked id', async () => {
    const used = await usedTemplateIds(makeDb(fixture()), LOC)
    expect([...used].sort()).toEqual(['t-conf', 't-evrem', 't-race'])
  })
})
