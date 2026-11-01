# Staff MCP server (MCP.1) — design

Status: draft for Richard's approval, 1 Nov 2026.

## Why

Staff already talk to the CRM through an in-app assistant (`/api/assistant/chat`:
a dozen tools, a role gate per tool, Sonnet on the Anthropic Messages API). The
same people increasingly have Claude open elsewhere: the Claude app on their
phone, Claude Desktop, Claude Code. Richard wants the CRM to be a connector
there, so a coach can ask "who is on tomorrow" or "where is Jane in the
pipeline" from wherever they are, and the answer comes back gated exactly as
the web app would gate it. Later, agents the business runs (a morning studio
brief, an ops agent) should be able to use the same door under their own
named identity.

An MCP server is the standard way to do that: one endpoint that any MCP
client can discover, sign in to and call tools on.

## Decisions (Richard, 1 Nov 2026)

| Question | Answer |
|---|---|
| Who uses it | Staff in Claude, as themselves; and, later, agents the business runs. Third-party integrations stay on the REST API and the `unitk_` key. |
| Identity | Per-person sign-in. Every tool call carries a real `profiles` row; role, studios and permissions resolve as the web app resolves them. |
| Under the hood | Supabase Auth as the OAuth 2.1 provider (its OAuth Server feature). |
| What v1 can do | Reads across roster/shifts/time off, contacts/pipeline/memberships, bookings/classes; plus the writes the in-app assistant already allows (create a shift, create a contact, log an activity). |
| Write guard | The same gates as the in-app assistant: role or permission per tool, the helper's own validation, `audit_events` as today. The client is told to confirm with the person before a write; the server does not force a second step. |
| Business-run agents | A named service profile per studio (a real `profiles` row with a role, holding its own token). Designed for, NOT built in v1: people first. |
| Hosting | Inside the Next.js app, one route handler, deployed with everything else. |
| Tenancy | A platform feature: an org admin switches it on per organisation. Off by default. |
| Who can connect | Anyone with an active CRM login who holds the existing **AI Assistant** web permission (`assistant`) at at least one studio, once their organisation has it on. Same switch as the in-app assistant: on by default for owner / manager / head coach, off for staff and reception, flipped per person by an admin. No new permission key. (Richard, 1 Nov 2026, replacing the first answer "anyone with a login".) |
| Host | `crm.repset.ie`, the platform's canonical host. The Supabase Site URL moves to `https://crm.repset.ie` (domain-migration runbook item 8), which also changes where auth emails link. |
| Token reach | Accepted: the OAuth token is an ordinary Supabase session JWT, so outside this app it can reach what the person's own phone session can (Supabase data API under RLS, champ-app's Bearer path). This repo refuses it everywhere but `/api/mcp`. Documented, not fenced further in v1. |
| Clients on day one | Claude app / Claude Desktop connectors and Claude Code. Nothing Claude-specific in the server, so other spec-compliant clients work too, but they are not tested. |
| Lifecycle | A "Connected apps" card on the person's account page listing what they connected, with a revoke button. Deactivating a profile cuts every connection it holds. |
| Tool shape | Many small, focused tools, one per question. |
| First test | One manager or head coach at one studio uses it for a week; we read what they asked and where it fell over. |
| Out, no matter what | Cars (CCF Autos) and Xero. Everything else is in principle allowed. Comms, money and customer sends are still out of v1 by scope, not by rule. |

## Goals

- A staff member adds `https://crm.repset.ie/api/mcp` as a connector in
  Claude or Claude Code, signs in with their normal CRM login, approves the
  client once, and from then on can ask about their studios' roster, time
  off, members, pipeline and classes, and (if their role allows) create a
  shift, a contact or an activity.
- Every answer is scoped and gated exactly as the in-app assistant and the
  web routes gate it. Nothing an MCP call returns is something the same
  person could not already see in the CRM.
- The person can see and revoke what they connected. An admin can cut it
  by deactivating them. An org admin can switch the whole door off.
- We can tell, a week in, who called what and what failed.

## Non-goals (v1)

- Business-run agents and service profiles (path kept open, nothing built).
- Inbox and comms tools (WhatsApp, email, Mia), sending anything to a
  customer, money (charges, refunds, credits, fees), Cars, Xero.
- Approvals-based writes, or any write beyond the assistant's three.
- Migrating the in-app assistant onto the new tool registry (it keeps
  running on its own code; see "Shared tool registry" for why that is a
  follow-up, not part of v1).
- The REST API, OpenAPI, `unitk_` keys: unchanged.
- Per-tenant custom domains for the MCP URL: v1 has one canonical URL.

## Anti-goals

- An OAuth token that works as a general API token IN THIS APP. A token
  Supabase issues to an MCP client opens `/api/mcp` and no other route here.
  (It remains a Supabase session JWT, so it can reach what the person's
  phone session reaches outside this app; see "Token reach" above.)
- A tool that reads through the service role without a studio fence. The
  service-role client bypasses RLS; the fence is app code, every time.
- Pay data leaking by accident: salary, hourly rate and allowances appear
  only where the web app shows them to that role (the staff-cost report for
  `RATE_REPORT_VIEWER_ROLES`), never in a staff list or a contact.
- "View as user" through MCP. Impersonation is a browser-session feature;
  the MCP route ignores the header and cookie.
- A connection that outlives the person: a deactivated or tombstoned
  profile is refused on the next call, whatever token it presents.

## How it works

### 1. Sign-in: Supabase Auth as the OAuth 2.1 server

Supabase Auth's OAuth Server (public beta since Nov 2025) makes the project
an OAuth 2.1 + OIDC provider. Dashboard steps on `iyvtbjjxdggiadzwwvdj`
(Authentication → OAuth Server):

- Enable the OAuth 2.1 server.
- Site URL: `https://crm.repset.ie` (today it still points at a legacy
  host: domain-migration runbook item 8 is unticked). Check what else reads
  it before moving: invite / recovery / magic-link emails are built from it,
  so the recovery-link path (`src/lib/recovery-link.js`) and champ-app's
  email links must still land somewhere that serves them. Do this in the
  same change window as enabling the OAuth server, and test an invite and
  a password reset afterwards.
- Authorization Path: `/oauth/consent`. Supabase joins it to the Site URL,
  so the consent page is served at `https://crm.repset.ie/oauth/consent`.
- Dynamic client registration: ON. Claude's connectors register themselves
  (RFC 7591); Claude Code does the same. Claude's callback is
  `https://claude.ai/api/mcp/auth_callback` (and the `claude.com`
  equivalent); we do not restrict redirect URIs ourselves because Supabase
  validates them per registered client.
- Scopes: we request none of `openid/email/profile/phone` (they only shape
  OIDC data). Asymmetric signing keys are recommended by Supabase but not
  required for this flow.

Endpoints Supabase provides (nothing to build):

| | |
|---|---|
| Discovery | `https://<ref>.supabase.co/.well-known/oauth-authorization-server/auth/v1` |
| Authorize | `https://<ref>.supabase.co/auth/v1/oauth/authorize` |
| Token | `https://<ref>.supabase.co/auth/v1/oauth/token` |
| JWKS | `https://<ref>.supabase.co/auth/v1/.well-known/jwks.json` |

The access token is a normal Supabase JWT (`sub`, `role: authenticated`,
`user_id`, `email`, `client_id`, `session_id`, `exp` ≈ 1 h) with refresh
rotation handled by Supabase. `client_id` is what marks it as OAuth-issued.

**Consent page** `src/app/oauth/consent/page.js` (new, in this repo):

1. Reads `authorization_id` from the query. If there is no signed-in
   session, sends the person to `/login?redirect=/oauth/consent?authorization_id=…`
   and back.
2. `supabase.auth.oauth.getAuthorizationDetails(authorization_id)` →
   client name, redirect URI, scopes. If the reply has no
   `authorization_id`, the person already approved this client: redirect
   to the returned `redirect_url`.
3. Refuses (shows "not switched on for your organisation, ask an admin")
   when none of the person's organisations has MCP enabled, when they hold
   the `assistant` permission at no studio ("ask an admin to switch on AI
   Assistant for you"), and when the profile is inactive or a tombstone.
   It does not approve on their behalf.
4. Renders the client's name, what the connection can do in plain words
   (read the roster, members, classes; create shifts/contacts/activities if
   your role allows), Approve and Deny.
5. `approveAuthorization` / `denyAuthorization`, then redirect to
   `redirect_url`.

The page is signed-in-but-public in the invariant's sense: it must not be
caught by the app layout gate and it must be reachable before login, so it
goes in all FOUR allowlists (`src/proxy.js` publicPaths, `AppShell`
PUBLIC_PATHS, `brands.js` allowedPaths, `tenant-domains-edge.js`
DB_BRAND_DEFAULTS.allowedPaths) and `src/public-compliance-paths.test.jsx`
gets a row. No `<button>` without a type.

**Connected apps** (`src/app/account`, a new card beside `CalendarFeedCard`):
`supabase.auth.oauth.listGrants()` from the browser client (signed in) lists
client name, scopes, when connected; `revokeGrant({ clientId })` revokes
(Supabase deletes that client's sessions and refresh tokens). The card also
shows "last used" and "calls this week" from `mcp_tool_calls` (below) via a
small `GET /api/account/connected-apps` route. Managers do not revoke
another person's grants in v1 (no admin API for it is documented); they
deactivate the profile, which the MCP route refuses on the next call.

### 2. The endpoint: `src/app/api/mcp/route.js`

- `mcp-handler@^2` + `@modelcontextprotocol/server@^2` (zod 4 ✓, Node 24 ✓).
  Stateless Streamable HTTP, `runtime = 'nodejs'`, `dynamic = 'force-dynamic'`,
  `export const maxDuration = 60`. `GET`, `POST`, `DELETE` exported.
- `withMcpAuth(handler, verifyToken, { required: true, resourceMetadataPath })`.
  `verifyToken(request, bearer)`:
  1. Refuses a `unitk_` key and any JWT WITHOUT a `client_id` claim (a plain
     web/mobile session token is not an MCP credential): 401 with the
     RFC 9728 `WWW-Authenticate` challenge.
  2. Resolves the person through the same path as every Bearer route:
     `auth.getUser(token)` → profile → `getCurrentUser()`-shaped user
     (`USER_PROFILE_COLUMNS`, `rolesByLocation`, org-admin tier, role
     templates). Inactive / tombstone → 401. The impersonation header and
     cookie are ignored on this path (the route constructs its user without
     `src/lib/impersonation.js`).
  3. Refuses (403, `mcp_disabled`) unless at least one organisation the
     person belongs to has MCP on; each tool then re-checks the org of the
     studio it acts on. Refuses (403, `assistant_permission`) unless the
     person holds the `assistant` web permission at at least one studio
     (`hasPermissionAtAnyLocation`); each tool then re-checks it at the
     studio it acts on, the way `/api/assistant/chat` checks it once.
  3b. Audience: Supabase tokens carry `aud: authenticated`, not the
     resource URL, so the `client_id` claim stands in for audience
     validation. A token minted for another MCP server on this project
     would pass; there is none, and this is a conscious acceptance.
  4. Returns `AuthInfo { token, clientId, scopes: [], extra: { user } }`.
- Rate limit: `checkRateLimit(db, 'mcp:' + profileId, { max: 120, windowMs: 60_000 })`
  (fails open, as everywhere).
- `/.well-known/oauth-protected-resource` and
  `/.well-known/oauth-protected-resource/api/mcp` are served by
  `protectedResourceHandler({ authServerUrls: ['https://<ref>.supabase.co/auth/v1'] })`
  with the CORS preflight helper. `/.well-known/` is already public in the
  proxy; `/api/mcp` is added to `publicPaths` so an unauthenticated first
  request gets the 401 + challenge the client needs instead of a 307 to
  `/login`. The route authenticates itself.
- One canonical resource URL, `https://crm.repset.ie/api/mcp`, from
  `getAppUrl()` (`NEXT_PUBLIC_APP_URL`, no env fallback). RFC 9728 needs the
  metadata's `resource` to equal the URL the client connected with, so a
  request for `/api/mcp` on any other host (`crm.un1tdublin.com`,
  `un1t-group.repset.ie`, a `tenant_domains` host) answers 404 from the
  route itself (host check against `getAppUrl()`), and the hub card only
  ever shows the canonical URL. Per-tenant hosts are a later phase.
- Inbound comes from Anthropic's cloud. Vercel's attack-challenge / bot
  protection must not challenge `/api/mcp` (builder checks the project's
  firewall config and adds a bypass rule if one is needed).

**Proxy change (`src/proxy.js`)**: the Supabase-JWT Bearer gate decodes the
payload (unverified, only to read `client_id`; verification stays
`auth.getUser`) and REFUSES a token carrying `client_id` on any path other
than `/api/mcp`. Pinned in `src/proxy.test.js` both ways: an OAuth token is
refused on `/api/contacts/search`, a session JWT is refused on `/api/mcp`.
The same check lives in `getUserFromBearer()` for defence in depth, because
`getCurrentUser` is also called from pages.

### 3. Tools

Conventions every tool follows (and a guard test enforces):

- Defined in a registry, `src/lib/agent-tools/<tool>.js`, each exporting
  `{ name, description, inputSchema (zod), gate, run }`; `index.js` lists
  them. `gate(user, ctx)` returns true/false; `run(input, ctx)` gets
  `{ db, user, studio, zone, now }`.
- Every tool takes an optional `studio_id`. It resolves to one of the
  person's studios where they hold `assistant` (default: their default
  studio, else the first); any
  other id is refused with the same "unknown studio" error as a studio that
  does not exist (never 403 on an id). Role is `rolesByLocation[studio]`.
  Permission checks use `hasPermissionForLocation(user, studio, key)` (that argument order).
- A tool that reads contacts requires the Contacts permission at the
  studio and scopes with `contactsAtStudio` / `studio_contacts` semantics
  (ORGCONTACTS: a sibling studio's contact with a `contact_studios` row at
  this studio is readable here). A contact id outside that set is "not
  found".
- Service-role reads, named columns only (never `select('*')` on a table
  with a REVOKE in its history: `profiles`, `locations`, `contacts`).
  `redactLocationSecrets` on any `locations` row. `USER_PROFILE_COLUMNS`
  for people. Pay columns only inside `staff_cost_report`.
- Output is compact JSON as the text content: ids included so a follow-up
  tool call can use them, timestamps rendered in the studio's zone with the
  zone named, dates as `YYYY-MM-DD`. Lists are capped (50 rows) and say so.
- Search terms go through `sanitizeSearchTerm` / `escapeLikePattern` before
  any `.ilike`/`.or` (the in-app assistant's `search_contacts` interpolates
  the raw query; the registry version does not, and the follow-up that
  migrates the assistant fixes it there too).
- A write tool's description tells the client to confirm with the person
  first and never to retry on its own; the server gates, validates, writes
  through the same helper the web route uses, and returns what was written.

v1 tool list (gate in brackets; "member" = any active membership at the
studio):

Identity
- `whoami` [member] — name, studios (id, name, zone, role there, today's
  date there), which tools the person may use, whether MCP is on for each
  organisation.

Roster and time off
- `get_shifts` (studio, start, end ≤ 31 days) [member] — published shifts
  with effective start/end hours; drafts and unpublished days only for
  `MANAGER_ROLES`, else `unpublished_days`. `fetchApiShiftRows` +
  `effectiveShiftStart/End`.
- `get_time_off` (studio, start, end ≤ 366 days) [member; staff see own
  only] — `reportPeriodError` validation, same filter as the assistant.
- `get_holiday_allowance` (profile_id?, year?) [member; another person only
  for `MANAGER_ROLES`] — through `getHolidayAllowance` /
  `getLeaveEntitlement` in `src/lib/time-off-leave.js` (the assistant's
  hard-coded 20-day default is not copied).
- `list_staff` (studio) [MANAGER_ROLES] — active profiles at the studio:
  id, name, role, employment type. No pay, no email/phone.
- `list_shift_templates` (studio) [MANAGER_ROLES].
- `create_shift` (studio, profile_id, template_id, date) [MANAGER_ROLES] —
  `upsertShiftAssignment` with `actorId = user.id`.
- `staff_hours_report` (studio, period) [MANAGER_ROLES] and
  `staff_cost_report` (studio, period) [`RATE_REPORT_VIEWER_ROLES`] —
  `fetchScheduledShiftRows` + `shiftHours`, as `generate_report` today.

Contacts, pipeline, memberships
- `search_contacts` (studio, query) [Contacts permission] — up to 20
  matches: id, name, email, phone, primary studio, pipeline stage,
  membership status. Sanitised term, `is_primary_contact` semantics as the
  launcher search.
- `get_contact` (contact_id) [Contacts at a studio where the contact is
  readable] — profile fields the contact page shows, studios with
  membership facts (`membershipRowsFromStudioRows`), open deals and their
  stage, last 20 timeline items (activities and notes; never message
  bodies), class bookings in the last 30 / next 30 days (both platforms).
- `list_pipeline` (studio, board?, stage?) [`pipeline` permission] — deals
  grouped by stage with contact name, value, days in stage, owner;
  `pipelineDealSelect` + `boardDealMapper`. Read only: stages are
  classifier-owned (FUNNEL.1), there is no move tool.
- `list_tasks` (studio, assignee = me | all, due = overdue | today | week)
  [`activities` permission] — open task-kind activities.
- `create_contact` (studio, fields) [`ADMIN_ROLES`] — same path as the
  assistant: insert, `maybeProvisionLeadInGlofox`,
  `triggerSequencesForContactCreated`. Email uniqueness is per organisation
  (`contacts_email_org_unique`): a hit returns the existing contact's id
  rather than failing.
- `create_activity` (contact_id, kind, title, due?) [`MANAGER_ROLES`].

Bookings and classes
- `get_classes` (studio, date | start+end ≤ 14 days) [member] — timetable
  from `class_occurrences` (Glofox- and un1t.online-projected rows alike):
  id, time, name, trainer, capacity, platform; booked and waitlisted counts
  are derived from `class_bookings` (the occurrence row holds none).
- `get_class_roster` (occurrence_id) [`class_roster` permission + Contacts
  at that studio] — who is booked / attended / no-show / waitlisted.
- `get_appointments` (studio, start, end ≤ 31 days) [`bookings`
  permission] — appointment `bookings` with event type, contact, status.

Not in v1 (named so the builder does not add them): anything on
`whatsapp_*`, `email_*`, `instagram_*`, `cars*`, `xero_*`, fees, credits,
trial purchases, un1t.online writes, Glofox writes other than the lead
provisioning `create_contact` already does.

### 4. Shared tool registry and the in-app assistant

The in-app assistant keeps `executeTool` in
`src/app/api/assistant/chat/route.js` untouched in v1. The registry is new
code that calls the same helpers (`fetchApiShiftRows`,
`upsertShiftAssignment`, `fetchScheduledShiftRows`, …), so "same gates" is
true by construction for the three writes and the roster reads, and the
new reads have no assistant twin to drift from. Migrating the assistant's
`TOOLS` / `TOOL_PERMISSIONS` onto the registry is a follow-up PR with the
assistant's tests as its net; it also inherits the sanitised search and the
real allowance helper.

### 5. Organisation switch

- `org_settings.mcp_enabled boolean NOT NULL DEFAULT false` (one named
  column, the house pattern; mig N).
- Toggled from the Integrations hub (`/settings/integrations-hub`, the only
  integrations surface since INTEGONE.1): an "Agent access (MCP)" card with
  the switch, the connector URL to copy, a one-paragraph "how to add it in
  Claude", and the count of people who called a tool in the last 30 days
  (distinct `mcp_tool_calls.profile_id`; Supabase exposes no grant listing
  across users). Route
  `PUT /api/settings/org-mcp` gated by `resolveAdminOrgId` (org admins and
  masters), `audit_mutation` as the other org_settings routes.
- Switching it off: the consent page refuses new approvals and every tool
  call for that org's studios answers `mcp_disabled`. Existing grants are
  not revoked (Supabase has no admin revoke documented); they are simply
  useless until it is on again.

### 6. Observability

- `mcp_tool_calls` (mig N, service-role only, RLS on with no policy):
  `id, profile_id, organization_id, location_id, client_id, tool, ok,
  error_code, duration_ms, created_at`. Never the arguments or the result
  (contact PII, free text). 90-day retention by the existing cleanup cron
  pattern. Feeds "last used" on Connected apps and the week-one review
  (a master-only page is NOT in v1; a SQL query is enough for one week).
- `audit_events` records the three writes through the existing triggers;
  `actor` is the person, as for a web write.
- Errors to `logError` with `route_type 'mcp'`, never free text.
- No `recordUsage`: the client pays for the model; our meter is
  `mcp_tool_calls`.

### 7. Service profiles (designed for, not built)

A business-run agent is a `profiles` row (`is_service_account true`, a
role and permissions like any staff member, no login by password), created
by a master from `/settings/staff`, and a pre-registered confidential OAuth
client whose consent a master grants once while signed in as that profile
(or via the admin client API). The agent runtime holds the refresh token.
Nothing in v1 depends on how that is done; v1 must only avoid assuming a
caller is a human (no "your" wording in tool errors, no reliance on
`is_default` studio).

### 8. Guards and gates to extend

- `check:route-guards`: `/api/mcp` authenticates inside `withMcpAuth`;
  register that pattern (or an EXEMPT entry with the reason) so the gate
  recognises it rather than muting it.
- `check:location-scoping`: scans `/api` routes; the fence here lives in
  the registry. Add `tests/agent-tools-guard.test.js`: every file in
  `src/lib/agent-tools/` exports `gate` and `inputSchema` with `studio_id`,
  every `.from('contacts'|'deals'|'bookings'|…)` in it is followed by a
  studio filter, and no tool touches a table from the "not in v1" list.
- `check:select-columns`, `check:rpc-names`, `check:guardrails`
  (`no-unescaped-ilike-pattern`, `no-discarded-single-error`,
  `no-unchecked-supabase-write` armed on `src/lib/agent-tools/`).
- `check:mobile-parity`: no new permission key (`assistant` already has
  its mobile twin), nothing to do.
- Tests: registry gate matrix (master / owner / manager / head_coach /
  reception / staff × tool), studio resolution (foreign id → not found), proxy pins,
  consent page (signed out, already approved, org off), `verifyToken`
  (no client_id, inactive profile, org off).
- `npm run build` locally before the PR (new route, new deps).

### 9. Rollout

1. Dashboard, one change window: Site URL → `https://crm.repset.ie`
   (runbook item 8; then send yourself an invite and a password reset and
   follow both links), enable OAuth Server, authorization path
   `/oauth/consent`, DCR on. Record the steps in
   `docs/architecture/INTEGRATIONS.md` and tick the runbook.
2. Migration(s): `mcp_enabled`, `mcp_tool_calls`; `get_advisors` after.
3. PR: route, consent page, allowlists, proxy change, registry, hub card,
   account card, tests. `npm run build`.
4. Switch on for UN1T Group. Richard connects from Claude Desktop and Claude
   Code; also from the MCP Inspector to see raw tool output.
5. One manager or head coach at one studio for a week. Review
   `mcp_tool_calls` and what they say; fix; then decide on widening and on
   the assistant migration.

## Settled after the builder check (Richard, 1 Nov 2026)

1. Host: `crm.repset.ie`, and the Supabase Site URL moves there.
2. Connecting requires the existing `assistant` web permission.
3. Token reach outside this app is accepted and documented, not fenced.
4. The staff-cost report (salary / hourly rate) is readable through MCP by
   the roles that see it on the web ("everything else is ok").

## Builder's calls (made here, change if wrong)

- One canonical MCP URL on the platform host in v1.
- The `assistant` permission is checked once at the door and again per
  studio inside each tool (so a person with it at one studio cannot use
  it at another where it is off).
- `mcp_tool_calls` logs tool name and outcome, never arguments.
- The in-app assistant is not migrated in v1.
- 120 calls a minute per person.
- Lists capped at 50 rows; `get_contact` timeline capped at 20.
