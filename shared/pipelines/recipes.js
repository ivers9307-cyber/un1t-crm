// PIPEBUILD.4c — board recipes and their follow-up packs. A recipe pre-fills an
// offer board's config; each pack is the WhatsApp wording plus the sequence graph
// for one stage. A later task installs packs; this file only describes and renders
// them. Pure, ESM, no IO, mobile-importable (shared/ must not import src/).

import { stageSlugFor } from './offer-config.js'

export const FOOTER_TEXT = 'Reply STOP to unsubscribe'
const TAG_MAX = 60
const NAME_MAX = 512
// Meta's limit on a template BODY's text.
const BODY_MAX = 1024

// ---------- naming ----------

/** "UN1T Stillorgan" -> "un1t_stillorgan". */
export function studioSlugFor(locationName) {
  return String(locationName ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
}

/** `${studioSlug}_${boardKey}_${packKey}[_${ref}][_v${version}]`, lowercased, [a-z0-9_] only.
 *  `version` (a whole number) adds the `_v<n>` suffix only above 1: a replaced
 *  template needs a new name, and version 1 keeps the name it always had.
 *  Throws on an empty studio slug, board key or pack key (two studios or two
 *  boards would share one name), and on a name over Meta's 512: truncating
 *  could make two different templates one name. */
export function templateNameFor({ studioSlug, boardKey, packKey, ref, version } = {}) {
  for (const [label, v] of [['studioSlug', studioSlug], ['boardKey', boardKey], ['packKey', packKey]]) {
    if (v == null || String(v).trim() === '') throw new Error(`a template name needs a ${label}`)
  }
  const suffix = Number.isInteger(version) && version > 1 ? `v${version}` : null
  const raw = [studioSlug, boardKey, packKey, ref, suffix].filter((p) => p != null && p !== '').join('_')
  const name = raw.toLowerCase().replace(/[^a-z0-9_]/g, '_')
  if (name.length > NAME_MAX) throw new Error(`the template name ${name.slice(0, 40)}… is longer than ${NAME_MAX} characters`)
  return name
}

// ---------- wording ----------
// Fill-ins: {studio} {offer} {days} {days_left} {signer}. {{1}} is Meta's variable
// (the contact's first name) and survives rendering.

const BOOK_FIRST_CLASS = 'Hi {{1}}, thanks for starting your {offer} at {studio} 💪 We haven\'t seen you book your first class yet. Tap below to pick one this week, or reply here and we\'ll book it for you. {signer}'

const AFTER_FIRST_CLASS = 'Hi {{1}}, great to have you in for your first class of the {offer} at {studio} 💪 How did you find it? If you\'ve any questions about classes, I\'m here to help. The more you come in over the {days} days, the more you\'ll get out of it. Download the app to book your classes, or reply here and I can get you sorted. Thanks, {signer}'

const HALFWAY_MAIN = 'Hi {{1}}, you\'re halfway through your {offer} at {studio} 💪 You\'ve {days_left} days of your {offer} left, so book your next few sessions now and finish strong. Any questions, just reply here. {signer}'

const OFFER_ENDED = 'Hi {{1}}, {signer} from {studio} here 👋\n\nYour {offer} has come to an end, and I hope you enjoyed the sessions. How did you find them?\n\nIf you\'d like to keep training with us, reply here and I\'ll talk you through the memberships and any offers that suit you best. Happy to jump on a quick call too if that\'s easier.\n\nTalk soon, {signer}'

const OFFER_FOLLOWUP = 'Hey {{1}}, just bumping this in case it got buried! Reply here if you\'d like a hand choosing a membership, or a quick call 👍 {signer}'

const PROGRAMME_WELCOME = 'Hi {{1}}, welcome to the {offer} at {studio} 💪 We haven\'t seen you book your first class yet. Tap below to pick one this week, or reply here and we\'ll book it for you. {signer}'

const PROGRAMME_AFTER_FIRST = 'Hi {{1}}, great to have you in for your first class of the {offer} at {studio} 💪 How did you find it? Any questions, just reply here and I\'ll help. The more you come in over the next {days} days, the more you\'ll get out of it. Book your next classes below or in the app. Thanks, {signer}'

const PROMO_WELCOME = 'Hi {{1}}, thanks for claiming the {offer} at {studio} 💪 You\'ve {days} days to use it and we haven\'t seen you book yet. Tap below to pick a class, or reply here and we\'ll book it for you. {signer}'

const PROMO_AFTER_FIRST = 'Hi {{1}}, great to have you in for your first class at {studio} 💪 How did you find it? You\'ve {days} days to use your {offer}, so book your next class below or in the app, or reply here and I\'ll sort it for you. Thanks, {signer}'

const PROMO_ENDING = 'Hi {{1}}, your {offer} at {studio} has now ended 👋 I hope you enjoyed it! If you\'d like to keep training with us, reply here and I\'ll talk you through the membership options that suit you best. {signer}'

// ---------- graph builders ----------

function stableHash(text) {
  let h = 5381
  for (let i = 0; i < text.length; i += 1) h = ((h * 33) ^ text.charCodeAt(i)) >>> 0
  return h.toString(36).padStart(6, '0').slice(-6)
}

/** `${boardKey}_${packKey}_${suffix}`, never truncated: a long boardKey is shortened
 *  to a prefix plus a stable hash so the packKey and suffix always survive. */
export function tagFor(boardKey, packKey, suffix) {
  const full = `${boardKey}_${packKey}_${suffix}`
  if (full.length <= TAG_MAX) return full
  const room = TAG_MAX - packKey.length - suffix.length - 2
  if (room < 8) throw new Error(`tag for ${packKey}/${suffix} cannot fit in ${TAG_MAX} characters`)
  return `${boardKey.slice(0, room - 7)}_${stableHash(boardKey)}_${packKey}_${suffix}`
}

function graphBuilder(kind, spec) {
  return (ctx) => {
    const { boardKey, packKey, stageSlug, ids } = ctx
    const nodes = []
    const edges = []
    let n = 0
    const node = (type, config) => { const id = `n${++n}`; nodes.push({ id, type, config }); return id }
    const edge = (from, to, label) => edges.push(label ? { from, to, label } : { from, to })
    const tag = (suffix) => node('apply_tag', { tag: tagFor(boardKey, packKey, suffix) })
    const send = (ref) => node('whatsapp', { template_id: ids[ref], variables: { 1: 'first_name' } })
    const inStage = () => node('branch', { predicate: { type: 'in_pipeline_stage_at_studio', stages: [stageSlug] } })
    const booked = (days) => node('branch', { predicate: { type: 'booked_class_at_studio', within_days: days } })
    const chain = (from, nodeIds) => nodeIds.reduce((prev, id) => { edge(prev, id); return id }, from)

    if (kind === 'booking_nudge') {
      const lead = chain('trigger', [node('wait', { minutes: 1 }), node('wait', spec.wait)])
      const stage = inStage(); edge(lead, stage)
      const b = booked(spec.withinDays); edge(stage, b, 'yes')
      edge(stage, tag('moved_on'), 'no')
      edge(b, tag('already_booked'), 'yes')
      const s = send(spec.ref); edge(b, s, 'no'); edge(s, tag('nudge_sent'))
    } else if (kind === 'checkin' || kind === 'ending') {
      const lead = chain('trigger', [node('wait', { minutes: 1 }), ...(spec.wait ? [node('wait', spec.wait)] : [])])
      const stage = inStage(); edge(lead, stage)
      const s = send(spec.ref); edge(stage, s, 'yes'); edge(s, tag('sent'))
      edge(stage, tag('not_in_stage'), 'no')
    } else if (kind === 'halfway') {
      const stage = inStage(); edge('trigger', stage)
      const b = booked(8); edge(stage, b, 'yes')
      edge(stage, tag('not_in_stage'), 'no')
      const main = send('main'); edge(b, main, 'yes'); edge(main, tag('checkin_sent'))
      const nudge = send('nudge'); edge(b, nudge, 'no'); edge(nudge, tag('nudge_sent'))
    } else if (kind === 'trial_done') {
      const stage = inStage(); edge('trigger', stage)
      edge(stage, tag('not_in_stage'), 'no')
      const main = send('main'); edge(stage, main, 'yes')
      const w = chain(main, [node('wait', { hours: 2 }), node('wait', { hours: 22 })])
      const replied = node('branch', { predicate: { type: 'whatsapp_reply_since_enrolment' } }); edge(w, replied)
      edge(replied, tag('replied'), 'yes')
      const still = inStage(); edge(replied, still, 'no')
      edge(still, send('followup'), 'yes')
      edge(still, tag('moved_on'), 'no')
    } else {
      throw new Error(`unknown graph kind ${kind}`)
    }
    return {
      version: 1,
      trigger: { type: 'pipeline_stage_change', config: { to_status: stageSlug } },
      nodes,
      edges,
    }
  }
}

// ---------- recipes ----------

const pack = (key, role, name, templates, kind, spec = {}, extra = {}) =>
  ({ key, role, ...extra, name, templates, graphKind: kind, graphSpec: spec })

const bookNudgePack = (key, name, body, wait, withinDays) =>
  pack(key, 'new', name, [{ ref: 'main', body, buttons: ['book'] }], 'booking_nudge', { ref: 'main', wait, withinDays })

const checkinPack = (body, name = 'After the first class') =>
  pack('after_first_class', 'first_class', name, [{ ref: 'main', body, buttons: ['book', 'apps'] }], 'checkin', { ref: 'main', wait: { hours: 3 } })

const stage = (role, name, extra) => ({ role, name, ...extra })

function recipe({ key, name, description, entry, stages, duration_days, packs }) {
  return {
    key,
    name,
    description,
    boardType: 'offer',
    packs,
    // A starting point: entry.values is empty, which parseOfferConfig refuses until
    // the builder has the operator pick at least one value.
    defaultConfig(boardKey) {
      return {
        entry: { ...entry, values: [] },
        stages: stages.map((s) => {
          const out = { role: s.role, slug: stageSlugFor(boardKey, s.role, s), name: s.name }
          if (s.day != null) out.day = s.day
          if (s.count != null) out.count = s.count
          return out
        }),
        duration_days,
      }
    },
  }
}

export const RECIPES = Object.freeze({
  paid_trial_offer: recipe({
    key: 'paid_trial_offer',
    name: 'Paid trial',
    description: 'People who buy a paid trial: book the first class, a day 7 check-in, then an offer when the trial ends.',
    entry: { type: 'trial_purchase', match: 'plan_code' },
    stages: [
      stage('new', 'New Leads'),
      stage('first_class', '1st Class'),
      stage('checkpoint', 'Day 7', { day: 7 }),
      stage('done', 'Trial Done'),
      stage('converted', 'Converted'),
    ],
    duration_days: 14,
    packs: [
      bookNudgePack('book_first_class', 'Book the first class', BOOK_FIRST_CLASS, { days: 2 }, 3),
      checkinPack(AFTER_FIRST_CLASS),
      pack('halfway', 'checkpoint', 'Halfway check-in', [
        { ref: 'main', body: HALFWAY_MAIN, buttons: ['book'] },
        { ref: 'nudge', body: BOOK_FIRST_CLASS, buttons: ['book'] },
      ], 'halfway', {}, { day: 7 }),
      pack('trial_done', 'done', 'End of trial', [
        { ref: 'main', body: OFFER_ENDED, buttons: [] },
        { ref: 'followup', body: OFFER_FOLLOWUP, buttons: [] },
      ], 'trial_done'),
    ],
  }),
  programme_lead: recipe({
    key: 'programme_lead',
    name: 'Programme',
    description: 'People who join a programme through a lead source: welcome, then a check-in after the first class.',
    entry: { type: 'lead_source' },
    stages: [stage('new', 'Lead'), stage('first_class', '1st Class Done'), stage('converted', 'Converted')],
    duration_days: 30,
    packs: [
      bookNudgePack('welcome', 'Welcome', PROGRAMME_WELCOME, { days: 1 }, 3),
      checkinPack(PROGRAMME_AFTER_FIRST),
    ],
  }),
  promo_claim: recipe({
    key: 'promo_claim',
    name: 'Promo',
    description: 'People who claim a promo: a nudge to book, a check-in after the first class, and a message when it ends.',
    entry: { type: 'corp_promo' },
    stages: [stage('new', 'New'), stage('first_class', '1st Class'), stage('done', 'Done'), stage('converted', 'Converted')],
    duration_days: 7,
    packs: [
      bookNudgePack('welcome', 'Welcome', PROMO_WELCOME, { days: 1 }, 3),
      checkinPack(PROMO_AFTER_FIRST),
      pack('ending', 'done', 'Offer ended', [{ ref: 'main', body: PROMO_ENDING, buttons: [] }], 'ending', { ref: 'main' }),
    ],
  }),
})

// ---------- rendering ----------

// Operator input: single-line, never able to add Meta variables, and never
// empty (an empty fill-in reads "starting your  at  💪" to a customer).
function cleanFillIn(name, value) {
  const v = String(value ?? '')
  if (v.includes('{{') || v.includes('}}')) throw new Error(`${name} must not contain {{ or }}`)
  const cleaned = v.replace(/\s+/g, ' ').trim()
  if (!cleaned) throw new Error(`${name} is required`)
  return cleaned
}

function fillIns(text, values) {
  return text.replace(/(?<!\{)\{([a-z_]+)\}(?!\})/g, (_, k) => {
    if (!(k in values)) throw new Error(`unknown fill-in {${k}}`)
    return values[k]
  })
}

// The default body's "Tap below ..." sentence points at a button. With no button
// at all (no booking flow, no app links) it points at nothing, so it becomes the
// reply line, keeping the sentence's own trailing space or newline.
export const REPLY_TO_BOOK = "Reply here and we'll book it for you."
function replaceTapBelow(body) {
  return body.replace(/Tap below[^.!?]*[.!?](\s*)/, (_, ws) => `${REPLY_TO_BOOK}${ws}`)
}

// An operator's own wording for one message. It keeps Meta's first-name variable
// {{1}}, can add no other variable, and may use the fill-in tokens.
function checkWording(ref, body) {
  if (typeof body !== 'string') throw new Error(`wording: the ${ref} message must be text`)
  const text = body.replace(/\r\n?/g, '\n').trim()
  const exactOne = /(?<!\{)\{\{1\}\}(?!\})/g
  if (!exactOne.test(text)) throw new Error('wording: the message must include {{1}} (the first name)')
  if (/\{\{|\}\}/.test(text.replace(exactOne, ''))) {
    throw new Error('wording: the message can use {{1}} only; no other {{ }} variables')
  }
  return text
}

function buttonsFor(kinds, { bookingFlowId, appLinks }) {
  const out = []
  for (const kind of kinds) {
    if (kind === 'book' && bookingFlowId) {
      out.push({ type: 'FLOW', text: 'Book a class', flow_id: bookingFlowId, flow_action: 'data_exchange' })
    } else if (kind === 'apps') {
      if (appLinks?.iosUrl) out.push({ type: 'URL', text: 'iPhone app', url: appLinks.iosUrl })
      if (appLinks?.androidUrl) out.push({ type: 'URL', text: 'Android app', url: appLinks.androidUrl })
    }
  }
  return out
}

/**
 * @returns {{ templates: Array<{ref, name, category, language, components}>, buildGraph: (templateIdsByRef: object, stageSlug: string) => object }}
 */
export function renderPack(recipeKey, packKey, opts = {}) {
  const recipeDef = RECIPES[recipeKey]
  if (!recipeDef) throw new Error(`unknown recipe ${recipeKey}`)
  const packDef = recipeDef.packs.find((p) => p.key === packKey)
  if (!packDef) throw new Error(`unknown pack ${packKey} in recipe ${recipeKey}`)
  const { boardKey, studioSlug, studioName, offerName, durationDays, signer, version, bodies } = opts
  if (version != null && (!Number.isInteger(version) || version < 1)) throw new Error('version must be a whole number, 1 or more')
  for (const ref of Object.keys(bodies ?? {})) {
    if (!packDef.templates.some((t) => t.ref === ref)) throw new Error(`wording: this pack has no ${ref} message`)
  }
  const checkpointDay = packDef.day ?? 7
  if (!Number.isInteger(durationDays) || durationDays < 1) {
    throw new Error('durationDays must be a whole number of days, 1 or more')
  }
  // "You've 0 days left" at the halfway check-in is never right.
  if (packDef.graphKind === 'halfway' && durationDays <= checkpointDay) {
    throw new Error(`durationDays must be more than the day ${checkpointDay} check-in for the ${packKey} pack`)
  }
  const values = {
    studio: cleanFillIn('studioName', studioName),
    offer: cleanFillIn('offerName', offerName),
    days: String(durationDays),
    days_left: String(durationDays - checkpointDay),
    signer: cleanFillIn('signer', signer),
  }
  const templates = packDef.templates.map((t) => {
    const buttons = buttonsFor(t.buttons, opts)
    const override = bodies?.[t.ref]
    let source
    if (override != null) source = checkWording(t.ref, override)
    else source = buttons.length === 0 ? replaceTapBelow(t.body) : t.body
    let text
    try {
      text = fillIns(source, values)
    } catch (err) {
      throw override != null ? new Error(`wording: ${err.message}`) : err
    }
    if (text.length > BODY_MAX) {
      throw new Error(`${override != null ? 'wording: ' : ''}the ${packKey} message is ${text.length} characters, over WhatsApp's ${BODY_MAX}: shorten ${override != null ? 'it' : 'the fill-ins'}`)
    }
    const components = [{
      type: 'BODY',
      text,
      example: { body_text: [['Tim']] },
    }, { type: 'FOOTER', text: FOOTER_TEXT }]
    if (buttons.length) components.push({ type: 'BUTTONS', buttons })
    return {
      ref: t.ref,
      name: templateNameFor({ studioSlug, boardKey, packKey, ref: t.ref, version }),
      category: 'MARKETING',
      language: 'en',
      components,
    }
  })
  const build = graphBuilder(packDef.graphKind, packDef.graphSpec)
  return {
    templates,
    buildGraph(templateIdsByRef, stageSlug) {
      return build({ boardKey, packKey, stageSlug, ids: templateIdsByRef || {} })
    },
  }
}
