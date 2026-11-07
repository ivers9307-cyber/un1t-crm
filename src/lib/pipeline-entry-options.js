// PIPEBUILD.5f — the values the board builder offers for an offer board's
// entry rule, at one studio. Pickers, not validators: the entry rule itself is
// checked by parseOfferConfig (shared/pipelines/offer-config.js), which also
// accepts a value typed by hand.
//
//   trial_purchase  match plan_code     distinct trial_purchases.plan_code at
//                                       the studio, plus every landing page
//                                       offer's plan_code for the studio
//                   match landing_path  distinct trial_purchases.landing_path
//                   match page_id       the organisation's landing pages that
//                                       have a studio row for this studio
//   corp_promo      CORP_PROMOS (the registry is keyed by public path, not by
//                   studio, so no studio filter; the hint names its studio)
//   lead_source     leadSourceSchema's values
//   glofox_plan     active glofox_memberships names at the studio
//   tag             the studio's tag vocabulary, from the same helper as
//                   /api/segments (studio-tag-vocabulary.js)
//
// Service role: the route has judged access to the studio, and every query
// here is scoped to it (location_id, or the studio's organisation for
// landing_pages). Answers { ok: true, options: [{ value, label, hint? }] } |
// { ok: false, status, error, code? }.
import { ENTRY_TYPES, TRIAL_MATCHES } from '@shared/pipelines/offer-config.js'
import { CORP_PROMOS } from '@/lib/corp-promos'
import { leadSourceSchema } from '@/lib/schemas'
import { selectAll } from '@/lib/select-all'
import { studioTagVocabulary } from '@/lib/studio-tag-vocabulary'
import { logError } from '@/lib/log'

const MODULE = 'pipeline-entry-options'
const PAGE = 1000
// trial_purchases at one studio: a runaway guard on the distinct scan, not a
// target (a studio sells hundreds of trials a year).
const TRIAL_SCAN_CAP = 20000

const fail = (status, error, code) => (code ? { ok: false, status, error, code } : { ok: false, status, error })
const unreadable = (what, err, meta) => {
  logError(MODULE, `${what} read failed`, { ...meta, err: err?.message || String(err) })
  return fail(503, `Could not read ${what} just now. Try again.`)
}
const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v)
const text = (v) => (typeof v === 'string' ? v.trim() : '')

// Every trial purchase at the studio, paged (selectAll: ordered by id).
async function trialPurchaseRows(db, locationId, columns) {
  return selectAll((from, to) => db
    .from('trial_purchases')
    .select(columns)
    .eq('location_id', locationId)
    .order('id', { ascending: true })
    .range(from, to), { hardCap: TRIAL_SCAN_CAP })
}

// The landing_page_studios rows for this studio. Capped at one page: a studio
// sits on a handful of pages (one studio page plus campaigns), nowhere near
// 1000.
async function studioPageRows(db, locationId) {
  const { data, error } = await db
    .from('landing_page_studios')
    .select('page_id, enabled, offer')
    .eq('location_id', locationId)
    .order('page_id', { ascending: true })
    .range(0, PAGE - 1)
  if (error) return { ok: false, error }
  return { ok: true, rows: data || [] }
}

function addOption(map, value, label, hint) {
  const v = text(value)
  if (!v || map.has(v)) return
  map.set(v, hint ? { value: v, label: text(label) || v, hint } : { value: v, label: text(label) || v })
}

const byLabel = (a, b) => a.label.localeCompare(b.label)

async function planCodeOptions(db, locationId) {
  let rows
  try {
    rows = await trialPurchaseRows(db, locationId, 'id, plan_code, product_name')
  } catch (err) {
    return unreadable('the trial purchases', err, { locationId })
  }
  const pages = await studioPageRows(db, locationId)
  if (!pages.ok) return unreadable("the studio's landing pages", pages.error, { locationId })
  const map = new Map()
  for (const r of rows) addOption(map, r.plan_code, r.plan_code, text(r.product_name) || undefined)
  for (const p of pages.rows) {
    const code = isObj(p.offer) ? p.offer.plan_code : null
    addOption(map, code, code, 'On a landing page')
  }
  return { ok: true, options: [...map.values()].sort(byLabel) }
}

async function landingPathOptions(db, locationId) {
  let rows
  try {
    rows = await trialPurchaseRows(db, locationId, 'id, landing_path')
  } catch (err) {
    return unreadable('the trial purchases', err, { locationId })
  }
  const map = new Map()
  for (const r of rows) addOption(map, r.landing_path, r.landing_path)
  return { ok: true, options: [...map.values()].sort(byLabel) }
}

async function pageIdOptions(db, locationId) {
  const { data: loc, error: locErr } = await db
    .from('locations')
    .select('organization_id')
    .eq('id', locationId)
    .maybeSingle()                         // primary key
  if (locErr) return unreadable('the studio', locErr, { locationId })
  if (!loc?.organization_id) return { ok: true, options: [] }

  const pages = await studioPageRows(db, locationId)
  if (!pages.ok) return unreadable("the studio's landing pages", pages.error, { locationId })
  const enabledById = new Map(pages.rows.map((p) => [p.page_id, p.enabled === true]))
  if (enabledById.size === 0) return { ok: true, options: [] }

  // Capped at one page for the same reason as studioPageRows; the in-list is
  // that page's ids, and the organisation filter keeps another tenant's page
  // out even if a studio row ever pointed across organisations.
  const { data, error } = await db
    .from('landing_pages')
    .select('id, slug, title')
    .eq('organization_id', loc.organization_id)
    .in('id', [...enabledById.keys()])
    .order('title', { ascending: true })
    .range(0, PAGE - 1)
  if (error) return unreadable('the landing pages', error, { locationId })
  const options = (data || []).map((p) => ({
    value: p.id,
    label: text(p.title) || `/${p.slug}`,
    hint: enabledById.get(p.id) ? `/${p.slug}` : `/${p.slug} (switched off at this studio)`,
  }))
  return { ok: true, options }
}

function corpPromoOptions() {
  const options = Object.values(CORP_PROMOS).map((p) => ({
    value: p.key,
    label: p.name,
    hint: p.live ? p.studio : `${p.studio} (not live)`,
  }))
  return { ok: true, options }
}

function leadSourceOptions() {
  return { ok: true, options: leadSourceSchema.options.map((v) => ({ value: v, label: v })) }
}

async function glofoxPlanOptions(db, locationId) {
  // One studio's Glofox catalogue is tens of memberships; one page is plenty.
  const { data, error } = await db
    .from('glofox_memberships')
    .select('glofox_membership_id, name')
    .eq('location_id', locationId)
    .eq('active', true)
    .order('name', { ascending: true })
    .range(0, PAGE - 1)
  if (error) return unreadable('the Glofox memberships', error, { locationId })
  const map = new Map()
  for (const m of data || []) addOption(map, m.name, m.name)
  return { ok: true, options: [...map.values()].sort(byLabel) }
}

async function tagOptions(db, locationId) {
  let vocabulary
  try {
    vocabulary = await studioTagVocabulary(db, locationId)
  } catch (err) {
    return unreadable("the studio's tags", err, { locationId })
  }
  return {
    ok: true,
    options: vocabulary.map((t) => (t.description
      ? { value: t.tag, label: t.tag, hint: t.description }
      : { value: t.tag, label: t.tag })),
  }
}

/**
 * @param {object} db service-role client
 * @param {{ locationId: string, type: string, match?: string }} opts
 */
export async function listEntryOptions(db, { locationId, type, match } = {}) {
  if (!locationId) return fail(400, 'A studio is required.')
  if (!ENTRY_TYPES.includes(type)) return fail(400, `type must be one of ${ENTRY_TYPES.join(', ')}`, 'unknown_type')
  switch (type) {
    case 'trial_purchase':
      if (match === 'plan_code') return planCodeOptions(db, locationId)
      if (match === 'landing_path') return landingPathOptions(db, locationId)
      if (match === 'page_id') return pageIdOptions(db, locationId)
      return fail(400, `match must be one of ${TRIAL_MATCHES.join(', ')} for trial_purchase`, 'unknown_match')
    case 'corp_promo':
      return corpPromoOptions()
    case 'lead_source':
      return leadSourceOptions()
    case 'glofox_plan':
      return glofoxPlanOptions(db, locationId)
    case 'tag':
      return tagOptions(db, locationId)
    default:
      return fail(400, 'Unknown type.', 'unknown_type')
  }
}
