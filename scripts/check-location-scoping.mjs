#!/usr/bin/env node
// Location-scoping presence lint (SAAS-9, sibling of check-route-guards.mjs).
//
// Fails CI when an /api route — or, since PAGE-SCOPE.1, an app-dir server
// page — queries a location_id-bearing table with no detectable tenant
// scoping. Every route runs createServerClient() (service role — RLS
// bypassed), so an authenticated-but-unscoped
// `.from('contacts').select(...)` serves ANY tenant's rows to whoever passes
// the auth guard. That's the exact class SAAS-1..5 kept finding by hand
// (assistant executeTool cross-tenant reads, bare-id template fetches);
// this makes it structural. Server pages are the same surface: TPL-IDOR.1
// (the /email/templates/[id] + /whatsapp/templates/[id] editor IDOR, 2026-08
// comms audit) shipped precisely because only src/app/api was scanned —
// src/app/**/page.js files that call createServerClient() are now classified
// too (pages without it are skipped: client/API-fed pages query through
// guarded routes or the RLS-bound browser client).
//
// Model (token-presence heuristic, same spirit as check-route-guards):
//   1. The set of tenant tables is DERIVED from supabase/migrations at
//      runtime — any table that gains a location_id column via CREATE TABLE
//      or ALTER TABLE ... ADD COLUMN is in scope, so new tables are covered
//      automatically. TABLE_EXCLUDE removes tables where location_id is
//      genuinely not the tenant boundary (reason mandatory).
//   2. /api/cron/** is exempt by path — cron routes are CRON_SECRET-gated
//      (enforced by check:route-guards) and fan out across ALL tenants by
//      design; a location filter there would be a bug, not a fix.
//   3. Every other route.js that queries a tenant table must show evidence
//      of scoping, either:
//        - in the query chain itself (.eq/.in/.filter on location_id /
//          organization_id, incl. embedded 'block.location_id' forms, or an
//          inline insert/update payload carrying location_id), or
//        - anywhere in the handler file (detached-builder filters like
//          `q = q.eq('location_id', …)`, assertLocationAccess[Or404],
//          assertOrganizationAccess*, org key scoping via assertRowInOrg /
//          orgScopeLocationIds / orgLocationIds, applyAudienceFilter, or a
//          SCOPING_HELPERS call — a helper VERIFIED to take/apply the
//          tenant scope internally).
//   4. EXEMPT maps route → table → mandatory reason for the residue:
//      webhooks that resolve tenant from provider identifiers, master-only
//      admin surfaces, capability-token routes where the token IS the
//      scope, per-user tables where the owner check is the boundary — and
//      'TODO-LEAK:' entries for real findings awaiting their own fix PR.
//
// This is a tripwire, not a prover: it catches "queried a tenant table with
// ZERO tenant scoping anywhere in the handler" (the shipped bug class). It
// does NOT prove that a file which scopes table A also scopes table B, nor
// that the filter uses the RIGHT location id. Listing a helper in
// SCOPING_HELPERS asserts you've READ it and it scopes internally — don't
// add names blind.
//
// Known gap (PAGE-SCOPE.1, checked and empty as of 2026-08-09): a page that
// reads tenant rows ONLY through a src/lib helper which makes its own
// service-role client is skipped, since the page itself never names
// createServerClient. Audited at the time: the only such data-reading
// delegates were tenant-privacy.js (filters organization_id),
// landing-logo.js (public_path — public marketing content) and policies.js
// (policies/policy_versions/policy_views carry NO location_id — estate-wide
// staff policies, so they aren't tenant tables at all). @/lib/auth's
// internal client is the auth lookup itself, not a tenant read. If you add
// a lib that fetches tenant rows on its own client, scope it there and add
// it to SCOPING_HELPERS.

import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const API_ROOT = 'src/app/api'
const APP_ROOT = 'src/app'
const MIGRATIONS_ROOT = 'supabase/migrations'

// ---------------------------------------------------------------------------
// Tables where a location_id column exists but is NOT the tenant boundary a
// route must filter by. Reason is mandatory. Keep this SHORT — prefer EXEMPT
// (per-route) over excluding a whole table.
// ---------------------------------------------------------------------------
export const TABLE_EXCLUDE = {
  usage_events:
    "AI-usage metering (SAAS4-M1) — rows are written by anthropicMessages() with the caller's location; read surface is the master-only usage dashboard which aggregates cross-tenant by design.",
  usage_rollups_daily:
    'Aggregate of usage_events — same master-only metering surface, cross-tenant by design.',
  tenant_heartbeats:
    'Per-tenant cron-health rows (SAAS4-O1) written by system code paths; read surface is master-only monitoring, cross-tenant by design.',
  webhook_dead_letter:
    'System capture table — rows are written by webhook error paths (location is metadata, not the read boundary) and only read by master-only ops tooling.',
  password_overrides_audit:
    'Security audit trail — written on master password-override, read only by master-only audit surfaces; location_id is context metadata.',
}

// ---------------------------------------------------------------------------
// Helpers VERIFIED to apply tenant scoping internally. Each entry names the
// file where it was read. A call to one of these anywhere in the route file
// counts as file-level evidence.
// ---------------------------------------------------------------------------
const SCOPING_HELPERS = [
  // src/lib/auth.js — 403/404 guards on the caller's allowed location set.
  'assertLocationAccess(',
  'assertLocationAccessOr404(',
  'assertOrganizationAccess(',
  'assertOrganizationAccessOr404(',
  'assertOrganizationAdmin(',
  'guardMasterOrOwner(',
  'getUserLocationIds(',
  // src/lib/api-auth.js — per-org API-key scoping (APIKEYS.3): row/create
  // checks + org→location expansion used to .in('location_id', …).
  'assertRowInOrg(',
  'assertCreateInOrg(',
  'orgScopeLocationIds(',
  'orgLocationIds(',
  // src/app/api/email/tickets/_helpers.js — EMAIL-TICKET.4's two-level gate.
  // loadTicketForUser runs assertLocationAccessOr404 on the ticket's own
  // location AND requires the ticket's mailbox to be in the caller's visible
  // set; loadVisibleMailboxes builds that set with .eq('location_id', …) plus
  // the caller's email_mailbox_access grants, and a NULL-mailbox ticket is
  // elevated-only. Rows derived from the returned ticket — email_inbox_messages
  // by ticket_id, contacts by the ticket's own contact_id — inherit that
  // scoping, which is why the handlers look unscoped in isolation.
  'loadTicketForUser(',
  'loadVisibleMailboxes(',
  // src/app/api/email/tickets/_helpers.js — the SEND-AS gate (EMAIL-OUTBOUND
  // -ATTACH.1), extracted verbatim from the compose route. Reads the named
  // mailbox row, then runs assertLocationAccessOr404 at THAT mailbox's
  // location, then hasPermissionForLocation('email_inbox') there, then requires
  // the mailbox to come back from loadVisibleMailboxes — and returns THAT row,
  // never the caller's id. The location a caller may write to is the one it
  // hands back, which is why the handlers that use it look unscoped in
  // isolation.
  'loadSendingMailbox(',
  // src/lib/audience-filter.js — every send audience goes through the
  // whitelist filter, which applies the location scope with the audience.
  'applyAudienceFilter(',
  // src/lib/customer-auth.js — resolves the member's OWN contacts row from
  // their Supabase JWT; everything after is scoped to that contact.
  'resolveCustomerContact(',
  // src/lib/host-auth.js — resolves session → host_users → event_hosts and
  // 401s for non-hosts; reads are scoped to host.id (HOST-PORTAL.1).
  'getCurrentHost(',
  // src/app/api/invoices-inbox/_helpers.js — getCurrentUser + master/owner-
  // at-location + invoice fetched via its location (401/403/404).
  'loadInvoiceForUser(',
  // src/app/api/accounting/coverage/[id]/_line.js — permission check +
  // active-location scoping + 404-not-403 line lookup.
  'loadLineForUser(',
  // src/app/api/invoices-inbox/_bulk-helpers.js — bookkeeper permission +
  // per-row location checks on the bulk surface.
  'loadBookkeeper(',
  // src/lib/permissions.js — permission check evaluated AT a specific
  // location (the fetch-row-then-check-its-location approvals pattern).
  'hasPermissionForLocation(',
  // src/lib/auth.js — org ids the caller OWNS; used for
  // row.organization_id membership compares (contracts revoke/detail).
  'getOwnerOrganizationIds(',
  // src/lib/hosts.js — loads an event host and returns null unless
  // host.organization_id === orgId (events review surface).
  'loadHostForOrg(',
  // src/lib/bridge-auth.js — sha256 bearer resolved against ble_bridges;
  // the bridge row (its location) IS the tenant scope for /api/bridge/*.
  'verifyBridgeToken(',
  // src/lib/studio-devices.js — device token hash-matched against
  // unrevoked studio_devices; the token IS the credential + scope.
  'findDeviceByToken(',
  // src/lib/ac-devices.js — loads the AC device, then checks the caller's
  // profile_locations row AT device.location_id via authoriseDevice.
  'loadDeviceForUser(',
  // src/lib/member-validation.js — contacts lookup hard-scoped
  // .eq('location_id', locationId) + membership-stage check.
  'validateMemberByEmail(',
  // src/lib/race-contact-linking.js — find-or-create scoped to the given
  // location (public callers pass restrictToLocation so a bare email can
  // never resolve a cross-location contact).
  'findOrCreateRaceContact(',
]

// Raw filter evidence anywhere in the file — covers the detached-builder
// idiom (`let q = db.from(t).select(); q = q.eq('location_id', loc)`) and
// embedded-resource filters (`.eq('block.location_id', …)`). Also accepts
// organization_id: org-scoped surfaces (orgs sit ABOVE locations) are a
// tenant boundary too.
const RAW_FILTER_EVIDENCE =
  /\.(?:eq|neq|in|is|not|filter|contains|containedBy|overlaps)\(\s*['"`](?:[A-Za-z0-9_]+\.)*(?:location_id|organization_id)['"`]/

// .or('location_id.eq.x,…') / .or(`organization_id.in.(...)`) string forms.
const OR_FILTER_EVIDENCE = /\.or\(\s*['"`][^'"`]*(?:location_id|organization_id)\./

// .match({ location_id: … }) object form.
const MATCH_FILTER_EVIDENCE = /\.match\(\s*\{[^}]*\b(?:location_id|organization_id)\b/

// Inline write payload carrying the tenant column ({ location_id: … } inside
// the chain text — insert/upsert/update with a literal object).
const WRITE_PAYLOAD_EVIDENCE = /\b(?:location_id|organization_id)\s*:/

// Capability-token row resolution — the chain (or file) filters on a column
// ending in `token` (.eq('unsubscribe_token', …), .eq('deposit_token', …),
// .eq('view_token', …), .eq('token', …)). The unguessable token IS the
// tenant scope; follow-up queries key off the token row's FKs.
const TOKEN_LOOKUP_EVIDENCE = /\.eq\(\s*['"][a-z_]*token['"]\s*,/

// Master-only gate — the route 403s everyone but the platform master, so
// operating cross-tenant is its job (admin surfaces, pairing screens).
const MASTER_GATE_EVIDENCE = [
  'requireMaster(',
  /(?:profileRole|user\.role)\s*[!=]==?\s*['"]master['"]/,
  /!user\.isMaster\b/,
]

// Owner-row boundary — per-user tables (contracts, expense claims,
// contractor invoices, mobile prefs) where the row's person-FK is compared
// to (or filtered by) the AUTHENTICATED user's id. Stronger than location.
const OWNER_SCOPE_EVIDENCE = [
  /\.(?:profile_id|submitter_id|contractor_id|user_id)\s*[!=]==?\s*user\.id\b/,
  /\.eq\(\s*['"](?:profile_id|submitter_id|contractor_id|user_id)['"]\s*,\s*user\.id\b/,
]

// Fetch-by-pk-then-compare — the handler reads row.location_id and compares
// it against the caller's location(s):
//   contact.location_id !== locationId
//   userLocIds.includes(row.location_id) / userLocIds.has(row.location_id)
const LOCATION_COMPARE_EVIDENCE = [
  /\.location_id\s*[!=]==?/,
  /\.includes\((?:[\w$]+\.)*location_id\)/,
  /\.has\((?:[\w$]+\.)*location_id\)/,
]

// ---------------------------------------------------------------------------
// EXEMPT — route → { table → reason }. Reason is mandatory; 'TODO-LEAK:'
// prefixes mark REAL unscoped findings that need their own fix PR (kept
// here so the check can land without smuggling fixes in — see SAAS-9).
// Stale entries (file gone, or file no longer querying that table) fail the
// lint so the map can't rot.
// ---------------------------------------------------------------------------
export const EXEMPT = {
  // ——— SAAS-9 triage (2026-07-19). Category (b) = cross-tenant/public by
  // design; TODO-LEAK = real finding, needs its own fix PR. ———

  'src/app/api/admin/backfill-host-contacts/route.js': {
    race_events:
      'Master/owner-gated one-off admin backfill that walks EVERY hosted event to link host contacts at each host\'s anchor location — hosted-events hosts are a platform-level surface, and the route returns counts only (no tenant rows).',
  },
  'src/app/api/public/start-prefill/route.js': {
    contacts:
      'STARTPREFILL.1 — public booking-form prefill. The contacts row is reached ONLY via an HMAC-signed, time-limited capability token that names exactly one contact id (src/lib/start-prefill-token.js); there is no session and therefore no tenant to scope to, so the capability IS the scoping — the same argument as /api/unsubscribe/[token] and hr-emails above. Verified in src/lib/start-prefill-token.test.js: a forged, tampered, expired, expiry-less or wrong-secret token all resolve to null before this query is reached. The response is narrowed to the four fields the booking form has inputs for, and every failure returns an identical 404 so token validity cannot be probed.',
  },
  'src/app/api/preferences/hr-emails/route.js': {
    contacts:
      'Public one-click HR-email unsubscribe. The contacts row is reached ONLY via a resolved per-contact capability (contact_preferences.unsubscribe_token, or the legacy contact+session pair whose session must belong to that contact), which names exactly one contact — the capability IS the scoping, exactly as on /api/unsubscribe/[token] (HRPREF-AUTH.1). Was genuinely unscoped before: it took a bare contact id.',
    contact_preferences:
      'Token lookup that resolves the capability to its one contact. Scoped by the token itself.',
    heart_rate_sessions:
      'Legacy-link second factor: the session must exist AND name the same contact the link claims. Read-only, two columns, no rows returned to the caller.',
  },

  // Public catalog surfaces — the slug/public_path IS the published public
  // identifier; the row is content the tenant chose to publish. Guards
  // are .eq(slug)+active flags, not tenant filters.
  'src/app/api/public/bookings/[slug]/route.js': {
    event_types: 'Public booking page: event_types row resolved by its published slug + active=true — published content by design.',
  },
  'src/app/api/public/bookings/[slug]/availability/route.js': {
    event_types: 'Public booking availability for a published slug (same surface as the booking page).',
  },
  'src/app/api/public/bookings/[slug]/slots/route.js': {
    event_types: 'Public booking slots for a published slug (same surface as the booking page).',
  },
  'src/app/api/public/events/[slug]/route.js': {
    race_events: 'Public event page: race_events row resolved by published slug + active/published flags.',
  },
  'src/app/api/public/events/[slug]/display/route.js': {
    race_events: 'Public race-day display for a published slug (TV screen at the venue).',
  },
  'src/app/api/public/classes/route.js': {
    landing_page_settings: 'Public landing-page class list: landing_page_settings row resolved by its public_path — the path IS the tenant selector for the public site.',
  },
  'src/app/api/public/funnel-event/route.js': {
    landing_page_settings: 'Public funnel beacon: resolves public_path → location_id and only INSERTS a funnel event for that location; unknown paths are ignored.',
  },
  'src/app/api/public/class-booking-payments/[id]/route.js': {
    class_booking_requests: 'Public paid-booking status poll: the row is resolved by its own unguessable UUID (the payment id handed to the payer in the create response) — the id IS the capability token, not enumerable. Returns only display-safe checkout fields (status/provider/token/url/amount/class_name), no contact PII. Mirrors public/event-payments/[id].',
  },
  'src/app/api/public/offers/[slug]/checkout/route.js': {
    sale_offers: 'Public sale catalogue (OFFERS.4): the row is looked up by its globally-unique slug and every active offer is deliberately world-readable — it IS the product page data. The only sensitive field the route touches is price_cents, which it reads server-side precisely so the client can never supply an amount.',
  },
  'src/app/api/public/countdown.gif/route.js': {
    sale_offers: 'Countdown image for marketing email (COUNTDOWN.1): reads ONLY ends_at of the latest active offer — the same deadline already rendered publicly on /offers and printed in the email itself. No location context exists (it is an <img> fetched by a mail client), and the response is pixels, not data.',
  },
  'src/app/api/public/offer-purchases/[id]/route.js': {
    offer_purchases: 'Public paid-purchase status poll (OFFERS.4): the row is resolved by its own unguessable UUID (the purchaseId handed to the payer in the checkout response) — the id IS the capability token, not enumerable. Returns only { paid, state }, no buyer PII. Mirrors public/class-booking-payments/[id].',
  },
  'src/app/api/public/branding/route.js': {
    company_settings: 'Anonymous login-screen branding: deliberately serves the FIRST configured row (logo/name only) when no location context exists yet. Known single-tenant shortcut — revisit when a second org onboards, but it exposes no contact/tenant data.',
  },

  // Webhooks — sender authenticated by signature/secret (enforced by
  // check:route-guards); the tenant is resolved from the PROVIDER\'s
  // identifier, not a location filter.
  'src/app/api/webhooks/inbody/route.js': {
    inbody_webhook_events: 'Secret-verified raw-capture upsert of the provider payload; location scoping happens later when the bridge fetch matches accounts (audit W2-H/M1).',
  },
  'src/app/api/webhooks/revolut/route.js': {
    cars: 'Signature-verified webhook resolves the car by deposit_revolut_order_id — the provider\'s order id from the verified payload IS the row identity.',
    contacts: 'Buyer-email ilike lookup to link the deposit event to an existing contact; input comes from the signature-verified payload\'s order, only the contact id is used for the event emit.',
  },
  'src/app/api/webhooks/xero/route.js': {
    cars: 'Signature-verified webhook resolves the car by xero_invoice_id — the provider\'s invoice id IS the row identity (per-location Xero connections mint the ids).',
  },

  // The schedule/templates/[id] TODO-LEAK entries were removed once
  // SAAS-11 landed the fix (assertLocationAccessOr404 + .eq('location_id')
  // on every write) — the route now shows scoping evidence and no longer
  // needs an exemption. Future real findings go here as 'TODO-LEAK:' rows.

  // ——— PAGE-SCOPE.1 triage (2026-08-09): app-dir server pages. ———

  // Public marketing/catalog pages — all in proxy.js publicPaths; the row is
  // content the tenant chose to publish, resolved by its public identifier
  // (slug / public_path + active/published flags). Mirrors the
  // /api/public/* exemptions above.
  'src/app/event/[slug]/page.js': {
    race_events:
      'Public event page (page twin of /api/public/events/[slug]): row resolved by published slug + active=true + status=published; the page shell only uses name/description for OG metadata — the signup widget fetches through the public API.',
  },
  'src/app/embed/event/[slug]/page.js': {
    race_events:
      'Public iframe-embeddable signup for a published slug — same resolution and surface as /event/[slug].',
  },
  'src/app/offers/page.js': {
    sale_offers:
      'Public sale catalogue (OFFERS.7): active offers are deliberately world-readable — they ARE the landing-page content (same rationale as /api/public/offers/[slug]/checkout).',
  },
  'src/app/offers/[slug]/page.js': {
    sale_offers:
      'Public sale product page: row resolved by its globally-unique slug; price is rendered server-side from the row so the client can never supply an amount.',
  },
  'src/app/start/page.js': {
    landing_page_settings:
      "Public Meta-ads landing (proxy publicPaths): reads the fixed hatch-street row's published blocks + the landing logo — public marketing content; the public_path IS the tenant selector (same rationale as /api/public/classes).",
  },
  'src/app/welcome/page.js': {
    landing_page_settings:
      'Public split-chooser: renders every location\'s published chooser tiles by design; the ?edit=1 seed reads the most-recently-edited row but only previews the same published marketing content.',
  },
  'src/app/welcome/[location]/status/page.js': {
    landing_page_settings:
      'Public status page: public_path → location resolution (the path IS the published tenant selector); renders only the coy member view from buildStatusView(), never internal detail.',
  },

  // Settings fleet dashboard — deliberately estate-wide.
  'src/app/settings/notifications/health/page.js': {
    profile_locations:
      'Push-delivery fleet dashboard (NOTIF.4 + STAFF-DEV.4) gated by hasPermission(settings): groups active staff under EVERY location on purpose — it is the estate-wide device/app-version fleet view. Single-org estate today; revisit when a second org onboards (same caveat as public/branding).',
  },

  // The first page scan's four real findings needed NO exemption in the end:
  // both fixes landed before this check did, so the pages carry their own
  // guards. /email/templates/[id] + /whatsapp/templates/[id] → TPL-IDOR.1
  // (#1307); /bookings/event-types/[id] + /edit → EVT-IDOR.1 (#1311, found
  // by this scan — the detail page had no user check in it at all and listed
  // the foreign event's bookings incl. contact PII). Future real findings go
  // here as 'TODO-LEAK:' rows.
}

// ---------------------------------------------------------------------------
// Pure functions (exported for tests)
// ---------------------------------------------------------------------------

/** Strip `-- …` line comments so commented-out DDL can't add tables. */
function stripSqlComments(sql) {
  return sql.replace(/--[^\n]*/g, '')
}

/**
 * Derive the tables that gain a location_id column from one migration file's
 * text. Matches:
 *   CREATE TABLE [IF NOT EXISTS] [public.]t ( … location_id … )
 *   ALTER TABLE [IF EXISTS] [ONLY] [public.]t … ADD COLUMN [IF NOT EXISTS] location_id …
 * private.* tables are skipped — PostgREST doesn't expose them to .from().
 */
export function deriveLocationTables(sqlText) {
  const sql = stripSqlComments(sqlText)
  const tables = new Set()

  const createRe =
    /CREATE\s+TABLE(?:\s+IF\s+NOT\s+EXISTS)?\s+(?:"?(public|private)"?\s*\.\s*)?"?([a-zA-Z_]\w*)"?\s*\(/gi
  for (const m of sql.matchAll(createRe)) {
    if ((m[1] || 'public').toLowerCase() === 'private') continue
    // Walk balanced parens from the CREATE TABLE open paren to isolate the
    // column body (so a later table's location_id can't bleed in).
    const open = m.index + m[0].length - 1
    let depth = 0
    let i = open
    for (; i < sql.length; i++) {
      if (sql[i] === '(') depth++
      else if (sql[i] === ')') { depth--; if (depth === 0) break }
    }
    const body = sql.slice(open, i + 1)
    if (/\blocation_id\b/.test(body)) tables.add(m[2])
  }

  const alterRe =
    /ALTER\s+TABLE(?:\s+IF\s+EXISTS)?(?:\s+ONLY)?\s+(?:"?(public|private)"?\s*\.\s*)?"?([a-zA-Z_]\w*)"?([^;]*)/gi
  for (const m of sql.matchAll(alterRe)) {
    if ((m[1] || 'public').toLowerCase() === 'private') continue
    if (/ADD\s+COLUMN\s+(?:IF\s+NOT\s+EXISTS\s+)?"?location_id\b/i.test(m[3])) tables.add(m[2])
  }

  return tables
}

/** Union deriveLocationTables over every .sql migration, minus TABLE_EXCLUDE. */
export function collectLocationTables(migrationsDir) {
  const tables = new Set()
  for (const f of fs.readdirSync(migrationsDir).sort()) {
    if (!f.endsWith('.sql')) continue
    const derived = deriveLocationTables(
      fs.readFileSync(path.join(migrationsDir, f), 'utf8')
    )
    for (const t of derived) tables.add(t)
  }
  for (const t of Object.keys(TABLE_EXCLUDE)) tables.delete(t)
  return tables
}

/**
 * Extract every fluent query chain that starts at .from('<table>') in a
 * source file. A chain is the text of `.from(...)` plus every subsequent
 * `.method(args)` call (balanced parens, string-literal aware — `.or()`
 * arguments contain parens).
 */
export function extractQueryChains(src, table) {
  const chains = []
  const needles = [`.from('${table}')`, `.from("${table}")`, `.from(\`${table}\`)`]
  for (const needle of needles) {
    let idx = 0
    while ((idx = src.indexOf(needle, idx)) !== -1) {
      let i = idx + needle.length
      // Consume `.method( … )` links.
      for (;;) {
        let j = i
        while (j < src.length && /\s/.test(src[j])) j++
        if (src[j] !== '.') break
        j++
        while (j < src.length && /\s/.test(src[j])) j++
        let name = ''
        while (j < src.length && /[\w$]/.test(src[j])) { name += src[j]; j++ }
        while (j < src.length && /\s/.test(src[j])) j++
        if (!name || src[j] !== '(') break
        // Balanced-paren walk, skipping string literals.
        let depth = 0
        let quote = null
        for (; j < src.length; j++) {
          const c = src[j]
          if (quote) {
            if (c === '\\') j++
            else if (c === quote) quote = null
            continue
          }
          if (c === "'" || c === '"' || c === '`') quote = c
          else if (c === '(') depth++
          else if (c === ')') { depth--; if (depth === 0) { j++; break } }
        }
        i = j
      }
      chains.push(src.slice(idx, i))
      idx = i
    }
  }
  return chains
}

function matchesAny(text, patterns) {
  return patterns.some((p) => (typeof p === 'string' ? text.includes(p) : p.test(text)))
}

/** Tenant-scoping evidence INSIDE one query chain. */
export function chainHasTenantEvidence(chain) {
  if (RAW_FILTER_EVIDENCE.test(chain)) return true
  if (OR_FILTER_EVIDENCE.test(chain)) return true
  if (MATCH_FILTER_EVIDENCE.test(chain)) return true
  if (TOKEN_LOOKUP_EVIDENCE.test(chain)) return true
  if (/\.(?:insert|upsert|update)\(/.test(chain) && WRITE_PAYLOAD_EVIDENCE.test(chain)) return true
  return false
}

/** Tenant-scoping evidence anywhere in the handler file. */
export function fileHasTenantEvidence(src) {
  if (SCOPING_HELPERS.some((t) => src.includes(t))) return true
  if (RAW_FILTER_EVIDENCE.test(src)) return true
  if (OR_FILTER_EVIDENCE.test(src)) return true
  if (MATCH_FILTER_EVIDENCE.test(src)) return true
  if (TOKEN_LOOKUP_EVIDENCE.test(src)) return true
  if (matchesAny(src, MASTER_GATE_EVIDENCE)) return true
  if (matchesAny(src, OWNER_SCOPE_EVIDENCE)) return true
  if (matchesAny(src, LOCATION_COMPARE_EVIDENCE)) return true
  return false
}

/** Which tables (from the derived set) does this source query at all? */
export function tablesQueried(src, tables) {
  const hit = []
  for (const t of tables) {
    if (
      src.includes(`.from('${t}')`) ||
      src.includes(`.from("${t}")`) ||
      src.includes(`.from(\`${t}\`)`)
    ) hit.push(t)
  }
  return hit
}

/**
 * Classify one route file against the derived table set.
 * Returns { skipped } for path-exempt categories, else
 * { findings: [{ table, exempt }] } — findings with exempt=false fail.
 */
export function classifyRoute(rel, src, tables, exemptMap = EXEMPT) {
  if (rel.includes('/api/cron/')) return { skipped: 'cron' }
  // QStash push workers are the migrated crons (QSTASH program, #926–#941):
  // signature-verified system jobs draining our own queue rows by id,
  // cross-tenant by design — same rationale as /api/cron/.
  if (rel.includes('/api/webhooks/qstash/')) return { skipped: 'qstash' }
  return classifySource(rel, src, tables, exemptMap)
}

/**
 * Classify one app-dir page.js (PAGE-SCOPE.1, the TPL-IDOR.1 class). Server
 * pages run the same service-role client as routes, so an unguarded
 * `.from(t).eq('id', params.id)` in a page serves ANY tenant's row to any
 * logged-in user — invisible to the /api scan. Pages that never call
 * createServerClient() are skipped: client components and API-fed pages
 * query through /api routes (already scanned) or the RLS-bound browser
 * client. No cron/qstash path skips — those are /api system surfaces.
 */
export function classifyPage(rel, src, tables, exemptMap = EXEMPT) {
  if (!src.includes('createServerClient(')) return { skipped: 'no-service-role' }
  return classifySource(rel, src, tables, exemptMap)
}

/** Shared findings loop behind classifyRoute/classifyPage. */
function classifySource(rel, src, tables, exemptMap) {
  const findings = []
  for (const table of tablesQueried(src, tables)) {
    const exemptReason = exemptMap[rel]?.[table]
    if (exemptReason) { findings.push({ table, exempt: true }); continue }
    const chains = extractQueryChains(src, table)
    const scoped = chains.some(chainHasTenantEvidence) || fileHasTenantEvidence(src)
    if (!scoped) findings.push({ table, exempt: false })
  }
  return { findings }
}

/** Stale EXEMPT entries: file gone, or file no longer queries the table. */
export function findStaleExemptions(exemptMap, readFile = (p) => {
  try { return fs.readFileSync(p, 'utf8') } catch { return null }
}) {
  const stale = []
  for (const [rel, byTable] of Object.entries(exemptMap)) {
    const src = readFile(rel)
    for (const table of Object.keys(byTable)) {
      if (src === null) { stale.push({ file: rel, table, why: 'file no longer exists' }); continue }
      if (!tablesQueried(src, [table]).length) {
        stale.push({ file: rel, table, why: 'route no longer queries this table' })
      }
    }
  }
  return stale
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

function walk(dir, filename, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(p, filename, out)
    else if (entry.name === filename) out.push(p)
  }
  return out
}

function main() {
  const tables = collectLocationTables(MIGRATIONS_ROOT)
  const files = walk(API_ROOT, 'route.js')
  // PAGE-SCOPE.1 — app-dir server pages are the same service-role surface
  // (page.js never exists under src/app/api, so the two walks don't overlap).
  const pageFiles = walk(APP_ROOT, 'page.js')

  const failures = []
  let exemptCount = 0
  let scopedRoutes = 0
  let queryingRoutes = 0
  let systemSkipped = 0
  let pageExemptCount = 0
  let scopedPages = 0
  let queryingPages = 0
  let pagesSkipped = 0

  for (const file of files) {
    const rel = file.split(path.sep).join('/')
    const src = fs.readFileSync(file, 'utf8')
    const res = classifyRoute(rel, src, tables)
    if (res.skipped) { systemSkipped++; continue }
    const queried = tablesQueried(src, tables)
    if (queried.length) queryingRoutes++
    let failed = false
    let exempted = false
    for (const f of res.findings) {
      if (f.exempt) { exemptCount++; exempted = true; continue }
      failures.push({ file: rel, table: f.table })
      failed = true
    }
    if (queried.length && !failed && !exempted) scopedRoutes++
  }

  for (const file of pageFiles) {
    const rel = file.split(path.sep).join('/')
    const src = fs.readFileSync(file, 'utf8')
    const res = classifyPage(rel, src, tables)
    if (res.skipped) { pagesSkipped++; continue }
    const queried = tablesQueried(src, tables)
    if (queried.length) queryingPages++
    let failed = false
    let exempted = false
    for (const f of res.findings) {
      if (f.exempt) { pageExemptCount++; exempted = true; continue }
      failures.push({ file: rel, table: f.table })
      failed = true
    }
    if (queried.length && !failed && !exempted) scopedPages++
  }

  const stale = findStaleExemptions(EXEMPT)
  const todoLeaks = Object.entries(EXEMPT).flatMap(([relFile, byTable]) =>
    Object.entries(byTable)
      .filter(([, reason]) => reason.startsWith('TODO-LEAK:'))
      .map(([table]) => `${relFile} [${table}]`)
  )

  if (failures.length === 0 && stale.length === 0) {
    console.log(
      `✓ location scoping: ${tables.size} tenant tables (derived from migrations), ` +
      `${files.length} routes — ${queryingRoutes} query tenant tables ` +
      `(${scopedRoutes} scoped, ${exemptCount} table-exemptions), ${systemSkipped} cron/qstash skipped; ` +
      `${pageFiles.length} pages — ${queryingPages} query tenant tables ` +
      `(${scopedPages} scoped, ${pageExemptCount} table-exemptions), ${pagesSkipped} without service-role client`
    )
    if (todoLeaks.length) {
      console.log(`  ⚠ ${todoLeaks.length} TODO-LEAK exemption(s) awaiting a fix PR:`)
      for (const t of todoLeaks) console.log(`    - ${t}`)
    }
    process.exit(0)
  }

  for (const f of failures) {
    console.error(`✗ UNSCOPED TENANT QUERY: ${f.file} — .from('${f.table}') with no location/org scoping in the handler`)
  }
  if (failures.length) {
    console.error(`
${failures.length} file/table pair(s) query a location_id-bearing table with no
detectable tenant scoping. Routes and server pages both run the service-role
client (RLS bypassed), so an unscoped query serves ANY tenant's rows. Fix by either:
  1. Scoping the query — .eq('location_id', …) / .in('location_id', ids)
     after assertLocationAccess(user, …), or an embedded-resource filter
     ('parent.location_id'), or fetch-by-pk + assertLocationAccessOr404 on
     the row's location_id.
  2. Delegating to a scoping helper — then ADD IT to SCOPING_HELPERS in
     scripts/check-location-scoping.mjs with a comment naming the file you
     verified it in. Only list helpers that actually apply the tenant scope.
  3. If the route is genuinely cross-tenant by design (webhook resolving the
     tenant from provider identifiers, master-only admin surface, capability
     token = the scope), adding an EXEMPT entry with the reason.
  4. If it's a REAL leak you can't fix in this PR, add an EXEMPT entry whose
     reason starts with 'TODO-LEAK:' so it stays loudly visible.
`)
  }
  for (const s of stale) {
    console.error(`✗ STALE EXEMPTION (${s.why}): ${s.file} [${s.table}]`)
  }
  process.exit(1)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}
