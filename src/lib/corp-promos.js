// CORPPROMO.1 — the /corp corporate promos. WAYSIN.2: the definitions live in
// public.corp_promos (mig 816), one row per studio and key; this module reads
// them and keeps the words.
//
// A promo is a definition, not a page: the studio it runs at, the credits it
// puts on the person's account and how long they last. The page and the claim
// route only ever pick from the studio's own rows, so a visitor can never ask
// for another amount or studio. The words a visitor reads live on a
// `corp_promo` block of the studio's landing row (edited at
// /settings/landing-page), each blank field on the default below.
//
// platform 'un1t_online' grants credits through grantPromoCredits
// (src/lib/un1t-online-write-ops.js); platform 'glofox' buys the row's Glofox
// plan (glofox_membership_id / glofox_plan_code / glofox_plan_name).
//
// The readers take a service-role client and are scoped by location_id. A
// failed read is { ok: false, error }, never "no promos": the caller judges it.

/** @typedef {{ membershipId: string, planCode: string, planName: string | null }} CorpPromoGlofoxPlan */
/** @typedef {{ key: string, name: string, platform: 'un1t_online'|'glofox', studio: 'hatch'|'stillorgan', publicPath: string, credits: number, expiresInDays: number, tag: string, leadSource: string, live: boolean, glofox: CorpPromoGlofoxPlan | null }} CorpPromoSeed */
/** @typedef {{ id: string, locationId: string, key: string, name: string, platform: 'un1t_online'|'glofox', credits: number, expiresInDays: number, live: boolean, tag: string, leadSource: string, glofox: CorpPromoGlofoxPlan | null }} CorpPromoRow */

/**
 * The seed of mig 816; the table is the truth. Kept in code only for the
 * readers that still resolve synchronously until WAYSIN.3/.4 move them to the
 * table (the claim route, the public page, the landing editor's promo picker)
 * and for the migration guard that pins the seed.
 * @type {Readonly<Record<string, CorpPromoSeed>>}
 */
export const CORP_PROMO_SEEDS = Object.freeze({
  // Richard, 28 Oct 2026: 3 free classes at Hatch Street, credits for 7 days,
  // anyone with the link who has never trained at Hatch.
  'hatch-3-free': Object.freeze({
    key: 'hatch-3-free',
    name: 'Corporate trial (Hatch Street)',
    platform: 'un1t_online',
    studio: 'hatch',
    publicPath: 'hatch-street',
    credits: 3,
    expiresInDays: 7,
    tag: 'hatch-corp-promo',
    leadSource: 'corp_promo',
    live: true,
    glofox: null,
  }),
  // NEWSTART.1: Stillorgan is a Glofox studio. The plan was created in Glofox
  // by Richard, 5 Nov 2026 ("New Start Free Trial", €0), bought by id.
  'stillorgan-newstart': Object.freeze({
    key: 'stillorgan-newstart',
    name: 'New Start (Stillorgan)',
    platform: 'glofox',
    studio: 'stillorgan',
    publicPath: 'stillorgan',
    credits: 3,
    expiresInDays: 7,
    tag: 'stillorgan-newstart',
    leadSource: 'corp_promo',
    live: true,
    glofox: Object.freeze({ membershipId: '6aec95d590a936f18c065d9f', planCode: '1793889679121', planName: 'New Start Free Trial' }),
  }),
})

/**
 * The SEED promo for `key`, or null when unknown. Synchronous, so it can only
 * know the seed: WAYSIN.3 moves its last callers (the claim route and the
 * public page) to readCorpPromo.
 */
export function resolveSeededCorpPromo(key) {
  if (typeof key !== 'string') return null
  return Object.hasOwn(CORP_PROMO_SEEDS, key) ? CORP_PROMO_SEEDS[key] : null
}

/** The live SEED promos, in seed order (the landing editor's picker until WAYSIN.4). */
export function liveSeededCorpPromos() {
  return Object.values(CORP_PROMO_SEEDS).filter((p) => p.live)
}

/** The live SEED promos at the studio whose public path is `publicPath` (until WAYSIN.4). */
export function seededCorpPromosForStudio(publicPath) {
  return liveSeededCorpPromos().filter((p) => p.publicPath === publicPath)
}

// Named columns: check:select-columns resolves them against mig 816.
export const CORP_PROMO_COLUMNS = 'id, location_id, key, name, platform, credits, expires_in_days, live, tag, lead_source, glofox_membership_id, glofox_plan_code, glofox_plan_name'
const READ_PAGE = 1000

const blank = (v) => typeof v !== 'string' || v.trim() === ''

/**
 * A corp_promos row with the camelCase accessors the fulfilment code reads
 * (promo.credits, promo.expiresInDays, promo.name, promo.key, promo.tag,
 * promo.leadSource). glofox is the plan binding, or null when its membership
 * id or plan code is blank.
 * @returns {CorpPromoRow | null}
 */
export function promoView(row) {
  if (!row || typeof row !== 'object') return null
  const glofox = blank(row.glofox_membership_id) || blank(row.glofox_plan_code)
    ? null
    : {
      membershipId: row.glofox_membership_id.trim(),
      planCode: row.glofox_plan_code.trim(),
      planName: blank(row.glofox_plan_name) ? null : row.glofox_plan_name.trim(),
    }
  return {
    id: row.id,
    locationId: row.location_id,
    key: row.key,
    name: row.name,
    platform: row.platform,
    credits: row.credits,
    expiresInDays: row.expires_in_days,
    live: row.live === true,
    tag: row.tag,
    leadSource: row.lead_source,
    glofox,
  }
}

const readError = (error) => ({ ok: false, error: error?.message || String(error || 'corp_promos read failed') })

/**
 * The studio's promo with `key`, or null when that studio has none by that key.
 * @returns {Promise<{ ok: true, promo: CorpPromoRow | null } | { ok: false, error: string }>}
 */
export async function readCorpPromo(db, { locationId, key } = {}) {
  if (!locationId) return { ok: false, error: 'location_required' }
  if (typeof key !== 'string' || key.trim() === '') return { ok: true, promo: null }
  try {
    // (location_id, key) is unique (corp_promos_location_key_unique): at most one row.
    const { data, error } = await db.from('corp_promos')
      .select(CORP_PROMO_COLUMNS)
      .eq('location_id', locationId)
      .eq('key', key)
      .maybeSingle()
    if (error) return readError(error)
    return { ok: true, promo: data ? promoView(data) : null }
  } catch (err) {
    return readError(err)
  }
}

/**
 * Every promo at the studio (only the live ones with liveOnly), ordered by key,
 * paged past the 1,000-row cap.
 * @returns {Promise<{ ok: true, promos: CorpPromoRow[] } | { ok: false, error: string }>}
 */
export async function listCorpPromos(db, { locationId, liveOnly = false } = {}) {
  if (!locationId) return { ok: false, error: 'location_required' }
  const promos = []
  try {
    for (let from = 0; ; from += READ_PAGE) {
      let q = db.from('corp_promos').select(CORP_PROMO_COLUMNS).eq('location_id', locationId)
      if (liveOnly) q = q.eq('live', true)
      const { data, error } = await q.order('key', { ascending: true }).range(from, from + READ_PAGE - 1)
      if (error) return readError(error)
      const rows = Array.isArray(data) ? data : []
      for (const r of rows) promos.push(promoView(r))
      if (rows.length < READ_PAGE) return { ok: true, promos }
    }
  } catch (err) {
    return readError(err)
  }
}

export const CORP_PROMO_COPY_DEFAULT = Object.freeze({
  // The big line at the top of the /corp card (and the browser tab).
  title: 'Exclusive Corporate Trial',
  // No eyebrow by default (Richard, 28 Oct 2026): the heading names the studio.
  eyebrow: '',
  heading: '3 free classes at {studio_name}',
  subhead: 'Coach-led strength and conditioning. Your first three classes are on us: claim them in under a minute and book in the app.',
  ticks: Object.freeze(['3 coach-led classes, free', 'Use them within 7 days', 'Book in the un1t.online app']),
  cta_label: 'Claim my 3 free classes',
  consent_label: "I'd like to hear from {studio_name} about my classes and offers by email, SMS and WhatsApp. I can opt out anytime.",
  done_title: "You're in 🎉",
  done_body: 'Your {credits} free classes are on your un1t.online account. Use them by {expires_on}. Check your email for how to log in and book.',
  trained_text: "It looks like you've trained with us at {studio_name} before, so this offer is for people new to the studio. If that's not right, reply to our email or ask at the front desk.",
  already_claimed_text: "You've already claimed this offer, so your free classes are on your un1t.online account. Book them in the app; if they're not there, reply to our email.",
  trial_used_text: "It looks like this email or mobile has already had a free trial with us, so the offer can't be claimed again. If that's not right, reply to our email or ask at the front desk.",
  active_member_text: "It looks like you're already a member at {studio_name}, so your classes are covered. If that's not right, ask at the front desk.",
  help_text: "Thanks, we've got your details. Something needs a quick check on our side, so the team will be in touch shortly to get your classes on your account.",
  unavailable_text: 'This offer is not available right now.',
  email_subject: 'Your {credits} free classes at {studio_name}',
  email_body: 'Hi {first_name}, your {credits} free classes at {studio_name} are on your un1t.online account. Use them by {expires_on}. If you are new to un1t.online, a code to set your password is on its way in a separate email; once you are in, book your classes in the app. Reply to this email if anything looks off.',
})

// NEWSTART.1: the words for a Glofox studio's promo. No un1t.online anywhere.
export const CORP_PROMO_GLOFOX_COPY_DEFAULT = Object.freeze({
  ...CORP_PROMO_COPY_DEFAULT,
  title: 'New Start at {studio_name}',
  eyebrow: '',
  heading: '3 free classes at {studio_name}',
  subhead: 'Coach-led strength and conditioning. Your first three classes are on us: pick your first class, claim in under a minute.',
  ticks: Object.freeze(['3 coach-led classes, free', 'Use them within 7 days of your first class', 'Book the rest in the UN1T app']),
  cta_label: 'Claim my 3 free classes',
  done_title: "You're in 🎉",
  done_body: 'Your {credits} free classes are on your account. Use them within 7 days of your first class. Check your email for how to log in to the UN1T app and book.',
  already_claimed_text: "You've already claimed this offer, so your free classes are on your account. Book them in the UN1T app; if they're not there, reply to our email.",
  active_member_text: "It looks like you're already a member at {studio_name}, so your classes are covered. If that's not right, ask at the front desk.",
  help_text: "Thanks, we've got your details. Something needs a quick check on our side, so the team will be in touch shortly to get your classes on your account.",
  unavailable_text: 'This offer is not available right now.',
  email_subject: 'Your {credits} free classes at {studio_name}',
  email_body: 'Hi {first_name}, your {credits} free classes at {studio_name} are on your account. Use them within 7 days of your first class. Log in to the UN1T app with this email (tap "Forgot password" if you have not set one) and book your classes there. Reply to this email if anything looks off.',
})

const str = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null)
const TEXT_FIELDS = Object.keys(CORP_PROMO_COPY_DEFAULT).filter((k) => k !== 'ticks')

/**
 * The words for `promoKey` off a studio's landing blocks: the corp_promo block
 * naming that promo, else the first corp_promo block with no promo key, every
 * blank or missing field on its default. Pure.
 */
export function corpPromoCopyFromBlocks(blocks, promoKey, { platform } = {}) {
  const defaults = platform === 'glofox' ? CORP_PROMO_GLOFOX_COPY_DEFAULT : CORP_PROMO_COPY_DEFAULT
  const list = (Array.isArray(blocks) ? blocks : []).filter((b) => b && typeof b === 'object' && b.type === 'corp_promo')
  const block = list.find((b) => str(b.promo_key) === promoKey) || list.find((b) => !str(b.promo_key)) || {}
  const out = {}
  for (const k of TEXT_FIELDS) out[k] = str(block[k]) || defaults[k]
  const ticks = Array.isArray(block.ticks) ? block.ticks.map(str).filter(Boolean) : []
  out.ticks = ticks.length > 0 ? ticks : [...defaults.ticks]
  return out
}

/** `{token}` replaced from `tokens`; an unknown token stays as written. Pure. */
export function fillCorpPromoTokens(text, tokens) {
  return String(text ?? '').replace(/\{(\w+)\}/g, (m, k) => (Object.hasOwn(tokens, k) && tokens[k] != null ? String(tokens[k]) : m))
}
