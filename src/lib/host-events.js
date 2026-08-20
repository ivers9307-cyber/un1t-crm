// HOST-PORTAL.3 — pure foundation for host self-serve event creation.
//
// Spec: docs/superpowers/specs/2026-07-08-host-self-serve-events-design.md
//
// A 3rd-party event host drafts their own events and submits them for
// UN1T approval before they go public. The lifecycle is:
//   draft → pending_review → published (or → rejected → back to draft)
//
// This module holds the *pure* parts of that machine — the status
// constants, the public-visibility predicate, the safe field defaults
// (host events must never touch UN1T-only levers like Glofox sync or
// member pricing), the edit-diff that decides whether a published
// event needs re-review, and the strict input schema. Keeping these
// pure keeps the routes slim and the state logic testable without a DB.

import { z } from 'zod'
import { uuidLike } from '@/lib/schemas'

// The four lifecycle states a host event moves through.
export const HOST_EVENT_STATUSES = ['draft', 'pending_review', 'published', 'rejected']

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
// approved (status=published) AND left active. Defensive against a
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

// Turn a display name into a URL-safe slug. Lowercases, collapses any
// run of non-alphanumerics to a single '-', trims leading/trailing
// dashes, and falls back to 'event' when nothing usable remains.
export function deriveSlug(name) {
  const slug = String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return slug || 'event'
}

// Decide what an edit does to a host event's status.
//
// Edits to a draft or rejected event never change status and never
// need review — the host is still working on it. Only a *published*
// event can be knocked back into review, and only when a
// customer-material field changes: price, date, or a wave start time.
// Cosmetic edits (description, copy, images) leave it published.
export function computeEditTransition(current, changes) {
  if (current.status !== 'published') {
    return { status: current.status, reReview: false }
  }

  const priceChanged =
    'non_member_fee_cents' in changes &&
    Number(changes.non_member_fee_cents) !== Number(current.non_member_fee_cents)

  const dateChanged =
    'race_date' in changes &&
    String(changes.race_date || '') !== String(current.race_date || '')

  const waveKey = (waves) =>
    (Array.isArray(waves) ? waves : [])
      .map((w) => `${w.id || ''}:${w.start_time || ''}`)
      .join('|')
  const waveTimeChanged =
    'waves' in changes && waveKey(current.waves) !== waveKey(changes.waves)

  const reReview = priceChanged || dateChanged || waveTimeChanged
  return { status: reReview ? 'pending_review' : 'published', reReview }
}

// Strict input schema for a host-submitted event. `.strict()` rejects
// any extra keys so a host can't smuggle UN1T-only fields (member
// pricing, Glofox sync, etc.) past validation — those are forced by
// hostEventDefaults() server-side, never accepted from the client.
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
    session_start_time: z.string().regex(/^\d{2}:\d{2}$/),
    session_capacity: z.number().int().min(1).max(100000),
    session_label: z.string().max(120).optional().nullable(),
    hero_image_url: z.string().url().optional().nullable(),
    accent_hex: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional().nullable(),
    venue_name: z.string().trim().min(1).max(200),
    venue_address: z.string().trim().max(500).optional().nullable(),
    confirmation_email_subject: z.string().max(300).optional().nullable(),
    confirmation_email_intro: z.string().max(5000).optional().nullable(),
    reminder_email_subject: z.string().max(300).optional().nullable(),
    reminder_email_intro: z.string().max(5000).optional().nullable(),
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
// fallback IS the wrong location — the host anchor has no Twilio/email
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
