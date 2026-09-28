// CRM → Glofox push orchestrator (GLOFOX3.1).
//
// Two patterns the operator chose:
//   1. Always-search-and-link on every CRM contact create — dup
//      prevention so we never have a CRM contact whose email is
//      already in Glofox under a different glofox_member_id.
//   2. Opt-in create-and-trial — only when a booking form / event
//      / manual button explicitly elects to push. Creates a fresh
//      Glofox account with a random initial password, attaches the
//      studio's trial membership, tags the contact for
//      welcome-sequence onboarding. The password is returned ONCE to
//      the caller and never stored (PASSCODEREAD.1, mig 651).
//
// Both paths land an audit row in glofox_push_events.
//
// Source-of-truth contract (per-field):
//   Bidirectional (CRM edit → push to Glofox; Glofox webhook →
//   pull to CRM): first_name, last_name, email, phone, dob
//
//   Glofox-only (read-only in CRM):
//     glofox_membership_status, joined_at, credits, bookings,
//     LTV, recent_bookings
//
//   CRM-only (Glofox doesn't know):
//     lead_status, label, notes, activities, deals, tags

import {
  glofoxCredentialsForLocation,
  searchGlofoxByEmail,
  searchGlofoxMember,
  registerGlofoxMember,
  purchaseGlofoxMembership,
  generateGlofoxPasscode,
} from './glofox.js'
import { applyMemberSync } from './glofox-sync.js'
import { glofoxFetch } from './glofox.js'
import { writeContactTag } from './contact-tags.js'
import { readGlofoxConfig } from './connection-registry.js'
import { logWarn } from './log.js'
import { toMobileE164 } from './phone-validate.js'

// Per-location trial config — what membership + plan to attach
// to a freshly-created Glofox account. Operator picks via the
// LocationForm trial-membership picker.
function getLocationTrialConfig(location) {
  const g = location?.settings?.glofox || {}
  return {
    membershipId: g.trial_membership_id || null,
    planCode:     g.trial_plan_code || null,
  }
}

/**
 * Find-or-create a Glofox member for a CRM contact.
 *
 * @param {object} args
 * @param {SupabaseClient} args.db
 * @param {string} args.locationId
 * @param {object} args.contact      CRM contacts row (must have id, email)
 * @param {string} args.source       'booking_form' | 'event_registration' | 'manual_button' | 'dup_check'
 * @param {boolean} args.createIfMissing  When true, POST /register if no email match.
 *                                         When false, search-and-link only.
 * @param {boolean} args.attachTrial      When true (and we created), purchase the trial membership.
 *                                         Operator-chosen via LocationForm.
 *
 * Returns { status, glofox_member_id, passcode, error, push_event_id }.
 *   status: 'linked' | 'created' | 'skipped' | 'needs_review' | 'failed'
 */
export async function findOrCreateGlofoxMember({
  db, locationId, contact, source,
  createIfMissing = false,
  attachTrial = false,
  trialOverride = null,
}) {
  if (!db || !locationId || !contact?.id || !contact?.email) {
    return { status: 'failed', error: 'missing args (db, locationId, contact.id, contact.email)' }
  }

  // Skip when contact is ALREADY linked — caller probably called
  // us by mistake. Don't double-push.
  if (contact.glofox_member_id) {
    return {
      status: 'skipped',
      glofox_member_id: contact.glofox_member_id,
      error: 'already linked',
    }
  }

  // Resolve credentials.
  const creds = await glofoxCredentialsForLocation(db, locationId)
  if (creds.readError) {
    // REGISTRYREAD.1a: a failed settings read is not "not configured" — the
    // audit row says so, and the admin retry route can re-run it.
    const error = 'Glofox settings could not be read (a temporary database error). Retry this push.'
    const ev = await audit(db, {
      contact_id: contact.id, location_id: locationId, source,
      status: 'failed', error_message: error,
    })
    return { status: 'failed', error, push_event_id: ev?.id }
  }
  if (!creds.branchId || !creds.apiKey || !creds.apiToken) {
    const ev = await audit(db, {
      contact_id: contact.id, location_id: locationId, source,
      status: 'failed', error_message: 'Glofox credentials not configured',
    })
    return { status: 'failed', error: 'Glofox credentials not configured', push_event_id: ev?.id }
  }

  // Step 1 — search-by-email. ALWAYS happens (the dup-prevention
  // contract). Even when createIfMissing=true we want to find
  // and link rather than create-a-duplicate.
  const search = await searchGlofoxByEmail(creds, contact.email)
  if (search.found && search.member?._id) {
    const memberId = String(search.member._id)
    // Multiple matches → flag for operator review (but link to
    // the first one as a best-effort default; operator can re-
    // assign from the Review tab).
    const reviewNeeded = search.error === 'multiple_glofox_matches'
    const linkResult = await linkExistingGlofoxMember({
      db, locationId, contact, creds, glofoxMember: search.member,
    })
    const status = reviewNeeded ? 'needs_review' : 'linked'
    const ev = await audit(db, {
      contact_id: contact.id, location_id: locationId, source,
      status, glofox_member_id: memberId,
      glofox_response: search.allMatches ? { matches: search.allMatches.length } : null,
      error_message: reviewNeeded ? `Multiple Glofox accounts (${search.allMatches?.length}) match this email — linked to the first one, operator review required.` : null,
    })
    return {
      status,
      glofox_member_id: memberId,
      error: reviewNeeded ? 'multiple_glofox_matches' : null,
      push_event_id: ev?.id,
      sync_result: linkResult,
    }
  }

  // Search errored out (network, auth, etc.) → fail hard. Don't
  // create-on-failure (might dup if Glofox came back briefly).
  if (search.error && !search.found) {
    const ev = await audit(db, {
      contact_id: contact.id, location_id: locationId, source,
      status: 'failed', error_message: `Search failed: ${search.error}`,
    })
    return { status: 'failed', error: search.error, push_event_id: ev?.id }
  }

  // Step 2 — no match found.
  if (!createIfMissing) {
    // Dup-check-only mode (the always-on path). Nothing to do.
    const ev = await audit(db, {
      contact_id: contact.id, location_id: locationId, source,
      status: 'skipped', error_message: 'No email match in Glofox; create-if-missing was off',
    })
    return { status: 'skipped', push_event_id: ev?.id }
  }

  // Step 2.5 — GLOFOX-SPEC-2026-09: phone dup-check before the mint. A
  // returner who fills the public form with a NEW email is invisible to
  // the email search above, and this is the exact spot where their second
  // Glofox account (and second free trial) was born. The namespace search
  // can now match on the member's normalised mobile, so ask. A hit is
  // evidence a person already exists, which blocks the mint — but it is
  // NEVER a link: couples share numbers (PERSON-ACCT.9), so trusting a
  // phone-only match books person B's class on person A's account. Staff
  // decide from the Review tab. A search failure halts like the email
  // search's does: never create-on-failure.
  if (toMobileE164(contact.phone || '')) {
    const byPhone = await searchGlofoxMember(creds, { phone: contact.phone })
    if (byPhone.error && !byPhone.found) {
      const ev = await audit(db, {
        contact_id: contact.id, location_id: locationId, source,
        status: 'failed', error_message: `Phone search failed: ${byPhone.error}`,
      })
      return { status: 'failed', error: byPhone.error, push_event_id: ev?.id }
    }
    if (byPhone.found) {
      const matches = byPhone.allMatches?.length || 1
      const ev = await audit(db, {
        contact_id: contact.id, location_id: locationId, source,
        status: 'needs_review',
        glofox_response: { phone_matches: matches, glofox_member_ids: (byPhone.allMatches || [byPhone.member]).map((m) => String(m?._id || m?.id || '')) },
        error_message: `No Glofox account matches this email, but ${matches === 1 ? 'an account already holds' : `${matches} accounts already hold`} this mobile number — not created and not linked (a shared number may be a partner). Link or create from the Review tab.`,
      })
      return { status: 'needs_review', error: 'phone_match_no_link', push_event_id: ev?.id }
    }
  }

  // Step 3 — create a fresh Glofox account. Generate a passcode
  // first (the initial password; returned once to the caller, never
  // stored or emailed: PASSCODEREAD.1).
  if (!contact.first_name || !contact.last_name) {
    const ev = await audit(db, {
      contact_id: contact.id, location_id: locationId, source,
      status: 'failed',
      error_message: `Cannot register on Glofox without first_name + last_name (have first=${contact.first_name || 'null'}, last=${contact.last_name || 'null'})`,
    })
    return { status: 'failed', error: 'missing first_name or last_name', push_event_id: ev?.id }
  }
  const passcode = generateGlofoxPasscode()
  const reg = await registerGlofoxMember(creds, {
    first_name: contact.first_name,
    last_name: contact.last_name,
    email: contact.email,
    phone: contact.phone || undefined,
    birth: contact.dob || undefined,
    password: passcode,
    lead_status: 'LEAD',
  })
  if (!reg.ok || !reg.member?._id) {
    const ev = await audit(db, {
      contact_id: contact.id, location_id: locationId, source,
      status: 'failed',
      error_message: `Register failed: ${reg.error || 'unknown'}`,
      glofox_response: reg.glofox_response,
    })
    return { status: 'failed', error: reg.error, push_event_id: ev?.id }
  }
  const newGlofoxId = String(reg.member._id)

  // Step 4 — write the link to the CRM contact row immediately
  // (before the trial purchase) so even if the membership write
  // fails, we don't leave the contact unlinked.
  // PASSCODEREAD.1: the password is NOT written here. GLOFOX3.5 stored it on
  // contacts.glofox_passcode for a welcome email that was never switched on,
  // and every staff member at the location could read it from their own
  // session. Mig 651 CHECKs the column NULL, so writing it now fails the link.
  const { error: linkErr } = await db.from('contacts').update({
    glofox_member_id: newGlofoxId,
    glofox_synced_at: new Date().toISOString(),
  }).eq('id', contact.id)
  if (linkErr) {
    // The Glofox member exists but the CRM link write failed — don't
    // swallow it and proceed (that leaves a created-but-unlinked contact
    // and pushes a trial onto an unlinked row). Surface for operator
    // review; the next search-by-email run re-links without duplicating.
    console.warn('[glofox-push] CRM link write after create failed:', linkErr.message)
    const ev = await audit(db, {
      contact_id: contact.id, location_id: locationId, source,
      status: 'needs_review', glofox_member_id: newGlofoxId,
      error_message: `Glofox member created but CRM link write failed: ${linkErr.message}`,
    })
    return { status: 'needs_review', glofox_member_id: newGlofoxId, error: linkErr.message, push_event_id: ev?.id }
  }

  // Step 5 — optional trial-membership purchase. Per-location
  // config; if not set, skip with a warning.
  let trialPurchaseError = null
  if (attachTrial) {
    // INTEG-A2 dual-read: registry row first, legacy settings.glofox
    // otherwise — same settings-shaped object either way.
    // Per-funnel override (from the class_funnel block, captured on the booking
    // row) wins over the location default when BOTH ids are present.
    let trial = null
    let trialReadFailed = false
    if (trialOverride?.membershipId && trialOverride?.planCode) {
      trial = { membershipId: trialOverride.membershipId, planCode: trialOverride.planCode }
    } else {
      const { cfg, error: cfgErr } = await readGlofoxConfig(db, locationId)
      if (cfgErr) trialReadFailed = true
      else trial = getLocationTrialConfig({ settings: { glofox: cfg } })
    }
    if (trialReadFailed) {
      // REGISTRYREAD.1a: the member now exists and the contact is linked, so
      // a retry of this push would skip ("already linked"). Say what to do.
      logWarn('glofox-push', 'trial settings unreadable after create', { contactId: contact.id, locationId })
      trialPurchaseError = 'Could not read the trial membership settings (a temporary database error), so no trial was attached. Attach it in Glofox by hand.'
    } else if (!trial.membershipId || !trial.planCode) {
      trialPurchaseError = 'Trial membership not configured for this location (Settings → Locations → Glofox Integration → Trial membership picker)'
    } else {
      const purchase = await purchaseGlofoxMembership(creds, newGlofoxId, trial.membershipId, trial.planCode)
      if (!purchase.ok) {
        trialPurchaseError = `Trial membership purchase failed: ${purchase.error}`
      }
    }
  }

  // Step 6 — fire the welcome-sequence trigger via tag. The
  // welcome sequence template (GLOFOX3.5) listens for
  // 'glofox_account_created' (it no longer carries a password:
  // PASSCODEREAD.1).
  // writeContactTag is idempotent AND fires the tag_added
  // sequence trigger — earlier versions of this code wrote the
  // tag directly to contact_tags but never called the trigger,
  // so an activated welcome sequence wouldn't have actually
  // enrolled the contact (GLOFOX4.1 fix).
  await writeContactTag(db, {
    contactId: contact.id,
    locationId,
    tag: 'glofox_account_created',
  })

  const status = trialPurchaseError ? 'needs_review' : 'created'
  const ev = await audit(db, {
    contact_id: contact.id, location_id: locationId, source,
    status, glofox_member_id: newGlofoxId,
    glofox_response: reg.glofox_response,
    error_message: trialPurchaseError,
  })

  // Pull the new Glofox state into CRM via the existing
  // applyMemberSync flow — populates membership status, joined_at,
  // booking aggregates etc. for the new contact.
  let syncResult = null
  try {
    // Re-fetch the member from Glofox via /2.0/members/{id}
    // to get the canonical post-purchase shape.
    const r = await glofoxFetch(creds, `/2.0/members/${encodeURIComponent(newGlofoxId)}`)
    if (r.ok) {
      const body = await r.json()
      const fullMember = body?.data || body?.member || body
      syncResult = await applyMemberSync(db, locationId, fullMember, { creds })
    }
  } catch (e) {
    console.warn('[glofox-push] post-create sync threw:', e?.message)
  }

  return {
    status,
    glofox_member_id: newGlofoxId,
    passcode,
    push_event_id: ev?.id,
    error: trialPurchaseError,
    sync_result: syncResult,
  }
}

/**
 * Link an existing Glofox member to a CRM contact (write the
 * glofox_member_id) AND immediately pull their full state via the
 * existing applyMemberSync flow. This way the contact lights up
 * with all the Glofox data (membership status, credits, bookings,
 * etc.) on the very next page render — no waiting for the cron.
 */
async function linkExistingGlofoxMember({ db, locationId, contact, creds, glofoxMember }) {
  // Write the link (idempotent — safe to re-run).
  const { error: linkErr } = await db.from('contacts').update({
    glofox_member_id: String(glofoxMember._id),
    glofox_synced_at: new Date().toISOString(),
  }).eq('id', contact.id)
  if (linkErr) {
    console.warn('[glofox-push] existing-member CRM link write failed:', linkErr.message)
    return { error: `link write failed: ${linkErr.message}` }
  }
  // Then fully sync from Glofox so the contact is populated.
  // Uses the canonical /2.0/members/{id} fetch via applyMemberSync
  // so credits, bookings, interactions etc. all land.
  try {
    const r = await glofoxFetch(creds, `/2.0/members/${encodeURIComponent(glofoxMember._id)}`)
    if (r.ok) {
      const body = await r.json()
      const fullMember = body?.data || body?.member || body
      return await applyMemberSync(db, locationId, fullMember, { creds })
    }
  } catch (e) {
    return { error: e?.message || 'sync after link threw' }
  }
  return null
}

/**
 * SINGLEERR.1 — write the fire-and-forget audit row, and LOG any failure.
 *
 * Best-effort means "never fail the push", not "never tell anyone" (the
 * reportRpc convention in postmark-webhook-processor). Both failure channels
 * have to be covered: supabase-js builders are thenables with no .catch, so the
 * await needs a try/catch, AND a PostgREST/Postgres error arrives in the RESULT
 * object rather than as a throw. This used to destructure `data` alone, so a
 * rejected insert returned null and said nothing — every caller then reported
 * `push_event_id: undefined` for an audit row that was never written.
 */
async function audit(db, row) {
  try {
    const { data, error } = await db.from('glofox_push_events').insert(row).select('id').single()
    if (error) {
      logWarn('glofox-push', 'audit insert failed', {
        err: error, contactId: row.contact_id, locationId: row.location_id, status: row.status,
      })
      return null
    }
    return data
  } catch (e) {
    logWarn('glofox-push', 'audit insert threw', {
      err: e, contactId: row.contact_id, locationId: row.location_id, status: row.status,
    })
    return null
  }
}
