// CHARITY.2 — pure helpers for card donations on the public event page.
// Settings resolution, copy defaults and totals. No IO, no React/Next/Supabase.

import { z } from 'zod'
import { parseEmbed } from './landing-page-embed'

export const CHARITY_DEFAULTS = Object.freeze({
  name: '',
  // CHARITY.13 — an optional YouTube or Instagram link shown beside the event
  // summary under the two cards. Blank = no video.
  video_url: '',
  // CHARITY.14 — or a video the operator uploaded to the branding bucket
  // (public URL under race-video/<event id>/). When both are set the
  // uploaded file is what the page plays.
  video_file_url: '',
  heading: "Can't race? Give a rep.",
  blurb: 'Every euro goes to {{charity}}.',
  presets_cents: Object.freeze([1000, 2500, 5000, 10000]),
  custom_allowed: true,
  min_cents: 500,
  max_cents: 500000,
  match_multiplier: 1,
  match_label: 'Matched by {{brand}}',
  goal_cents: null,
  show_total: true,
  include_entries: true,
  consent_label: '',
  thank_you_title: 'Thank you, {{first_name}}.',
  thank_you_body:
    'Your {{amount}} becomes {{matched}} for {{charity}}. {{brand}} passes every donation, matched, to {{charity}} after the event.',
  thank_you_body_unmatched:
    'Thank you for your {{amount}} donation to {{charity}}. {{brand}} passes every donation to {{charity}} after the event.',
  receipt_subject: 'Thank you for your donation to {{charity}}',
  receipt_intro: '',
})

const text = z.string().max(4000)
const cents = z.number().int().positive()

/**
 * CHARITY.14 — the only video files the page will play are ones the event
 * form uploaded to the public branding bucket under race-video/<event id>/,
 * so an operator (or an API caller) cannot point the page at an arbitrary host.
 */
export const EVENT_VIDEO_PUBLIC_PATH = '/storage/v1/object/public/branding/race-video/'
export function isUploadedEventVideoUrl(url) {
  if (typeof url !== 'string') return false
  let u
  try { u = new URL(url) } catch { return false }
  return u.protocol === 'https:' && u.pathname.startsWith(EVENT_VIDEO_PUBLIC_PATH) && /\.(mp4|webm|mov)$/i.test(u.pathname)
}

/**
 * What the public page plays: the uploaded file when there is one, else the
 * embeddable form of the link, else null. The raw link never leaves the server.
 * @returns {{ provider: 'file', src: string, poster: string|null } | { provider: string, embedUrl: string } | null}
 */
export function resolveCharityVideo(settings, { posterUrl = null } = {}) {
  const file = settings?.video_file_url
  if (file && isUploadedEventVideoUrl(file)) return { provider: 'file', src: file, poster: posterUrl || null }
  return parseEmbed(settings?.video_url) || null
}

/** Validates what an operator saves into race_events.charity. Every key optional. */
export const CharitySettingsSchema = z
  .object({
    name: text.optional(),
    heading: text.optional(),
    blurb: text.optional(),
    presets_cents: z.array(z.number().int().positive().max(100000000)).max(8).optional(),
    custom_allowed: z.boolean().optional(),
    min_cents: cents.optional(),
    max_cents: cents.optional(),
    match_multiplier: z.number().min(1).max(5).optional(),
    match_label: text.optional(),
    goal_cents: cents.nullable().optional(),
    show_total: z.boolean().optional(),
    include_entries: z.boolean().optional(),
    consent_label: text.optional(),
    thank_you_title: text.optional(),
    thank_you_body: text.optional(),
    thank_you_body_unmatched: text.optional(),
    receipt_subject: text.optional(),
    receipt_intro: text.optional(),
    video_url: z.string().trim().max(2000).optional(),
    video_file_url: z.string().trim().max(2000).optional(),
  })
  .superRefine((s, ctx) => {
    if (s.video_url && !parseEmbed(s.video_url)) {
      ctx.addIssue({ code: 'custom', path: ['video_url'], message: 'Use a YouTube or Instagram link' })
    }
    if (s.video_file_url && !isUploadedEventVideoUrl(s.video_file_url)) {
      ctx.addIssue({ code: 'custom', path: ['video_file_url'], message: 'Upload the video through the event form' })
    }
    const min = s.min_cents ?? CHARITY_DEFAULTS.min_cents
    const max = s.max_cents ?? CHARITY_DEFAULTS.max_cents
    if (min > max) {
      ctx.addIssue({ code: 'custom', path: ['min_cents'], message: 'min_cents must not exceed max_cents' })
    }
    const presets = s.presets_cents ?? CHARITY_DEFAULTS.presets_cents
    const custom = s.custom_allowed ?? CHARITY_DEFAULTS.custom_allowed
    if (presets.length === 0 && !custom) {
      ctx.addIssue({ code: 'custom', path: ['presets_cents'], message: 'Offer at least one preset or allow a custom amount' })
    }
    // With custom amounts on, the server enforces [min, max] on every gift, so a preset
    // outside it would be a chip the donor can tap and the server then refuses.
    if (custom && presets.some((p) => p < min || p > max)) {
      ctx.addIssue({ code: 'custom', path: ['presets_cents'], message: 'Every preset must be between the minimum and maximum amount' })
    }
  })

/**
 * A race_events row's charity settings with defaults filled in. Keys saved as
 * null/undefined fall back; an empty string is kept (cleared on purpose).
 */
export function resolveCharitySettings(race) {
  const saved = race?.charity && typeof race.charity === 'object' && !Array.isArray(race.charity) ? race.charity : {}
  const out = { ...CHARITY_DEFAULTS }
  for (const [k, v] of Object.entries(saved)) {
    if (v !== null && v !== undefined) out[k] = v
  }
  const mult = Number(out.match_multiplier)
  out.match_multiplier = Number.isFinite(mult) && mult >= 1 ? mult : CHARITY_DEFAULTS.match_multiplier
  out.enabled = !!race?.charity_enabled
  return out
}

const COPY_TAGS = new Set(['charity', 'brand', 'first_name', 'amount', 'matched'])

/** Replaces {{charity}} {{brand}} {{first_name}} {{amount}} {{matched}}; unknown tags stay. */
export function renderCharityCopy(str, vars = {}) {
  if (typeof str !== 'string') return ''
  return str.replace(/\{\{\s*([a-z_]+)\s*\}\}/g, (whole, key) => {
    if (!COPY_TAGS.has(key)) return whole
    const v = vars?.[key]
    return v === null || v === undefined ? whole : String(v)
  })
}

const num = (v) => {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}
const mult = (v) => {
  const n = Number(v)
  return Number.isFinite(n) && n >= 1 ? n : 1
}

/**
 * Money raised so far. Only 'paid' donations and 'completed' entries count.
 * Each donation is matched at its own stored multiplier; entries at `multiplier`.
 */
export function computeCharityTotals({ donations, entries, multiplier, includeEntries } = {}) {
  let donationsCents = 0
  let donationsMatched = 0
  let donationCount = 0
  for (const d of Array.isArray(donations) ? donations : []) {
    if (!d || d.status !== 'paid') continue
    const amount = num(d.amount_cents)
    donationsCents += amount
    donationsMatched += Math.round(amount * mult(d.match_multiplier))
    donationCount += 1
  }
  const entryMult = mult(multiplier)
  let entriesCents = 0
  let entriesMatched = 0
  for (const e of Array.isArray(entries) ? entries : []) {
    if (!e || e.status !== 'completed') continue
    const amount = num(e.amount_cents)
    entriesCents += amount
    entriesMatched += Math.round(amount * entryMult)
  }
  return {
    donations_cents: donationsCents,
    donations_matched_cents: donationsMatched,
    entries_cents: entriesCents,
    entries_matched_cents: entriesMatched,
    raised_cents: donationsMatched + (includeEntries ? entriesMatched : 0),
    donation_count: donationCount,
  }
}

/** What the donor's screen shows for one donations row. */
export function donationPublicState(row) {
  if (!row) return 'notfound'
  if (row.status === 'paid') return 'paid'
  if (row.status === 'refunded') return 'refunded'
  if (row.status === 'failed' || row.status === 'expired') return 'failed'
  return 'pending'
}

/** '€25.00' */
export function formatCents(cents, currency = 'EUR') {
  return new Intl.NumberFormat('en-IE', { style: 'currency', currency: currency || 'EUR' }).format((Number(cents) || 0) / 100)
}

/**
 * Whether the staff events list links to an event's donations page: the
 * section is on, OR the event has any donation (spec §6), so switching the
 * section off never hides money already taken. `idsWithDonations` is a Set of
 * race_event ids.
 */
export function showsDonationsLink(race, idsWithDonations) {
  return !!race?.charity_enabled || !!idsWithDonations?.has?.(race?.id)
}
