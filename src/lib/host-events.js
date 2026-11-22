// HOST-PORTAL.3 — pure foundation for host self-serve event creation.
//
// Spec: docs/superpowers/specs/2026-07-08-host-self-serve-events-design.md
//
// A 3rd-party event host drafts their own events and publishes them.
// HOSTAUTOPUB.1 — there is no staff approval step any more: the lifecycle is
//   draft → published (the host's Publish button, POST .../submit)
//   published → draft (the host's "Take off sale", POST .../unpublish)
// Staff are told when an event goes live (host-notifications.js) and take one
// down with the event's active switch (DELETE /api/events/[id] soft-deletes).
// 'pending_review' and 'rejected' stay valid statuses for rows written before
// HOSTAUTOPUB.1: such a row is not public, the host can publish it, and the
// /settings/hosts queue still lets staff approve or reject it.
//
// This module holds the *pure* parts of that machine — the status
// constants, the public-visibility predicate, the safe field defaults
// (host events must never touch UN1T-only levers like Glofox sync or
// member pricing) and the strict input schema. Keeping these
// pure keeps the routes slim and the state logic testable without a DB.

import { z } from 'zod'
import { uuidLike } from '@/lib/schemas'
import { PricingTiersSchema } from '@/lib/pricing-tiers'
import { RegistrationQuestionsSchema } from '@/lib/registration-questions'
import { DEFAULT_EVENT_HOLD_MINUTES } from '@/lib/event-hold'

// The four lifecycle states a host event moves through.
export const HOST_EVENT_STATUSES = ['draft', 'pending_review', 'published', 'rejected']

// HOSTAUTOPUB.1 — the statuses a host may publish from (POST .../submit).
// 'pending_review' and 'rejected' are only ever rows written before
// HOSTAUTOPUB.1; publishing one is the host's go-live, as for a draft.
export const HOST_PUBLISHABLE_STATUSES = ['draft', 'rejected', 'pending_review']

// Event kinds a host may create. Deliberately EXCLUDES 'lead_gen',
// which is a UN1T-only acquisition surface — hosts must not be able
// to mint lead-gen events on the shared platform.
export const HOST_EVENT_KINDS = ['workshop', 'seminar', 'masterclass', 'open_day', 'race']

// Operator-facing labels for each status.
export const HOST_EVENT_STATUS_LABEL = {
  draft: 'Draft',
  pending_review: 'In review',
  published: 'Published',
  rejected: 'Needs changes',
}

// A host event is only publicly visible when it has been both
// published (status=published) AND left active. Defensive against a
// missing/undefined status or a null event.
export function eventIsPublic(event) {
  return !!event && event.active === true && event.status === 'published'
}

// Safe defaults forced onto every host-created event. These pin the
// UN1T-only levers off so a host can never enable member pricing,
// Glofox provisioning, cross-location sharing, or claim staff.
export function hostEventDefaults() {
  return {
    member_pricing_enabled: false,
    members_only: false,
    member_fee_cents: null,
    shared: false,
    create_in_glofox: false,
    staff_required: 0,
    payment_currency: 'EUR',
    capacity_mode: 'people',
  }
}

// EVENT-SLUG.1 — slugs come from `@/lib/event-slug` (place-date-time);
// the name-based deriveSlug that lived here is gone.

// HOSTAUTOPUB.1 — an edit never changes a host event's status. The re-review
// rule that lived here (reReviewReasons / computeEditTransition: a date, price,
// tier, session time, studio or studio-hours change on a published event sent
// it back to pending_review) is gone with the staff approval step: the PUT
// route writes the edit and leaves the status where it was.

// HOSTSTUDIONOTICE.1 — the studio part of that rule comes back as a NOTICE,
// never a check: staff are TOLD when a published host event starts to use a
// studio, or uses its studio for longer (the link holds the studio's Shelly
// timers on for the event: src/lib/shelly/studio-events.js). The save is never
// blocked or changed by it. Same rules as SHELLYEVENTS.1/.2:
//   'studio'       — linked INTO a studio, or moved to a different one. Moving
//                    OUT (to "somewhere else", null) switches nothing on and
//                    never counts. Judged only when `changes` carries the key.
//   'studio_hours' — still linked, and a session now starts before the first
//                    current start or after the last one, or the hold grows
//                    (the studio's hold setting, or the event's own duration
//                    when that is longer). A session inside the current hours,
//                    a shorter duration and a removed session do not count.
// An EXISTING session re-timed outside the current hours counts too (the old
// session_time re-review caught that; it is gone).
export const STUDIO_USE_REASONS = ['studio', 'studio_hours']

const hhmm = (t) => String(t || '').slice(0, 5)
const positiveMinutes = (v) => {
  const n = Number(v)
  return v != null && Number.isFinite(n) && n > 0 ? n : null
}
// Mirrors holdMinutes() in src/lib/shelly/studio-events.js (not imported:
// this module also runs in the host's browser).
const studioHold = (durationMinutes, studioHoldMinutes) =>
  Math.max(positiveMinutes(studioHoldMinutes) ?? DEFAULT_EVENT_HOLD_MINUTES, positiveMinutes(durationMinutes) ?? 0)

/**
 * How a still-linked event's studio hours grow with an edit. Pure.
 * @param {{ venue_location_id?: string|null, duration_minutes?: number|null, waves?: Array<{ start_time: string }> }} current
 *   the row before the edit (waves: its sessions; HH:MM or HH:MM:SS)
 * @param {{ venue_location_id?: string|null, duration_minutes?: number|null, session_times?: string[] }} changes
 *   the edit: every session start time it leaves (new and existing)
 * @param {{ studioHoldMinutes?: number|null }} [opts] the studio's hold setting
 * @returns {{ earlier: string|null, later: string|null, longerHoldMinutes: number|null }}
 *   the new first / last start time when it moved outward, the new hold when longer
 */
export function studioHoursGrowth(current, changes, { studioHoldMinutes = null } = {}) {
  const none = { earlier: null, later: null, longerHoldMinutes: null }
  const c = changes || {}
  const linked = current?.venue_location_id != null
    && !('venue_location_id' in c && c.venue_location_id == null)
  if (!linked) return none
  const before = (Array.isArray(current.waves) ? current.waves : []).map((w) => hhmm(w?.start_time)).filter(Boolean).sort()
  const after = (Array.isArray(c.session_times) ? c.session_times : []).map(hhmm).filter(Boolean).sort()
  const out = { ...none }
  if (before.length > 0 && after.length > 0) {
    if (after[0] < before[0]) out.earlier = after[0]
    if (after[after.length - 1] > before[before.length - 1]) out.later = after[after.length - 1]
  }
  if ('duration_minutes' in c) {
    const nextHold = studioHold(c.duration_minutes, studioHoldMinutes)
    if (nextHold > studioHold(current.duration_minutes, studioHoldMinutes)) out.longerHoldMinutes = nextHold
  }
  return out
}

/**
 * Which studio-use changes an edit to a host event makes, in
 * STUDIO_USE_REASONS order; [] when nothing studio-related grew. Pure: the
 * caller decides it only matters for a PUBLISHED event.
 */
export function studioUseGrew(current, changes, opts = {}) {
  const c = changes || {}
  const studio = 'venue_location_id' in c
    && c.venue_location_id != null
    && c.venue_location_id !== (current?.venue_location_id ?? null)
  const g = studioHoursGrowth(current || {}, c, opts)
  const hit = { studio, studio_hours: !!(g.earlier || g.later || g.longerHoldMinutes) }
  return STUDIO_USE_REASONS.filter((r) => hit[r])
}

/**
 * The `changes` studioUseGrew compares, from a HostEventSchema-shaped body.
 * duration_minutes is ALWAYS present, as the PUT route writes it
 * (`input.duration_minutes ?? null`): no duration means the default hold.
 */
export function studioChangesFromInput(input) {
  const i = input || {}
  const sessions = Array.isArray(i.sessions) ? i.sessions : []
  return {
    ...('venue_location_id' in i ? { venue_location_id: i.venue_location_id ?? null } : {}),
    session_times: sessions.map((s) => s?.start_time).filter(Boolean),
    duration_minutes: i.duration_minutes ?? null,
  }
}

// Strict input schema for a host-submitted event. `.strict()` rejects
// any extra keys so a host can't smuggle UN1T-only fields (member
// pricing, Glofox sync, etc.) past validation — those are forced by
// hostEventDefaults() server-side, never accepted from the client.
export const MAX_SESSIONS = 12

export const SessionInputSchema = z
  .object({
    id: uuidLike.optional(),
    start_time: z.string().regex(/^\d{2}:\d{2}$/),
    label: z.string().max(120).optional().nullable(),
    capacity: z.number().int().min(1).max(100000),
  })
  .strict()

export const HostEventSchema = z
  .object({
    kind: z.enum(HOST_EVENT_KINDS),
    name: z.string().trim().min(1).max(200),
    description: z.string().max(5000).optional().nullable(),
    race_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    registration_opens_at: z.string().datetime().optional().nullable(),
    registration_closes_at: z.string().datetime().optional().nullable(),
    allowed_team_sizes: z.array(z.number().int().min(1).max(8)).min(1),
    ticket_price_cents: z.number().int().min(0).max(1_000_000),
    // HOSTSERIES.1 — one row per session time (a race_waves row each); an
    // id names an existing wave being edited. Unique start times.
    sessions: z.array(SessionInputSchema).min(1).max(MAX_SESSIONS).superRefine((sessions, ctx) => {
      const seen = new Set()
      for (const s of sessions) {
        if (seen.has(s.start_time)) {
          ctx.addIssue({ code: 'custom', path: [], message: 'Each session needs its own start time.' })
          return
        }
        seen.add(s.start_time)
      }
    }),
    series_id: uuidLike.nullable().optional(),
    // TIERS.1 — early bird / capacity / group tiers (race_events.pricing_tiers).
    pricing_tiers: PricingTiersSchema.nullable().optional(),
    // QUESTIONS.1 — asked at signup (race_events.registration_questions); never a re-review.
    registration_questions: RegistrationQuestionsSchema.nullable().optional(),
    // CALENDAR.1 — how long a session runs (race_events.duration_minutes); null = the kind's default.
    duration_minutes: z.number().int().min(5).max(1440).nullable().optional(),
    hero_image_url: z.string().url().optional().nullable(),
    accent_hex: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional().nullable(),
    venue_name: z.string().trim().min(1).max(200),
    venue_address: z.string().trim().max(500).optional().nullable(),
    // SHELLYEVENTS.1 — the studio the event is held at (mig 832); null =
    // somewhere else. Judged by judgeVenueStudio before it is written.
    venue_location_id: uuidLike.nullable().optional(),
    confirmation_email_subject: z.string().max(300).optional().nullable(),
    confirmation_email_intro: z.string().max(5000).optional().nullable(),
    reminder_email_subject: z.string().max(300).optional().nullable(),
    reminder_email_intro: z.string().max(5000).optional().nullable(),
    // HOSTPAGE.2 — the post-event rating request (mig 823).
    rating_email_subject: z.string().max(300).optional().nullable(),
    rating_email_intro: z.string().max(5000).optional().nullable(),
  })
  .strict()

export { uuidLike }

// Lazily provision the hidden "anchor" location that a host's events
// hang off. Each host gets exactly one anchor location, created on
// first need and cached back onto the host row. The location is
// flagged is_host_anchor so it stays out of the normal location
// pickers, and its slug is `host-<hostId>` — the host id is a uuid,
// so this guarantees the NOT-NULL, UNIQUE `locations.slug` never
// collides. Returns the anchor location id.
export async function ensureAnchorLocation(db, host) {
  if (host.anchor_location_id) return host.anchor_location_id
  const slug = `host-${host.id}`
  // Self-heal a prior partial run: the anchor row may already exist (holding the
  // UNIQUE slug) but the link-back to event_hosts failed, leaving anchor_location_id
  // null. Reuse it instead of re-inserting the same slug into a UNIQUE violation.
  const { data: existing } = await db.from('locations').select('id').eq('slug', slug).eq('is_host_anchor', true).maybeSingle()
  let id = existing?.id
  if (!id) {
    const { data, error } = await db
      .from('locations')
      .insert({ organization_id: host.organization_id, name: `${host.name} (host events)`, slug, active: true, is_host_anchor: true })
      .select('id')
      .single()
    if (data?.id) {
      id = data.id
    } else {
      // First-create race: two concurrent provisions both missed the SELECT and
      // one INSERT lost the UNIQUE slug. Self-heal by re-selecting the row the
      // winner created rather than surfacing a spurious 500.
      const { data: raced } = await db.from('locations').select('id').eq('slug', slug).eq('is_host_anchor', true).maybeSingle()
      if (raced?.id) id = raced.id
      else throw new Error(`anchor location provisioning failed: ${error?.message || 'no row'}`)
    }
  }
  const { error: linkErr } = await db.from('event_hosts').update({ anchor_location_id: id }).eq('id', host.id)
  if (linkErr) throw new Error(`anchor link failed: ${linkErr.message}`)
  return id
}

// HOST-MASTER.1 — where host-sourced CONTACTS live. The org's master
// location when configured (Stillorgan for UN1T Group, mig 464);
// otherwise the host's anchor location — fail-open to the pre-master
// behaviour, never to a wrong location. Errors also fall back.
//
// FAIL-OPEN IS ONLY RIGHT FOR CONTACT HOMING. For SENDER selection the same
// fallback IS the wrong location — the host anchor has no email
// identity, so falling back there sends under the wrong brand. That caller
// (`resolveEventCommsLocation`) must use `resolveMasterLocationIdStrict`
// below, which surfaces the read failure instead of folding it into the
// anchor. Keep the two apart; do not "simplify" them back together.
export async function resolveMasterLocationId(db, host) {
  try {
    return await resolveMasterLocationIdStrict(db, host)
  } catch {
    return host?.anchor_location_id || null
  }
}

// The same lookup with the fail-open removed: a read error THROWS rather than
// resolving to the anchor. Use this wherever the answer selects an identity
// (sender, brand) rather than a home for a row.
export async function resolveMasterLocationIdStrict(db, host) {
  if (!host?.organization_id) return host?.anchor_location_id || null
  const { data, error } = await db
    .from('organizations')
    .select('master_location_id')
    .eq('id', host.organization_id)
    .maybeSingle()
  if (error) {
    throw new Error(`resolveMasterLocationId: organizations read failed for org ${host.organization_id} (falling back would pick the host's sender-less anchor): ${error.message}`)
  }
  return data?.master_location_id || host.anchor_location_id || null
}
