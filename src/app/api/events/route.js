// GET /api/events — list every event kind at the active (or ?location_id=)
// location for the mobile events browse surface (EVENT-CHECKIN.E).
//
// Staff-accessible: hasPermission('races') with NO MANAGER_ROLES gate — the
// mobile door-staff use case mirrors web /events (front-of-house). This is
// the deliberate divergence from GET /api/races, which is the manager-only
// race-day CONTROL list. Returns the data a list row needs: kind, date/time,
// status, a rendered signup summary, and an is_upcoming flag (the Dublin
// today boundary is computed server-side so mobile carries no timezone math).
//
// POST /api/events — create a new event. Manager+ permission. Multi-kind:
// race_events.kind discriminates between 'race' (the original Hyrox-sim
// shape — multiple waves, team-name required, race-day control panel, TV
// display) and 'workshop' / 'seminar' / 'open_day' / 'masterclass' (single
// time slot, per-seat capture without a team name). UI gates on kind; the
// underlying data shape (waves[], allowed_team_sizes, race_payments per-seat)
// stays the same — non-race kinds always submit exactly one synthetic wave.

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { getCurrentUser, assertLocationAccess } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import { createServerClient } from '@/lib/supabase'
import { validateBody } from '@/lib/validate'
import { ADMIN_ROLES, uuidLike } from '@/lib/schemas'
import { toSlug } from '@/lib/slug'
import { formatSignupSummary, sumWaveCapacity } from '@/lib/event-signups'
import { isRaceKind, orderEventsForBrowse, todayIsoDublin } from '@shared/events'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'


// Wave shape used in both create + update. capacity null = unlimited.
const WaveInputSchema = z.object({
  start_time: z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/, 'Use HH:MM'),
  capacity: z.number().int().positive().max(10000).nullable().optional(),
  label: z.string().max(60).nullable().optional(),
  display_order: z.number().int().nonnegative().optional(),
})

export const CreateSchema = z.object({
  location_id: uuidLike,
  // Mig 122: discriminator. Defaults to 'race' so existing operator
  // muscle memory (where every event is a race) keeps working without
  // the form having to send the field.
  kind: z.enum(['race', 'workshop', 'seminar', 'open_day', 'masterclass', 'lead_gen']).optional(),
  // EVENTS-CAPACITY-MODE.1 (mig 280): does per-wave capacity count teams
  // (registrations, legacy default) or people (sum of team sizes)?
  capacity_mode: z.enum(['teams', 'people']).optional(),
  // Mig 125: staffing requirement for the studio overview demand
  // classifier. 0-50 (matches DB CHECK). Default 1 (matches DB DEFAULT).
  // Form pre-fills per kind (race=4, workshop=1, etc.) but operator
  // can override.
  staff_required: z.number().int().min(0).max(50).optional(),
  name: z.string().trim().min(1).max(200),
  slug: z.string().trim().min(1).max(120).regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, 'lowercase kebab-case').optional(),
  description: z.string().max(4000).nullable().optional(),
  // race_date is required for every kind EXCEPT lead_gen (a no-date
  // data-capture form). Enforced per-kind in the superRefine below.
  race_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD').nullable().optional(),
  registration_opens_at: z.string().datetime().nullable().optional(),
  registration_closes_at: z.string().datetime().nullable().optional(),
  allowed_team_sizes: z.array(z.number().int().positive().max(50)).min(1).max(20).optional(),
  active: z.boolean().optional(),
  // Member pricing (mig 084).
  member_pricing_enabled: z.boolean().optional(),
  members_only: z.boolean().optional(),
  // EVENTS-LOC.2: when true, this event shows in every location's list.
  shared: z.boolean().optional(),
  // EVENTS-HOST.4: nullable FK -> event_hosts. NULL = internal UN1T event
  // (settled via Revolut, the default); set = that host is paid directly
  // via Stripe Connect with UN1T's per-ticket booking fee. Org-validated
  // against the event's location below before it's persisted.
  host_id: uuidLike.nullable().optional(),
  member_fee_cents: z.number().int().nonnegative().nullable().optional(),
  non_member_fee_cents: z.number().int().nonnegative().nullable().optional(),
  payment_currency: z.string().length(3).optional(),
  // Mig 092: up to 3 sponsor/branding logo URLs for the TV display.
  // Schema CHECK caps the array at 6 to leave headroom; UI caps at 3.
  // Each entry must be an http(s) URL (no data: blobs).
  tv_logos: z.array(z.string().url().max(2000)).max(6).optional(),
  // Public-page hero image + accent colour. Hero is normally uploaded
  // after the event is saved (needs an id to namespace the storage
  // path), so these are typically set on the follow-up PUT — but the
  // create schema accepts them too. accent_hex is a 6-digit hex.
  hero_image_url: z.string().url().max(2000).nullable().optional(),
  accent_hex: z.string().regex(/^#[0-9a-fA-F]{6}$/).nullable().optional(),
  // EVENTS-EMAILCFG.1 (mig 385) — per-event styling of the signup
  // confirmation + pre-event reminder emails. subject/intro drop into the
  // shared branded shell (merge-tagged); *_template_id overrides the shell
  // with a full email_templates row. All nullable → NULL = default copy/look
  // (behaviour-preserving). template_ids are org/location-validated below.
  confirmation_email_subject: z.string().max(4000).nullable().optional(),
  confirmation_email_intro: z.string().max(4000).nullable().optional(),
  reminder_email_subject: z.string().max(4000).nullable().optional(),
  reminder_email_intro: z.string().max(4000).nullable().optional(),
  confirmation_email_template_id: uuidLike.nullable().optional(),
  reminder_email_template_id: uuidLike.nullable().optional(),
  // EVENT-COMMS-LOC (mig 553) — the real UN1T location this event's SMS + email
  // send from. In-org non-anchor validated below.
  sending_location_id: uuidLike.nullable().optional(),
  // EVENTS-SMS-TOGGLE (mig 552) — per-event opt-in for the registration SMS
  // confirmation. Optional here; the POST route defaults it to false, so a
  // legacy/default event never texts. The email receipt is separate.
  confirmation_sms_enabled: z.boolean().optional(),
  // Waves (mig 083) — at least one required for a usable race.
  // Server normalises by start_time ascending; UNIQUE on
  // (race_event_id, start_time) catches duplicates from the DB side.
  waves: z.array(WaveInputSchema).max(50).optional(),
}).superRefine((val, ctx) => {
  // Every kind except lead_gen needs a date AND at least one wave.
  // lead_gen is a pure data-capture form: no date, no waves.
  const kind = val.kind ?? 'race'
  if (kind === 'lead_gen') return
  if (!val.race_date) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['race_date'], message: 'Date is required.' })
  }
  if (!val.waves || val.waves.length < 1) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['waves'], message: 'Add at least one wave.' })
  }
})

export async function GET(request) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorised' }, { status: 401 })
  if (!hasPermission(user, 'races')) {
    return NextResponse.json({ success: false, error: 'Events feature is disabled at this location' }, { status: 403 })
  }

  const url = new URL(request.url)
  const filterLocation = url.searchParams.get('location_id')
  if (filterLocation) {
    const guard = assertLocationAccess(user, filterLocation)
    if (guard) return guard
  }
  const activeLocationId = filterLocation || user.activeLocation?.id || null
  if (!activeLocationId) return NextResponse.json({ success: true, data: [] })

  const db = createServerClient()
  // Scope to the active location PLUS any event flagged `shared` (owned by
  // one location, surfaced everywhere) — same rule as the web /events list.
  const { data, error } = await db
    .from('race_events')
    .select(`
      id, name, slug, race_date, start_time, capacity, capacity_mode,
      active, kind, shared, location_id,
      host:event_hosts!host_id ( id, name, organization_id ),
      waves:race_waves ( capacity ),
      registrations:race_registrations ( id, status, team:teams ( size ) )
    `)
    .or(`location_id.eq.${activeLocationId},shared.eq.true`)
    .order('race_date', { ascending: false })
  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 })

  // HOST-EDIT.1 — org admins also see their org's HOST events (which live on
  // the host's own anchor location, not the active studio) so hosted events
  // can be found and edited from /events. Org-scoped, additive, deduped.
  let rows = data || []
  const orgId = user.activeOrganization?.id || user.activeLocation?.organization_id || null
  if (orgId && ADMIN_ROLES.includes(user.role)) {
    const { data: hosted } = await db
      .from('race_events')
      .select(`
        id, name, slug, race_date, start_time, capacity, capacity_mode,
        active, kind, shared, location_id,
        host:event_hosts!host_id ( id, name, organization_id ),
        waves:race_waves ( capacity ),
        registrations:race_registrations ( id, status, team:teams ( size ) )
      `)
      .not('host_id', 'is', null)
      .order('race_date', { ascending: false })
      .limit(200)
    const seen = new Set(rows.map((r) => r.id))
    for (const r of hosted || []) {
      if (!seen.has(r.id) && r.host?.organization_id === orgId) rows.push(r)
    }
  }

  const shaped = rows.map((r) => {
    const isRace = isRaceKind(r.kind)
    return {
      id: r.id,
      name: r.name,
      slug: r.slug,
      kind: r.kind || 'race',
      race_date: r.race_date,
      start_time: r.start_time,
      active: r.active,
      shared: r.shared,
      hosted_by: r.host?.name || null,
      signup_summary: formatSignupSummary(r.registrations, {
        isRace,
        capacity: sumWaveCapacity(r.waves) ?? r.capacity,
        mode: r.capacity_mode,
      }),
    }
  })

  // Upcoming first (nearest date asc), then past (most recent desc). Stamp
  // is_upcoming so the client can render a "Past" divider without doing its
  // own timezone-sensitive date math.
  const { upcoming, past } = orderEventsForBrowse(shaped, todayIsoDublin())
  const ordered = [
    ...upcoming.map((e) => ({ ...e, is_upcoming: true })),
    ...past.map((e) => ({ ...e, is_upcoming: false })),
  ]
  return NextResponse.json({ success: true, data: ordered })
}

export async function POST(request) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorised' }, { status: 401 })
  if (!hasPermission(user, 'races')) {
    return NextResponse.json({ success: false, error: 'Races feature is disabled at this location' }, { status: 403 })
  }

  const validation = await validateBody(request, CreateSchema)
  if (!validation.ok) return validation.response
  const body = validation.data

  const guard = assertLocationAccess(user, body.location_id)
  if (guard) return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 })

  const slug = body.slug || toSlug(body.name)
  if (!slug) {
    return NextResponse.json({
      success: false,
      error: 'Could not derive a valid slug from the name. Provide one explicitly.',
    }, { status: 400 })
  }

  const db = createServerClient()

  // HOST-APPROVALS.1 — slugs are globally unique (public /event/[slug] has
  // no location filter; mig 451 enforces it). Pre-check for a clean 409
  // instead of a raw constraint error.
  const { data: slugClash } = await db.from('race_events').select('id').eq('slug', slug).maybeSingle()
  if (slugClash) {
    return NextResponse.json({
      success: false,
      error: `The URL slug "${slug}" is already used by another event. Pick a different name or slug.`,
    }, { status: 409 })
  }

  // EVENTS-HOST.4 — assigning a payee routes ticket money DIRECTLY to that
  // host's Stripe, so it's gated to the host-management bar (ADMIN_ROLES) —
  // the same level that can create/delete the host itself — not the
  // staff-level 'races' permission that guards ordinary event edits.
  // Internal events (host_id null) stay staff-creatable.
  if (body.host_id && !ADMIN_ROLES.includes(user.role)) {
    return NextResponse.json({ success: false, error: 'Assigning a payment host requires manager access.' }, { status: 403 })
  }

  // EVENTS-HOST.4 — payment-routing security. If the operator assigned a
  // host, verify it's a real event_hosts row in THIS event's organization
  // (resolved from the event's location). Without this, an operator could
  // set host_id to another org's host and route this event's takings to
  // that org's Stripe account (an IDOR on the payout). Rejected BEFORE the
  // insert. host_id NULL/absent = internal UN1T event, no check needed.
  if (body.host_id) {
    const { data: loc } = await db
      .from('locations')
      .select('organization_id')
      .eq('id', body.location_id)
      .single()
    const { data: host } = await db
      .from('event_hosts')
      .select('id, organization_id')
      .eq('id', body.host_id)
      .single()
    if (!loc || !host || host.organization_id !== loc.organization_id) {
      return NextResponse.json({ success: false, error: 'invalid_host' }, { status: 400 })
    }
  }

  // EVENTS-EMAILCFG.1 — email-template IDOR guard. If the operator points
  // this event's confirmation/reminder email at a full email_templates row,
  // that row MUST belong to THIS event's location. Without this, an operator
  // could reference another location's template (leaking its HTML into this
  // event's live transactional emails). NULL/absent = shared shell, no check.
  const emailTemplateIds = [
    body.confirmation_email_template_id,
    body.reminder_email_template_id,
  ].filter(Boolean)
  if (emailTemplateIds.length > 0) {
    const { data: templates } = await db
      .from('email_templates')
      .select('id, location_id')
      .in('id', emailTemplateIds)
    const byId = new Map((templates || []).map((t) => [t.id, t]))
    for (const templateId of emailTemplateIds) {
      const tpl = byId.get(templateId)
      if (!tpl || tpl.location_id !== body.location_id) {
        return NextResponse.json({ success: false, error: 'invalid_template' }, { status: 400 })
      }
    }
  }

  // EVENT-COMMS-LOC (mig 553) — sending-location IDOR guard. The comms
  // identity location must be a real, non-anchor location in THIS event's
  // organization (resolved from the event's location). Without this, an
  // operator could point an event's SMS/email identity at another org's
  // location. NULL/absent = no override, no check needed.
  if (body.sending_location_id) {
    const { data: loc } = await db.from('locations')
      .select('organization_id').eq('id', body.location_id).single()
    const { data: send } = await db.from('locations')
      .select('id, organization_id, is_host_anchor')
      .eq('id', body.sending_location_id).maybeSingle()
    if (!loc || !send || send.is_host_anchor || send.organization_id !== loc.organization_id) {
      return NextResponse.json({ success: false, error: 'invalid_sending_location' }, { status: 400 })
    }
  }

  const { data, error } = await db
    .from('race_events')
    .insert({
      location_id: body.location_id,
      kind: body.kind ?? 'race',
      capacity_mode: body.capacity_mode ?? 'teams',
      staff_required: body.staff_required ?? 1,
      name: body.name,
      slug,
      description: body.description ?? null,
      race_date: body.kind === 'lead_gen' ? null : body.race_date,
      registration_opens_at: body.registration_opens_at ?? null,
      registration_closes_at: body.registration_closes_at ?? null,
      allowed_team_sizes: body.allowed_team_sizes && body.allowed_team_sizes.length > 0
        ? [...body.allowed_team_sizes].sort((a, b) => a - b)
        : [1, 2, 4],
      active: body.active ?? true,
      member_pricing_enabled: body.member_pricing_enabled ?? false,
      members_only: body.members_only ?? false,
      shared: body.shared ?? false,
      // EVENTS-HOST.4 — payment routing. NULL = internal (Revolut).
      host_id: body.host_id ?? null,
      // Only persist member_fee_cents when pricing is on — keeps the
      // table consistent ("if you see member_fee, member pricing is enabled").
      member_fee_cents: (body.member_pricing_enabled && body.member_fee_cents != null) ? body.member_fee_cents : null,
      non_member_fee_cents: body.non_member_fee_cents ?? null,
      payment_currency: body.payment_currency ?? 'EUR',
      tv_logos: Array.isArray(body.tv_logos) ? body.tv_logos : [],
      hero_image_url: body.hero_image_url ?? null,
      accent_hex: body.accent_hex ?? null,
      // EVENTS-EMAILCFG.1 (mig 385) — per-event email config. NULL = default.
      confirmation_email_subject: body.confirmation_email_subject ?? null,
      confirmation_email_intro: body.confirmation_email_intro ?? null,
      reminder_email_subject: body.reminder_email_subject ?? null,
      reminder_email_intro: body.reminder_email_intro ?? null,
      confirmation_email_template_id: body.confirmation_email_template_id ?? null,
      reminder_email_template_id: body.reminder_email_template_id ?? null,
      // EVENTS-SMS-TOGGLE (mig 552) — default OFF; the email receipt is separate.
      confirmation_sms_enabled: body.confirmation_sms_enabled ?? false,
      sending_location_id: body.sending_location_id ?? null,
    })
    .select()
    .single()

  if (error) {
    if (error.code === '23505' || /duplicate key|already exists|unique/i.test(error.message || '')) {
      return NextResponse.json({
        success: false,
        error: `A race with slug "${slug}" already exists at this location.`,
        code: 'duplicate_slug',
      }, { status: 409 })
    }
    return NextResponse.json({ success: false, error: error.message }, { status: 400 })
  }

  // Insert the waves (mig 083). Sorted by start_time so display_order
  // defaults match temporal order if the operator didn't set them.
  // lead_gen events have no waves — skip the whole block.
  const sortedWaves = [...(body.waves || [])].sort((a, b) => (a.start_time || '').localeCompare(b.start_time || ''))
  if (sortedWaves.length === 0) {
    return NextResponse.json({ success: true, data: { ...data, waves: [] } }, { status: 201 })
  }
  const waveRows = sortedWaves.map((w, i) => ({
    race_event_id: data.id,
    start_time: w.start_time,
    capacity: w.capacity ?? null,
    label: w.label ?? null,
    display_order: w.display_order ?? i,
  }))
  const { data: insertedWaves, error: wavesErr } = await db
    .from('race_waves')
    .insert(waveRows)
    .select()
  if (wavesErr) {
    // Roll back the race insert so a failed wave create doesn't leave
    // an orphaned race_event with no waves (which would break public
    // signup). Best-effort delete; the race is unusable either way.
    await db.from('race_events').delete().eq('id', data.id)
    if (wavesErr.code === '23505' || /duplicate/i.test(wavesErr.message || '')) {
      return NextResponse.json({
        success: false,
        error: 'Two waves can\'t share the same start time.',
        code: 'duplicate_wave_time',
      }, { status: 409 })
    }
    return NextResponse.json({ success: false, error: `Race created but waves failed: ${wavesErr.message}` }, { status: 400 })
  }

  return NextResponse.json({ success: true, data: { ...data, waves: insertedWaves } }, { status: 201 })
}
