// AUDIENCEVIEWCOLS.1 guard (mig 689). contact_location_audience is the
// send-path read surface: every campaign, sequence and WhatsApp broadcast
// audience is built on it (src/lib/audience-eligibility.js). Mig 491 created
// it with c.*, which Postgres expands ONCE, at creation, so contacts columns
// added later never reached it, and the "Last email open/click" audience
// filters failed at send (42703) until mig 689. Pinned here, against the
// migration replay check:select-columns uses (scripts/check-select-columns.mjs):
//
//  (a) every contacts column is a column of the view, unless it is listed in
//      AUDIENCE_VIEW_EXCLUDED with a reason and an expiry. A migration that
//      adds a contacts column must, in the same PR, append it to the view
//      (CREATE OR REPLACE VIEW … WITH (security_invoker = on), columns
//      appended at the END, then REVOKE ALL … FROM anon, authenticated,
//      PUBLIC — the mig 689 shape), or exclude it here;
//  (b) every non-virtual AUDIENCE_FIELDS key is a column of the view (the
//      check that would have caught the original bug);
//  (c) the exclusion list is honest: real contacts columns, not audience
//      fields, not expired.
//
// A floor, not a proof: the replay skips what it cannot parse (it would then
// report the view as skipped, which fails the "not vacuous" test), and it is
// not prod: Task 5 of the C65 plan checks prod directly.

import { describe, it, expect } from 'vitest'
import path from 'node:path'
import { collectSchema, applyMigrationSql } from '../scripts/check-select-columns.mjs'
import { AUDIENCE_FIELDS } from '../src/lib/audience-filter.js'

const ROOT = path.resolve(import.meta.dirname, '..')
const MIGRATIONS = path.join(ROOT, 'supabase/migrations')
const VIEW = 'contact_location_audience'
const CLP_COLS = ['audience_location_id', 'loc_email_marketing', 'loc_sms_marketing', 'loc_whatsapp_marketing']
const VIRTUAL_TYPES = new Set(['tag', 'event', 'location_list'])

/**
 * contacts columns deliberately NOT on the view: column → { why, expires }
 * (YYYY-MM-DD). Empty on purpose since mig 689. An entry is a decision that a
 * send path must never filter on or receive this column; say why.
 */
export const AUDIENCE_VIEW_EXCLUDED = Object.freeze({})

/** contacts columns the replayed view lacks, minus the exclusions. */
export function missingFromView(schema, excluded = AUDIENCE_VIEW_EXCLUDED) {
  const contacts = schema.get('contacts') || new Set()
  const view = schema.get(VIEW) || new Set()
  return [...contacts].filter((c) => !view.has(c) && !Object.hasOwn(excluded, c))
}

/** AUDIENCE_FIELDS keys that must be real view columns but are not. */
export function audienceFieldsMissing(schema, fields = AUDIENCE_FIELDS) {
  const view = schema.get(VIEW) || new Set()
  return Object.entries(fields)
    .filter(([, cfg]) => !VIRTUAL_TYPES.has(cfg.type))
    .map(([k]) => k)
    .filter((k) => !view.has(k))
}

describe('contact_location_audience carries every contacts column (AUDIENCEVIEWCOLS.1, mig 689)', () => {
  const { schema, skippedViews } = collectSchema(MIGRATIONS)

  it('the replay resolves contacts and the view (not vacuous)', () => {
    expect(schema.has('contacts')).toBe(true)
    expect(skippedViews.has(VIEW)).toBe(false)
    expect(schema.has(VIEW)).toBe(true)
    for (const c of CLP_COLS) expect(schema.get(VIEW).has(c)).toBe(true)
    expect(schema.get('contacts').size).toBeGreaterThan(100)
  })

  it('(a) no contacts column is missing from the view', () => {
    expect(missingFromView(schema),
      'append the column to contact_location_audience in a migration (the mig 689 shape), or list it in AUDIENCE_VIEW_EXCLUDED with a reason').toEqual([])
  })

  it('(b) every non-virtual audience field is a view column', () => {
    expect(audienceFieldsMissing(schema),
      'the send path filters these on contact_location_audience; add them to the view').toEqual([])
  })

  it('(c) exclusions are real contacts columns, not audience fields, with a reason and a live expiry', () => {
    const today = new Date().toISOString().slice(0, 10)
    for (const [col, e] of Object.entries(AUDIENCE_VIEW_EXCLUDED)) {
      expect(schema.get('contacts').has(col), `${col} is not a contacts column`).toBe(true)
      expect(Object.hasOwn(AUDIENCE_FIELDS, col), `${col} is an audience field; it cannot be excluded`).toBe(false)
      expect(typeof e.why === 'string' && e.why.length > 10, `${col} needs a reason`).toBe(true)
      expect(/^\d{4}-\d{2}-\d{2}$/.test(e.expires) && e.expires >= today, `${col} exclusion expired`).toBe(true)
    }
  })
})

describe('the detector bites', () => {
  const base = () => {
    const s = new Map([['contacts', new Set(['id', 'location_id', 'email'])],
      ['contact_location_preferences', new Set(['contact_id', 'location_id', 'email_marketing', 'sms_marketing', 'whatsapp_marketing'])]])
    applyMigrationSql(`CREATE VIEW public.contact_location_audience WITH (security_invoker = on) AS
      SELECT c.id, c.location_id, c.email, clp.location_id AS audience_location_id
        FROM public.contacts c JOIN public.contact_location_preferences clp ON clp.contact_id = c.id;`, s)
    return s
  }

  it('a new contacts column without a view change is reported', () => {
    const s = base()
    applyMigrationSql('ALTER TABLE public.contacts ADD COLUMN synth_new_col text;', s)
    expect(missingFromView(s, {})).toEqual(['synth_new_col'])
  })

  it('appending it with CREATE OR REPLACE clears it; an exclusion clears it too', () => {
    const s = base()
    applyMigrationSql('ALTER TABLE public.contacts ADD COLUMN synth_new_col text;', s)
    expect(missingFromView(s, { synth_new_col: { why: 'synthetic test entry', expires: '2999-01-01' } })).toEqual([])
    applyMigrationSql(`CREATE OR REPLACE VIEW public.contact_location_audience WITH (security_invoker = on) AS
      SELECT c.id, c.location_id, c.email, clp.location_id AS audience_location_id, c.synth_new_col
        FROM public.contacts c JOIN public.contact_location_preferences clp ON clp.contact_id = c.id;`, s)
    expect(missingFromView(s, {})).toEqual([])
  })

  it('an audience field the view lacks is reported; virtual fields are not', () => {
    const s = base()
    expect(audienceFieldsMissing(s, {
      email: { type: 'text' }, last_email_open_at: { type: 'date' }, tag: { type: 'tag' }, location_list: { type: 'location_list' },
    })).toEqual(['last_email_open_at'])
  })
})
