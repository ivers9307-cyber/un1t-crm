// contact-events — event log + tag rules engine (mig 085).
//
// Two responsibilities:
//
//   1. emitEvent() — append-only insert into contact_events. Caller
//      can pass contact_id (preferred) OR just contact_email; the
//      rules engine supports both. Time-anchored events (race
//      milestones) carry source_type + source_id + a partial-unique
//      index in the schema to keep the cron idempotent.
//
//   2. applyTagRules() — runs the static TAG_RULES registry against
//      the event history for one contact. Each rule decides whether
//      the contact is currently in the tag set; we add/remove tags
//      on contact_tags accordingly. Stateless — safe to call
//      repeatedly (the partial UNIQUE on contact_tags + soft-delete
//      via removed_at make it idempotent).
//
// The rules registry below is deliberately small for v1. Extend by
// adding a rule object; do NOT add per-org rule customisation here
// without a DB-backed registry.

import { logWarn } from './log'

// ─── event-type constants ────────────────────────────────────────

export const EVENT_TYPES = Object.freeze({
  ORDER_CREATED:        'order.created',
  ORDER_COMPLETED:      'order.completed',
  ORDER_FAILED:         'order.failed',
  ORDER_ABANDONED:      'order.abandoned',
  ORDER_RECOVERED:      'order.recovered',
  ORDER_REFUNDED:       'order.refunded',
  RACE_REGISTERED:      'race.registered',
  RACE_CHECKED_IN:      'race.checked_in',
  RACE_STARTED:         'race.started',
  RACE_FINISHED:        'race.finished',
  RACE_NO_SHOW:         'race.no_show',
  RACE_STARTS_IN_24H:   'race.starts_in_24h',
  RACE_STARTS_IN_1H:    'race.starts_in_1h',
  RACE_COMPLETED_24H_AGO: 'race.completed_24h_ago',
  RACE_COMPLETED_7D_AGO:  'race.completed_7d_ago',
  MEMBER_VALIDATED:     'member.validated',
  MEMBER_VALIDATION_FAILED: 'member.validation_failed',
})

// ─── emitEvent ───────────────────────────────────────────────────

/**
 * Append an event to contact_events. Best-effort — never throws up
 * to the caller (event-log failures must not break the originating
 * mutation, which is the source of truth).
 *
 * @param {object} args
 * @param {SupabaseClient} args.db
 * @param {string} args.eventType         from EVENT_TYPES
 * @param {string} args.contactEmail      always required
 * @param {string|null} [args.contactId]
 * @param {string|null} [args.locationId]
 * @param {string|null} [args.sourceType]  e.g. 'race_registration'
 * @param {string|null} [args.sourceId]
 * @param {object|null} [args.metadata]
 * @returns {Promise<{ id: string }|null>}
 */
export async function emitEvent({
  db,
  eventType,
  contactEmail,
  contactId = null,
  locationId = null,
  sourceType = null,
  sourceId = null,
  metadata = null,
}) {
  if (!eventType || !contactEmail) return null
  try {
    const { data, error } = await db
      .from('contact_events')
      .insert({
        contact_id: contactId,
        contact_email: String(contactEmail).toLowerCase().trim(),
        location_id: locationId,
        event_type: eventType,
        event_metadata: metadata,
        source_type: sourceType,
        source_id: sourceId,
      })
      .select('id')
      .single()
    if (error) {
      // Idempotency violation on time-anchored events is expected
      // (cron retries) — silent skip. Other errors get logged.
      if (!/duplicate|unique|23505/i.test(error.message || '')) {
        logWarn('contact-events', 'emit failed', { err: error })
      }
      return null
    }
    return data
  } catch (e) {
    logWarn('contact-events', `emit threw`, { err: e })
    return null
  }
}

// ─── tag rules registry ──────────────────────────────────────────
//
// Each rule object describes:
//   - tag        — the contact_tags.tag string
//   - description — human label for the /segments page
//   - evaluate   — pure function (events) → boolean. Returns true
//                  when the contact SHOULD have the tag.
//
// Rules read the FULL event history for a contact and decide.
// Order doesn't matter; applyTagRules iterates all rules.

export const TAG_RULES = Object.freeze([
  {
    tag: 'race_completed',
    description: 'Has finished at least one race.',
    evaluate(events) {
      return events.some((e) => e.event_type === EVENT_TYPES.RACE_FINISHED)
    },
  },
  {
    tag: 'repeat_racer',
    description: 'Has finished two or more races.',
    evaluate(events) {
      const finished = events.filter((e) => e.event_type === EVENT_TYPES.RACE_FINISHED)
      return finished.length >= 2
    },
  },
  {
    tag: 'race_registered_no_payment',
    description: 'Started a race signup but didn\'t complete payment.',
    evaluate(events) {
      const hasAbandoned = events.some((e) =>
        e.event_type === EVENT_TYPES.ORDER_ABANDONED && e.source_type === 'race_registration'
      )
      const hasCompletedRace = events.some((e) =>
        e.event_type === EVENT_TYPES.ORDER_COMPLETED && e.source_type === 'race_registration'
      )
      return hasAbandoned && !hasCompletedRace
    },
  },
  {
    tag: 'lapsed_payer',
    description: 'A payment failed and was not followed by a successful one within 7 days.',
    evaluate(events) {
      const failed = events.filter((e) => e.event_type === EVENT_TYPES.ORDER_FAILED)
      if (failed.length === 0) return false
      // For each failure, check if a completion exists within 7 days.
      const completions = events.filter((e) => e.event_type === EVENT_TYPES.ORDER_COMPLETED)
      for (const f of failed) {
        const fAt = new Date(f.occurred_at).getTime()
        const recovered = completions.some((c) => {
          const cAt = new Date(c.occurred_at).getTime()
          return cAt >= fAt && cAt - fAt <= 7 * 86400_000
        })
        if (!recovered) return true
      }
      return false
    },
  },
  {
    tag: 'race_starts_soon',
    description: 'Has a race starting in the next 24 hours.',
    evaluate(events) {
      // Time-anchored: tag is "active" only between the 24h emission
      // and the started/finished event. The cron emits 24h-ago for
      // completed races; we use that to expire the tag.
      const last24h = events.filter((e) => e.event_type === EVENT_TYPES.RACE_STARTS_IN_24H).pop()
      if (!last24h) return false
      const sameRaceStarted = events.some((e) =>
        e.event_type === EVENT_TYPES.RACE_STARTED && e.source_id === last24h.source_id
      )
      return !sameRaceStarted
    },
  },
  {
    tag: 'race_recently_completed',
    description: 'Finished a race in the last 24 hours — prime time for follow-up.',
    evaluate(events) {
      const finished = events
        .filter((e) => e.event_type === EVENT_TYPES.RACE_FINISHED)
        .map((e) => new Date(e.occurred_at).getTime())
      if (finished.length === 0) return false
      const mostRecent = Math.max(...finished)
      return Date.now() - mostRecent <= 24 * 3600_000
    },
  },
])

// ─── applyTagRules ───────────────────────────────────────────────

/**
 * Re-evaluate every tag rule for one contact against their full
 * event history. Adds tags whose rule passes; soft-deletes tags
 * whose rule no longer passes (sets removed_at = NOW). Idempotent.
 *
 * @param {object} args
 * @param {SupabaseClient} args.db
 * @param {string} args.contactId
 * @returns {Promise<{ added: string[], removed: string[] }>}
 */
export async function applyTagRules({ db, contactId }) {
  const result = { added: [], removed: [] }
  if (!contactId) return result

  // Pull the contact's location for the contact_tags row scope.
  const { data: contact } = await db
    .from('contacts')
    .select('id, location_id')
    .eq('id', contactId)
    .single()
  if (!contact) return result

  // Pull all events for this contact, time-ascending.
  const { data: events } = await db
    .from('contact_events')
    .select('event_type, occurred_at, source_type, source_id, event_metadata')
    .eq('contact_id', contactId)
    .order('occurred_at', { ascending: true })
    .limit(1000) // hard cap; rules don't need unbounded history

  const eventList = events || []

  // Pull active tags so we know what to leave alone vs add/remove.
  const { data: activeTags } = await db
    .from('contact_tags')
    .select('id, tag')
    .eq('contact_id', contactId)
    .is('removed_at', null)
  const activeByTag = new Map((activeTags || []).map((t) => [t.tag, t]))

  for (const rule of TAG_RULES) {
    const should = !!rule.evaluate(eventList)
    const has = activeByTag.has(rule.tag)
    if (should && !has) {
      const { error } = await db
        .from('contact_tags')
        .insert({
          contact_id: contactId,
          location_id: contact.location_id,
          tag: rule.tag,
        })
      if (!error) result.added.push(rule.tag)
    } else if (!should && has) {
      const row = activeByTag.get(rule.tag)
      await db
        .from('contact_tags')
        .update({ removed_at: new Date().toISOString() })
        .eq('id', row.id)
      result.removed.push(rule.tag)
    }
  }

  return result
}

/**
 * Convenience: emit + apply in one call when the caller has a
 * contact_id available. Use this from order/race state-change code.
 */
export async function emitAndApply(args) {
  await emitEvent(args)
  if (args.contactId) {
    await applyTagRules({ db: args.db, contactId: args.contactId })
  }
}
