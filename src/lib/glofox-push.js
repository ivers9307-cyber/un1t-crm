// CRM → Glofox push orchestrator (GLOFOX3.1).
//
// Two patterns the operator chose:
//   1. Always-search-and-link on every CRM contact create — dup
//      prevention so we never have a CRM contact whose email is
//      already in Glofox under a different glofox_member_id.
//   2. Opt-in create-and-trial — only when a booking form / event
//      / manual button explicitly elects to push. Creates a fresh
//      Glofox account, attaches the studio's trial membership,
//      generates a one-time passcode, tags the contact for
//      welcome-sequence onboarding.
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
  registerGlofoxMember,
  purchaseGlofoxMembership,
  generateGlofoxPasscode,
} from './glofox.js'
import { applyMemberSync } from './glofox-sync.js'
import { glofoxFetch } from './glofox.js'

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

  // Step 3 — create a fresh Glofox account. Generate a passcode
  // first (used as the initial password + emailed to the member
  // for first-login).
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
  await db.from('contacts').update({
    glofox_member_id: newGlofoxId,
    glofox_synced_at: new Date().toISOString(),
  }).eq('id', contact.id)

  // Step 5 — optional trial-membership purchase. Per-location
  // config; if not set, skip with a warning.
  let trialPurchaseError = null
  if (attachTrial) {
    const { data: location } = await db
      .from('locations')
      .select('settings')
      .eq('id', locationId)
      .maybeSingle()
    const trial = getLocationTrialConfig(location)
    if (!trial.membershipId || !trial.planCode) {
      trialPurchaseError = 'Trial membership not configured for this location (Settings → Locations → Glofox Integration → Trial membership picker)'
    } else {
      const purchase = await purchaseGlofoxMembership(creds, newGlofoxId, trial.membershipId, trial.planCode)
      if (!purchase.ok) {
        trialPurchaseError = `Trial membership purchase failed: ${purchase.error}`
      }
    }
  }

  // Step 6 — fire the welcome-sequence trigger via tag. We tag
  // 'glofox_account_created' (which the welcome sequence template
  // listens for). The operator-edited welcome sequence template
  // can include {{passcode}} as a merge tag.
  await db.from('contact_tags').insert({
    contact_id: contact.id,
    location_id: locationId,
    tag: 'glofox_account_created',
  })

  // Stash the passcode on the contact temporarily (the welcome
  // sequence email reads it, then it's cleared after first use OR
  // after a 30-day TTL — TODO follow-up). For now, just store it
  // on the audit row + via the welcome-sequence merge tag system.

  const status = trialPurchaseError ? 'needs_review' : 'created'
  const ev = await audit(db, {
    contact_id: contact.id, location_id: locationId, source,
    status, glofox_member_id: newGlofoxId,
    glofox_response: reg.glofox_response,
    error_message: trialPurchaseError,
    passcode_sent: passcode,
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
  await db.from('contacts').update({
    glofox_member_id: String(glofoxMember._id),
    glofox_synced_at: new Date().toISOString(),
  }).eq('id', contact.id)
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

async function audit(db, row) {
  try {
    const { data } = await db.from('glofox_push_events').insert(row).select('id').single()
    return data
  } catch (e) {
    console.warn('[glofox-push] audit insert failed:', e?.message)
    return null
  }
}
