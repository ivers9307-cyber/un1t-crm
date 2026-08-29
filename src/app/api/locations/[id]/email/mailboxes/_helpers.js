// EMAIL-MAILBOX-ADMIN.1 — shared gate + loaders for the mailbox admin routes.
//
// WHY THIS FILE EXISTS
// mig 485 built a two-level access model — the `email_inbox` permission gates
// the SURFACE, a row in email_mailbox_access gates each ACCOUNT — and shipped
// it with no write surface at all. These routes are that write surface, and
// the gate on them is the entire security question of the feature:
//
//   A MANAGER HOLDS `email_inbox`. A manager is NOT elevated.
//
// So gating these routes on the same key the inbox uses would let a manager
// grant themselves `accounts@` and read the studio's billing correspondence —
// the precise thing the per-account model exists to prevent. The gate is
// therefore master-or-owner-AT-THIS-LOCATION, delegated to guardMasterOrOwner,
// which is the same definition isElevatedAtLocation uses to decide who needs
// no grant rows. One definition of "elevated": whoever bypasses grants is
// exactly whoever may issue them.
//
// These are service-role routes, so RLS does nothing (mig 485's RESTRICTIVE
// deny-write policies bind `authenticated`/`anon`, never the service key).
// The checks here ARE the gate.

import { NextResponse } from 'next/server'
import { assertLocationAccess, guardMasterOrOwner } from '@/lib/auth'

// There is no `select('*')` on email_mailboxes anywhere — every read site
// names its columns — so a column added by a migration stays INVISIBLE to the
// API until a constant like this one is edited. `ingress`/`egress` arrived
// with mig 572 (MAILBOX-CONNECT.2) carrying NOT NULL DEFAULT 'postmark', so
// nothing broke when they landed; they are added here because the settings
// card renders the connection state chip straight off the mailbox list rather
// than firing a second request per account. Leaving them out is this repo's
// "the column exists and nothing reads it" outcome.
// (RETIRE-TICKETS.1 — `surface` and MAILBOX_SURFACES left this list when the
// mig-575 A/B ended; mig 578 deprecated the column and nothing reads it.)
export const MAILBOX_COLUMNS =
  'id, location_id, address, label, is_default, active, created_at, ingress, egress'

// A studio runs a handful of accounts and employs a few dozen people, but
// every .select() caps at 1,000 rows whatever the caller asks for — so the
// bounds are stated rather than left implicit.
export const MAILBOX_LIMIT = 200

// PHASE 11.1 — how many accounts ONE LOCATION may have CONNECTED at once.
//
// Distinct from MAILBOX_LIMIT above, which is a .limit() sized against the
// 1,000-row select cap and caps nothing in practice. This one is a real
// tenancy rule, and it is about the SHARED CRON: every connected mailbox is an
// IMAP session, a body download per message and an attachment upload per file,
// every five minutes, out of one wall-clock budget. The poller degrades
// gracefully under load rather than failing — which is exactly why a runaway
// tenant would otherwise just make everyone else's mail slower, silently.
//
// 12 is deliberately generous against observed use: a studio runs a handful
// (studio@, accounts@, sales@, info@). It is a backstop against a mistake or an
// import gone wrong, not a commercial tier — raising it is a one-line change
// and the refusal says so, so nobody has to guess whether they hit a bug.
export const MAX_CONNECTED_MAILBOXES_PER_LOCATION = 12
export const STAFF_LIMIT = 500
export const GRANT_LIMIT = 1000

/**
 * The management gate: at this location AND elevated here.
 *
 * ORDER MATTERS. assertLocationAccess runs first so an owner of a DIFFERENT
 * studio is told "not one of your locations" rather than a role complaint
 * that would confirm the location exists and imply they nearly qualified.
 *
 * @returns {NextResponse|null} null = allowed
 */
export function guardMailboxAdmin(user, locationId) {
  const locationGuard = assertLocationAccess(user, locationId)
  if (locationGuard) return locationGuard
  const roleGuard = guardMasterOrOwner(user, locationId)
  if (roleGuard) {
    // guardMasterOrOwner's stock copy is generic. A manager WILL hit this —
    // they hold email_inbox and can see the tickets — so say what the rule is
    // and who to ask, rather than "Master or owner role required."
    return NextResponse.json({
      success: false,
      error: 'Only an owner of this studio (or a master admin) can manage email accounts and who may read them.',
    }, { status: 403 })
  }
  return null
}

/** Shared 401. */
export function mailboxUnauthorized() {
  return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
}

/**
 * One mailbox at this location, or the 404 that says it is not there.
 *
 * 404, never 403, and scoped by location_id in the same query: a mailbox id
 * belonging to another studio must be indistinguishable from one that does
 * not exist, or the ids become enumerable and the set of addresses another
 * studio runs becomes discoverable one 403 at a time.
 *
 * @returns {{ response: NextResponse } | { mailbox: object }}
 */
export async function loadMailboxOr404(db, locationId, mailboxId) {
  const { data, error } = await db.from('email_mailboxes')
    .select(MAILBOX_COLUMNS)
    .eq('id', mailboxId)
    .eq('location_id', locationId)
    .maybeSingle()
  // A malformed id is a Postgres cast error (22P02), not a row — same 404.
  if (error || !data) {
    return { response: NextResponse.json({ success: false, error: 'Not found' }, { status: 404 }) }
  }
  return { mailbox: data }
}

/**
 * The staff roster at a location — per-location role plus the estate-level
 * profiles.role, which is what makes someone a master.
 *
 * Two queries rather than a `profiles(...)` embed: the embed shape is one of
 * the repo's documented traps, and the access editor only needs a name, an
 * email and two roles.
 *
 * Deactivated profiles are dropped — they cannot sign in, so listing them as
 * grantable is noise. Any grant rows they already hold are left untouched.
 *
 * @returns {{ staff: Array } | { error: object }}
 */
export async function loadStaffAtLocation(db, locationId) {
  const { data: links, error } = await db.from('profile_locations')
    .select('profile_id, role')
    .eq('location_id', locationId)
    .limit(STAFF_LIMIT)
  if (error) return { error }

  const ids = [...new Set((links || []).map(l => l.profile_id).filter(Boolean))]
  if (ids.length === 0) return { staff: [] }

  const { data: profiles, error: pErr } = await db.from('profiles')
    .select('id, full_name, email, role, active')
    .in('id', ids)
    .limit(STAFF_LIMIT)
  if (pErr) return { error: pErr }

  const byId = new Map((profiles || []).map(p => [p.id, p]))
  const staff = (links || []).map(l => {
    const p = byId.get(l.profile_id)
    if (!p || p.active === false) return null
    return {
      profile_id: l.profile_id,
      full_name: p.full_name || null,
      email: p.email || null,
      role: l.role || null,
      profile_role: p.role || null,
    }
  }).filter(Boolean)

  return { staff }
}
