# Staff MCP server (MCP.1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A staff member adds `https://crm.repset.ie/api/mcp` to Claude or Claude Code, signs in with their CRM login, and gets small focused tools over roster, contacts, pipeline and classes, gated exactly as the web app gates them.

**Architecture:** Supabase Auth's OAuth 2.1 server issues the token (a normal Supabase JWT carrying `client_id`); the CRM hosts the consent page. One Next.js route handler (`mcp-handler` 2.x, stateless Streamable HTTP) verifies the token into a `getCurrentUser()` user and dispatches to a tool registry in `src/lib/agent-tools/`, where every tool declares a gate and resolves a studio the person belongs to before any service-role read. An org switch on `org_settings`, a Connected apps card, and a PII-free call log round it out.

**Tech Stack:** Next.js 16 App Router, `mcp-handler@^2` + `@modelcontextprotocol/server@^2`, zod 4, supabase-js 2.118 (`auth.oauth.*`), vitest.

**Spec:** `docs/superpowers/specs/2026-11-01-mcp-server-design.md`

## Global Constraints

- Node 24, zod 4 (already installed); install exactly `mcp-handler@^2 @modelcontextprotocol/server@^2`. Read `node_modules/mcp-handler/README.md` and its `docs/AUTHORIZATION.md` before Task 5: this plan names the API from the README; the installed version is the truth.
- Canonical MCP URL: `getAppUrl() + '/api/mcp'` (`NEXT_PUBLIC_APP_URL`, production `https://crm.repset.ie`). Any other host answers 404 from the route.
- Authorization server: `process.env.NEXT_PUBLIC_SUPABASE_URL + '/auth/v1'`.
- An OAuth-issued token is a Supabase JWT whose payload has `client_id`. It is accepted ONLY at `/api/mcp`; every other `/api` path refuses it. `/api/mcp` accepts ONLY such tokens (never a plain session JWT, never a `unitk_` key).
- Every tool: optional `studio_id`; resolves to a studio in `user.locations` where the person holds the `assistant` web permission; a foreign or unknown id is the same error as a non-existent one; service-role reads name their columns; lists cap at 50 rows; `get_contact` timeline caps at 20; timestamps render in the studio zone with the zone named; dates are `YYYY-MM-DD`.
- Rate limit `120` calls per `60_000` ms per profile (`checkRateLimit`, fails open).
- The door (`verifyMcpToken`) refuses only a bad or expired token (401 + challenge). Policy refusals (org switch off, no `assistant` permission, role gate) are tool-level `isError` results, so the client can explain them instead of re-prompting for sign-in; this refines the spec's "403 at the door".
- `mcp_tool_calls` never stores arguments or results. Retention 90 days.
- No tool touches `whatsapp_*`, `email_*`, `instagram_*`, `cars*`, `car_*`, `xero_*`, `class_fees*`, `trial_purchases`, `un1t_write_*`.
- House rules that bite here: four public-path allowlists for `/oauth/consent`; `type="button"` on every non-submit button; `await` every supabase write and destructure `error`; `.maybeSingle()` where 0 rows is legitimate; no `'Europe/Dublin'` literal; `tests/` guard style for the registry guard; `npm run build` before the PR.
- Commit after every task with a `MCP.1 — …` subject and the trailer `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.

## Review Focus

1. **An expired access token mid-conversation** must come back as a 401 with the `WWW-Authenticate` challenge so the client refreshes, never a 500 or a tool error (Task 3 test `verifyMcpToken returns null when auth.getUser answers no user`).
2. **A person in two organisations, one switched on and one off**, must be refused at the off studio with a plain `mcp_disabled` tool error while the on studio works, and `whoami` must say which is which (Task 4 test `runTool refuses a studio whose organisation has MCP off`).
3. **Date-range inputs**: an end before the start, a non-calendar date (`2026-02-30`) or a range over the cap must be a validation error with the cap named, never an empty result (Task 6 test `get_shifts refuses a range over 31 days and a bad date`).
4. **A contact id from another tenant** must answer exactly the same `not_found` as a random uuid (Task 7 test `get_contact answers not_found for a contact at a studio the person cannot read`).
5. **Supabase unreachable during token verification** must resolve "signed out" (401) and log once, not throw into a 500 (Task 3 test `verifyMcpToken returns null and logs when getCurrentUser throws`).

---

### Task 1: Proxy — `/api/mcp` is public, OAuth tokens are refused elsewhere

**Files:**
- Create: `src/lib/oauth-token-edge.js`
- Modify: `src/proxy.js:267` (publicPaths), `src/proxy.js:371-388` (JWT branch)
- Test: `src/lib/oauth-token-edge.test.js`, `src/proxy.test.js`

**Interfaces:**
- Produces: `jwtClientId(token: string): string | null` — decodes the JWT payload (base64url, no verification, edge-safe: no `node:` imports) and returns `payload.client_id` when it is a non-empty string, else null. Malformed input → null, never throws.

- [ ] **Step 1: Write the failing tests**

`src/lib/oauth-token-edge.test.js`:
```js
it('reads client_id off a JWT payload', () => {
  const payload = Buffer.from(JSON.stringify({ sub: 'u1', client_id: 'abc' })).toString('base64url')
  expect(jwtClientId(`h.${payload}.s`)).toBe('abc')
})
it('answers null for a session JWT, a unitk_ key, garbage and empty', () => {
  const payload = Buffer.from(JSON.stringify({ sub: 'u1' })).toString('base64url')
  expect(jwtClientId(`h.${payload}.s`)).toBeNull()
  expect(jwtClientId('unitk_' + '1'.repeat(40))).toBeNull()
  expect(jwtClientId('not.a.jwt.at.all')).toBeNull()
  expect(jwtClientId('')).toBeNull()
})
```

`src/proxy.test.js`, new `describe('MCP.1 — OAuth-issued tokens')` using the file's `makeReq`/`admitted` and a `mkJwt(payload)` helper that builds `h.<base64url payload>.s`:
```js
it('refuses an OAuth token (client_id) on an ordinary /api route without calling getUser', async () => {
  const res = await proxy(makeReq({ path: '/api/bookings', token: mkJwt({ sub: 'u1', client_id: 'c1' }) }))
  expect(admitted(res)).toBe(false)
  expect(ssrClient.auth.getUser).not.toHaveBeenCalledWith(expect.any(String))
})
it('admits /api/mcp without any token (the route authenticates itself)', async () => {
  const res = await proxy(makeReq({ path: '/api/mcp', method: 'POST' }))
  expect(admitted(res)).toBe(true)
})
it('still admits a session JWT on an ordinary /api route', async () => {
  ssrClient.auth.getUser.mockResolvedValueOnce({ data: { user: { id: 'u1' } } })
  const res = await proxy(makeReq({ path: '/api/bookings', token: mkJwt({ sub: 'u1' }) }))
  expect(admitted(res)).toBe(true)
})
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run src/lib/oauth-token-edge.test.js src/proxy.test.js`
Expected: FAIL (`jwtClientId` not exported; `/api/mcp` redirected; OAuth token admitted)

- [ ] **Step 3: Implement `jwtClientId` and the two proxy edits**

In `src/proxy.js`: add `'/api/mcp'` to `publicPaths` (the raw `startsWith` list; `/api/mcp` and `/api/mcp/…` both match). In the JWT branch, before `auth.getUser(token)`: `if (jwtClientId(token)) { /* MCP.1: an OAuth-issued token opens /api/mcp only */ } else { …existing getUser path… }` so the OAuth token falls through to the cookie gate and is refused there. Comment with the invariant from the spec.

- [ ] **Step 4: Run the tests and the existing proxy suites**

Run: `npx vitest run src/lib/oauth-token-edge.test.js src/proxy.test.js src/proxy.tenant-domains.test.js src/public-compliance-paths.test.jsx`
Expected: PASS

- [ ] **Step 5: Commit**

Stage `src/lib/oauth-token-edge.js`, its test, `src/proxy.js`, `src/proxy.test.js`. Subject: `MCP.1 — proxy: /api/mcp authenticates itself; an OAuth-issued token opens nothing else`.

---

### Task 2: Migration 801 — `org_settings.mcp_enabled` and `mcp_tool_calls`

**Files:**
- Create: `supabase/migrations/801_mcp_server.sql`
- Test: `tests/migration-801-mcp-server.test.js`

**Interfaces:**
- Produces: column `public.org_settings.mcp_enabled boolean NOT NULL DEFAULT false`; table `public.mcp_tool_calls (id uuid pk default gen_random_uuid(), profile_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE, organization_id uuid REFERENCES organizations(id) ON DELETE SET NULL, location_id uuid REFERENCES locations(id) ON DELETE SET NULL, client_id text NOT NULL, tool text NOT NULL, ok boolean NOT NULL, error_code text, duration_ms integer, created_at timestamptz NOT NULL DEFAULT now())`, index `(profile_id, created_at desc)` and `(created_at)`.

- [ ] **Step 1: Write the failing test**

`tests/migration-801-mcp-server.test.js`, in the style of `tests/org-settings-client-closed-guard.test.js` (read the migration text with `sqlCode` from `tests/helpers/sql-code.js`):
```js
it('adds mcp_enabled with a false default and keeps org_settings closed', () => {
  expect(sql).toMatch(/ALTER TABLE public\.org_settings\s+ADD COLUMN IF NOT EXISTS mcp_enabled boolean NOT NULL DEFAULT false/i)
  expect(sql).not.toMatch(/GRANT[^;]*org_settings/i)
})
it('creates mcp_tool_calls closed to every client role, RLS on, no policy', () => {
  expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS public\.mcp_tool_calls/)
  expect(sql).toMatch(/ALTER TABLE public\.mcp_tool_calls ENABLE ROW LEVEL SECURITY/)
  expect(sql).toMatch(/REVOKE ALL ON public\.mcp_tool_calls FROM anon, authenticated/)
  expect(sql).not.toMatch(/CREATE POLICY[^;]*mcp_tool_calls/)
})
it('never stores arguments or results', () => {
  expect(sql).not.toMatch(/\b(args|arguments|input|result|payload)\b\s+(jsonb|text)/i)
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/migration-801-mcp-server.test.js`
Expected: FAIL (file missing)

- [ ] **Step 3: Write the migration**

Header comment in the house style (why, what, VERIFIED LIVE placeholder). Column, table, two indexes, `ENABLE ROW LEVEL SECURITY`, `REVOKE ALL ON public.mcp_tool_calls FROM anon, authenticated` (mig 677 makes this the default; the REVOKE is stated anyway), `COMMENT ON TABLE` naming MCP.1 and the 90-day purge. No heartbeat row here (Task 12's migration, applied after deploy).

- [ ] **Step 4: Run the test and the schema checks**

Run: `npx vitest run tests/migration-801-mcp-server.test.js && npm run check:select-columns && npm run check:rls-restrictive`
Expected: PASS

- [ ] **Step 5: Commit**

Stage the migration and its test. Subject: `MCP.1 — mig 801: org_settings.mcp_enabled and the mcp_tool_calls log`.

---

### Task 3: Token verification and the tool context

**Files:**
- Create: `src/lib/mcp/auth.js`, `src/lib/mcp/context.js`, `src/lib/mcp/log.js`
- Test: `src/lib/mcp/auth.test.js`, `src/lib/mcp/context.test.js`, `src/lib/mcp/log.test.js`

**Interfaces:**
- Consumes: `jwtClientId` (Task 1); `getCurrentUser` from `@/lib/auth`; `hasPermissionAtAnyLocation`, `hasPermissionForLocation` from `@/lib/permissions`; `MANAGER_ROLES`, `ADMIN_ROLES` from `@/lib/schemas`; `createServerClient`; `logError`.
- Produces:
  - `verifyMcpToken(token: string, { getUser = getCurrentUser, db = createServerClient() } = {}): Promise<McpAuth | null>` where `McpAuth = { token, clientId, scopes: [], extra: { user, enabledOrgIds: string[], assistantAnywhere: boolean } }`. Null when: no `client_id`; `getUser()` resolves null; `getUser()` throws (log once, `logError('mcp', 'token verification failed', { code })`). `enabledOrgIds` = ids from `org_settings` where `mcp_enabled = true` and `organization_id in` the distinct `organization_id`s of `user.locations` (plus `user.orgAdminOrgIds`).
  - `mcpEnabledOrgIds(db, user): Promise<string[]>` (the read above, exported for the consent page).
  - `resolveStudio(user, studioId: string | null): { ok: true, studio } | { ok: false, code: 'studio_not_found' | 'assistant_permission' }` — `studio` is the `user.locations` row (`id, name, timezone, organization_id`); default = `user.activeLocation` if it qualifies, else the first qualifying location; qualifying = the person holds `assistant` there (`hasPermissionForLocation(user, id, 'assistant')`). An id not in `user.locations` → `studio_not_found` (same code as an unknown uuid). An id in `user.locations` without `assistant` → `assistant_permission`.
  - `roleAt(user, studioId): string | null` — `'master'` when `user.isMaster`, else `user.rolesByLocation?.[studioId] ?? null`. `isManagerAt(user, studioId)` = role in `MANAGER_ROLES`; `isAdminAt` = in `ADMIN_ROLES` (both lists already contain `'master'`).
  - `recordToolCall(db, { profileId, organizationId, locationId, clientId, tool, ok, errorCode = null, durationMs }): Promise<void>` — one insert, `await`ed, `error` destructured and passed to `logError('mcp', 'tool call not recorded', …)`; never throws.

- [ ] **Step 1: Write the failing tests**

`src/lib/mcp/auth.test.js` (mock `getUser`; a fake db built with `makeFakeDb` from `src/lib/api-auth.test-helpers.js` with an `org_settings` table added to the fixture in the test):
```js
it('returns null for a token without client_id', …)
it('verifyMcpToken returns null when auth.getUser answers no user', …)   // getUser resolves null
it('verifyMcpToken returns null and logs when getCurrentUser throws', …)  // logError called once with 'mcp'
it('returns the user, enabled org ids and assistantAnywhere', …)         // two orgs, one enabled → enabledOrgIds has one id
```
`src/lib/mcp/context.test.js`:
```js
it('defaults to the active studio when the person holds assistant there', …)
it('falls back to the first studio with assistant when the active one lacks it', …)
it('answers studio_not_found for a studio outside user.locations and for a random uuid alike', …) // same code
it('answers assistant_permission for a member studio without the permission', …)
it('roleAt reads rolesByLocation and master overrides', …)
```
`src/lib/mcp/log.test.js`:
```js
it('inserts one row with the named columns and no args', …)   // the inserted object has exactly the nine keys
it('logs and resolves when the insert errors', …)
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run src/lib/mcp`
Expected: FAIL (modules missing)

- [ ] **Step 3: Implement the three modules**

`auth.js` header comment states the token-reach acceptance and the `client_id`-as-audience acceptance from the spec. `context.js` is pure (no db). `log.js` is the only writer of `mcp_tool_calls`.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run src/lib/mcp`
Expected: PASS

- [ ] **Step 5: Commit**

Stage `src/lib/mcp`. Subject: `MCP.1 — token verification, studio resolution and the call log`.

---

### Task 4: Tool registry core and `whoami`

**Files:**
- Create: `src/lib/agent-tools/registry.js`, `src/lib/agent-tools/index.js`, `src/lib/agent-tools/whoami.js`
- Test: `src/lib/agent-tools/registry.test.js`, `src/lib/agent-tools/whoami.test.js`, `tests/agent-tools-guard.test.js`

**Interfaces:**
- Consumes: Task 3 exports; `checkRateLimit` from `@/lib/rate-limit`; `todayStrIn` from `@/lib/location-time`.
- Produces:
  - `defineTool({ name, title, description, inputSchema, gate, run, writes = false, alwaysAvailable = false })` — returns the object frozen; `inputSchema` is a zod object that MUST include `studio_id: z.string().uuid().optional()` (the guard test checks the source); `gate(user, studioId, ctx) => boolean`; `run(input, ctx) => Promise<object>`.
  - `TOOLS: ReadonlyArray<Tool>` from `index.js` (every tool module's default export; order = the spec's list).
  - `runTool(tool, rawInput, auth: McpAuth, { db, nowMs = Date.now() } = {}): Promise<{ ok: true, data } | { ok: false, code, message }>` — in order: `inputSchema.safeParse` (→ `invalid_input` with zod's flattened message); `checkRateLimit(db, 'mcp:' + user.id, { max: 120, windowMs: 60_000 })` (→ `rate_limited`); `resolveStudio` (→ its code); unless `tool.alwaysAvailable`, `enabledOrgIds.includes(studio.organization_id)` (→ `mcp_disabled`, message "MCP is not switched on for this organisation. Ask an organisation admin."); `gate` (→ `forbidden`, message "Your role at <studio name> does not allow <title>."); then `run(input, ctx)` with `ctx = { db, user, studio, zone: studio.timezone, today: todayStrIn(zone), nowMs, role: roleAt(user, studio.id) }`; a thrown error → `{ ok: false, code: 'tool_failed' }` + `logError('mcp', …)`. Always ends with `recordToolCall` (ok/code, duration).
  - `toolResult(result)` — maps the above to the MCP content shape: `{ content: [{ type: 'text', text: JSON.stringify(data) }] }` or `{ isError: true, content: [{ type: 'text', text: JSON.stringify({ error: code, message }) }] }`.
  - `whoami` — `alwaysAvailable: true`, gate: anyone; returns `{ name, studios: [{ id, name, timezone, role, today, mcp_enabled, assistant }], tools: [names the person may call at the default studio], default_studio_id }`.

- [ ] **Step 1: Write the failing tests**

`registry.test.js` — a fixture tool `defineTool({ name: 'echo', inputSchema: z.object({ studio_id: …, text: z.string() }), gate: (u, s) => isManagerAt(u, s), run: async (i) => ({ text: i.text }) })` and a fake auth for a manager at studio A (org 1, enabled) who is staff at studio B (org 2, disabled):
```js
it('runs a tool for a manager at an enabled studio and records ok', …)
it('answers invalid_input with the zod message before touching the db', …)
it('answers forbidden at a studio where the gate says no and records the code', …)
it('runTool refuses a studio whose organisation has MCP off', …)   // code 'mcp_disabled'
it('answers rate_limited when checkRateLimit says no', …)
it('turns a thrown run into tool_failed and still records the call', …)
it('toolResult marks errors isError and serialises data as text', …)
```
`whoami.test.js`: `lists every studio with role, today in its zone and mcp_enabled, and the callable tool names` (two zones, the studio's own and `America/New_York`, with a fixed `nowMs` chosen so `today` differs between them).

`tests/agent-tools-guard.test.js` (house guard style, reads sources with `stripComments` from `tests/helpers/js-code.js`):
```js
it('every tool module calls defineTool with a studio_id in its inputSchema and a gate', …)
it('every tool is listed in index.js exactly once', …)
it('no tool names a forbidden table', …)   // the Global Constraints list, as .from('<t>') or an embed
it('every .from() in a tool is followed by a studio or contact-set filter within the same chain', …)
   // the chain must contain one of: .eq('location_id'  .in('location_id'  .in('id',  .eq('contact_id'  .in('contact_id'  .eq('id',
it('no tool selects * from profiles, locations or contacts', …)
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run src/lib/agent-tools tests/agent-tools-guard.test.js`
Expected: FAIL

- [ ] **Step 3: Implement registry.js, index.js, whoami.js**

- [ ] **Step 4: Run the tests**

Run: `npx vitest run src/lib/agent-tools tests/agent-tools-guard.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

Stage `src/lib/agent-tools` and the guard test. Subject: `MCP.1 — tool registry: gate, studio, org switch, rate limit, log; whoami`.

---

### Task 5: The route, the well-known metadata and the guard scripts

**Files:**
- Create: `src/app/api/mcp/route.js`, `src/app/.well-known/oauth-protected-resource/route.js`, `src/app/.well-known/oauth-protected-resource/api/mcp/route.js`, `src/lib/mcp/server.js`
- Modify: `package.json` (deps), `scripts/check-route-guards.mjs:117` (EXEMPT), `eslint.guardrails.config.mjs:192` (arm `no-unchecked-supabase-write` on `src/lib/mcp/**` and `src/lib/agent-tools/**`)
- Test: `src/lib/mcp/server.test.js`, `src/app/api/mcp/route.test.js`

**Interfaces:**
- Consumes: `createMcpHandler`, `withMcpAuth`, `protectedResourceHandler`, `metadataCorsOptionsRequestHandler` from `mcp-handler` (confirm names against the installed README); `TOOLS`, `runTool`, `toolResult` (Task 4); `verifyMcpToken` (Task 3); `getAppUrl`.
- Produces:
  - `buildMcpServer(server)` in `server.js`: for each tool in `TOOLS`, `server.registerTool(tool.name, { title, description, inputSchema: tool.inputSchema }, async (args, extra) => toolResult(await runTool(tool, args, extra.authInfo, { db: createServerClient() })))`. Exported so the test can call it with a fake `server` and assert the registrations.
  - `isCanonicalHost(request): boolean` in `server.js`: `new URL(request.url).host === new URL(getAppUrl()).host`.
  - Route: `runtime = 'nodejs'`, `dynamic = 'force-dynamic'`, `maxDuration = 60`; `GET`/`POST`/`DELETE` = a wrapper that answers `404` when `!isCanonicalHost(request)` and otherwise delegates to `withMcpAuth(createMcpHandler(buildMcpServer, { serverInfo: { name: 'repset-crm', version: '1' } }), (req, token) => verifyMcpToken(token), { required: true, resourceMetadataPath: '/.well-known/oauth-protected-resource/api/mcp' })`.
  - Well-known routes: `GET` = `protectedResourceHandler({ authServerUrls: [process.env.NEXT_PUBLIC_SUPABASE_URL + '/auth/v1'] })`, `OPTIONS` = the CORS helper. Both paths serve the same document (clients derive the path from the resource URL in different ways).

- [ ] **Step 1: Install the dependencies**

Run: `npm install mcp-handler@^2 @modelcontextprotocol/server@^2`
Expected: both in `package.json` dependencies; `npm ls mcp-handler` clean. Then read `node_modules/mcp-handler/README.md` and `node_modules/mcp-handler/docs/AUTHORIZATION.md`; if a name in this task differs from the installed API, use the installed name and say so in the commit body.

- [ ] **Step 2: Write the failing tests**

`src/lib/mcp/server.test.js`:
```js
it('registers every tool in TOOLS by name with its schema', …)   // registered names deep-equal TOOLS.map(t => t.name)
it('isCanonicalHost compares against NEXT_PUBLIC_APP_URL', …)    // vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://crm.repset.ie')
```
`src/app/api/mcp/route.test.js` (mock `mcp-handler` so `withMcpAuth` returns a function that records it was called):
```js
it('answers 404 on a non-canonical host before touching auth', …)
it('delegates to the auth-wrapped handler on the canonical host', …)
```

- [ ] **Step 3: Run them to verify they fail**

Run: `npx vitest run src/lib/mcp/server.test.js src/app/api/mcp/route.test.js`
Expected: FAIL

- [ ] **Step 4: Implement server.js, the three routes, the EXEMPT entries and the guardrails arming**

EXEMPT reason for `/api/mcp`: `'MCP.1 — authenticates inside withMcpAuth → verifyMcpToken (src/lib/mcp/auth.js): an OAuth-issued Supabase JWT resolved through getCurrentUser; every tool re-checks role, studio and org switch in runTool.'` The two well-known routes: `'RFC 9728 protected-resource metadata; public by definition, no data.'`

- [ ] **Step 5: Run the tests, the guards and the build**

Run: `npx vitest run src/lib/mcp src/app/api/mcp && npm run check:route-guards && npm run check:guardrails && npm run build`
Expected: PASS; build succeeds (the first real check that the ESM packages resolve under Turbopack).

- [ ] **Step 6: Commit**

Stage `package.json`, `package-lock.json`, `src/app/api/mcp`, `src/app/.well-known`, `src/lib/mcp/server.js` + test, the two scripts/config files. Subject: `MCP.1 — /api/mcp route on mcp-handler with Supabase OAuth, plus the protected-resource metadata`.

---

### Task 6: Roster and time-off tools

**Files:**
- Create: `src/lib/agent-tools/get-shifts.js`, `get-time-off.js`, `get-holiday-allowance.js`, `list-staff.js`, `list-shift-templates.js`, `create-shift.js`, `staff-hours-report.js`, `staff-cost-report.js`, `_staff-report.js`
- Modify: `src/lib/agent-tools/index.js`
- Test: `src/lib/agent-tools/roster-tools.test.js`

**Interfaces:**
- Consumes: `fetchApiShiftRows(db, { locationIds, startDate, endDate, publishedOnly, viewer })` (`@/lib/roster-read`); `effectiveShiftStart/End` (`@shared/roster-month`); `reportPeriodError` (`@/lib/report-period`); `isRealCalendarDate` (`@/lib/schemas`); `parseAllowanceYear`; `getHolidayAllowance(db, profileId, year)` + `getPendingHolidayDays` (`@/lib/time-off-leave`); `upsertShiftAssignment(db, { locationId, profileId, shiftTemplateId, shiftDate, actorId })` (`@/lib/roster-write`); `fetchScheduledShiftRows(db, { locationId, periodStart, periodEnd })` + `shiftHours`; `RATE_REPORT_VIEWER_ROLES` (`@/lib/report-access`); `isManagerAt`, `roleAt` (Task 3).
- Produces (tool name → input → gate → output):
  - `get_shifts` `{ studio_id?, start: date, end: date }` (≤ 31 days) → anyone → `{ studio, zone, shifts: [{ id, date, start, end, profile_id, name, template }], unpublished_days: [], capped }`. Managers see drafts (`publishedOnly: false`), others published only; `viewer = { id: user.id, isManagerAt: (loc) => isManagerAt(user, loc) }`.
  - `get_time_off` `{ studio_id?, start, end }` (≤ 366 days) → anyone; non-managers get `.eq('profile_id', user.id)`; select `id, profile_id, type, status, start_date, end_date, reason`; names from `profiles` by id list (`id, full_name`).
  - `get_holiday_allowance` `{ profile_id?, year? }` → own: anyone; another person: `isManagerAt` and that person has a `profile_locations` row at the studio → `{ profile_id, year, entitlement_days, used_days, pending_days, remaining_days }` via `getHolidayAllowance` + `getPendingHolidayDays`.
  - `list_staff` `{ studio_id? }` → `isManagerAt` → `[{ id, name, role, employment_type }]` from `profile_locations` (`profile_id, role`) joined to `profiles` (`id, full_name, employment_type, active`) active only. NO email, phone, pay.
  - `list_shift_templates` `{ studio_id? }` → `isManagerAt` → `shift_templates` where `location_id` and `active`, columns `id, name, start_time, end_time, role`.
  - `create_shift` `{ studio_id?, profile_id, shift_template_id, date }` → `isManagerAt`, `writes: true` → `upsertShiftAssignment` with `actorId: user.id`; returns the helper's result.
  - `staff_hours_report` `{ studio_id?, start, end }` → `isManagerAt`; `staff_cost_report` same input → `RATE_REPORT_VIEWER_ROLES.includes(role)`; both call `_staff-report.js`, which holds the per-profile aggregation copied out of `src/app/api/assistant/chat/route.js:373-466` (the assistant route stays as is).

- [ ] **Step 1: Write the failing tests** (`roster-tools.test.js`, one `describe` per tool, helpers mocked with `vi.mock`)

```js
it('get_shifts refuses a range over 31 days and a bad date', …)      // invalid_input; message names 31
it('get_shifts passes publishedOnly=true for staff and false for a manager', …)
it('get_time_off filters to the caller for staff only', …)
it('get_holiday_allowance for another person needs a manager and a membership at the studio', …)
it('list_staff never returns email, phone or pay fields', …)         // object keys exactly id,name,role,employment_type
it('create_shift calls upsertShiftAssignment with actorId = the caller', …)
it('staff_cost_report is refused for a head coach and allowed for a manager', …)
```

- [ ] **Step 2: Run to verify failure** — `npx vitest run src/lib/agent-tools/roster-tools.test.js` → FAIL

- [ ] **Step 3: Implement the eight tools and `_staff-report.js`; add them to `index.js`**

- [ ] **Step 4: Run** — `npx vitest run src/lib/agent-tools tests/agent-tools-guard.test.js && npm run check:select-columns` → PASS

- [ ] **Step 5: Commit** — subject `MCP.1 — roster, time-off and staff report tools`

---

### Task 7: Contacts, pipeline and task tools

**Files:**
- Create: `src/lib/agent-tools/search-contacts.js`, `get-contact.js`, `list-pipeline.js`, `list-tasks.js`, `create-contact.js`, `create-activity.js`, `_contact-scope.js`
- Modify: `src/lib/agent-tools/index.js`
- Test: `src/lib/agent-tools/contact-tools.test.js`

**Interfaces:**
- Consumes: `sanitizeSearchTerm`, `MIN_CONTACT_SEARCH_LEN` (`@/lib/command-palette`); `contactsAtStudio(db, locationId, { contactIds })` and `studiosOfContact(db, contactId)` (`@/lib/contact-studios`); `membershipRowsFromStudioRows`, `MEMBERSHIP_FACT_READ_COLS` (`@/lib/membership/membership-facts`); `mergeTimeline` (`@/lib/contact-view`); `pipelineDealSelect('active')`, `boardDealMapper()` (`@/lib/pipeline-board`); `canWriteActivitiesAt` (`@/lib/activity-write-gate`); `maybeProvisionLeadInGlofox`, `triggerSequencesForContactCreated` (dynamic imports, as the assistant does); `hasPermissionForLocation`; `isAdminAt`, `isManagerAt` (Task 3).
- Produces:
  - `_contact-scope.js`: `readableContactStudios(user, ctx): string[]` (the person's studios that are in the resolved studio's organisation, whose organisation is in `ctx.enabledOrgIds`, and where `hasPermissionForLocation` grants both `assistant` and `contacts`); `contactReadableAt(db, user, contactId, ctx): Promise<string | null>` — the first readable studio where the contact is `location_id`-homed or has a `contact_studios` row (`studiosOfContact`); null → the tool answers `not_found`.
  - `search_contacts` `{ studio_id?, query }` → Contacts at the studio → ≤ 20 of `id, name, email, phone, location_id, pipeline_stage_slug, lead_source`: one read `.eq('location_id', studio)` and one `.in('id', contactsAtStudio ids)` merged by id (an `.or` across them is not expressible safely); term sanitised; `MIN_CONTACT_SEARCH_LEN` enforced as `invalid_input`.
  - `get_contact` `{ contact_id }` → `contactReadableAt` non-null → `{ contact: { id, name, email, phone, lead_source, pipeline_stage_slug, created_at }, studios: [{ location_id, kind, status, source, membership: { plan, status, since, ended_at } }], deals: [{ id, title, pipeline, stage, stage_entered_at }], timeline: ≤ 20 of mergeTimeline(notes, activities) reduced to { date, activityType, subject } (notes: `content` truncated to 200 chars), class_bookings: last 30 / next 30 days { starts_at, class_name, status, attended, platform } }`.
  - `list_pipeline` `{ studio_id?, pipeline_id?, stage_slug? }` → `pipeline` permission at studio → stages from `pipeline_stages` (`id, name, slug, position, pipeline_id`) at `location_id`, deals via `pipelineDealSelect('active')` filtered `.in('stage_id', …)` capped 50 per stage, mapped with `boardDealMapper()`; output grouped by stage with `count` and `capped`.
  - `list_tasks` `{ studio_id?, assignee: 'me' | 'all' = 'me', due: 'overdue' | 'today' | 'week' = 'week' }` → `canWriteActivitiesAt(user, studio)` → `activities` `done = false`, `location_id = studio`, `due_date` window relative to `ctx.today`; columns from `TASK_ROW` in `src/app/api/activities/tasks/route.js`, and `assignee` on the owner column that file filters by.
  - `create_contact` `{ studio_id?, name, email, phone?, lead_source? }` → `isAdminAt`, `writes: true` → exactly the assistant's insert + the two hooks; on `23505` (`contacts_email_org_unique`) read the existing contact by `email` within the org's location ids and return `{ existing: true, contact }`.
  - `create_activity` `{ studio_id?, contact_id, type: 'call' | 'meeting' | 'task', subject, due_date?, note? }` → `isManagerAt` AND `canWriteActivitiesAt`, `writes: true` → the assistant's insert, contact checked through `contactReadableAt` first.

- [ ] **Step 1: Write the failing tests** (`contact-tools.test.js`)

```js
it('search_contacts sanitises the term and refuses one under the minimum length', …)
it('search_contacts needs Contacts at the studio, not just a role', …)        // owner without contacts → forbidden
it('get_contact answers not_found for a contact at a studio the person cannot read', …)   // same code+message as a random uuid
it('get_contact timeline is capped at 20 and carries no message bodies', …)
it('list_pipeline groups by stage and marks a capped stage', …)
it('create_contact returns the existing contact on the org email unique violation', …)
it('create_activity needs manager AND the activities write gate', …)
```

- [ ] **Step 2: Run to verify failure** → FAIL

- [ ] **Step 3: Implement the six tools and the scope helper; add to index.js**

- [ ] **Step 4: Run** — `npx vitest run src/lib/agent-tools tests/agent-tools-guard.test.js && npm run check:select-columns && npm run check:guardrails` → PASS

- [ ] **Step 5: Commit** — subject `MCP.1 — contacts, pipeline and task tools`

---

### Task 8: Classes and appointments tools

**Files:**
- Create: `src/lib/agent-tools/get-classes.js`, `get-class-roster.js`, `get-appointments.js`
- Modify: `src/lib/agent-tools/index.js`
- Test: `src/lib/agent-tools/class-tools.test.js`

**Interfaces:**
- Consumes: `zonedWallClockToInstant` (`@/lib/location-time`) to turn a `YYYY-MM-DD` day in the studio zone into the `starts_at` window; `mapBookingToRosterRow` (`@/lib/class-bookings`) for the status vocabulary; `readableContactStudios` (Task 7); `hasPermissionForLocation`.
- Produces:
  - `get_classes` `{ studio_id?, date?, start?, end? }` (one day, or ≤ 14 days; default today) → anyone → `class_occurrences` (`id, glofox_event_id, name, program, starts_at, ends_at, capacity, instructor, source_platform`) at `location_id` in the window, plus counts from `class_bookings` (`glofox_event_id, status`) per event: `booked` = status not cancelled/waitlisted, `waitlisted` = waitlisted statuses. Output `[{ id, starts_at, ends_at, name, trainer, capacity, booked, waitlisted, platform }]`.
  - `get_class_roster` `{ occurrence_id }` → `class_roster` permission AND Contacts at the occurrence's studio → the occurrence (`not_found` if its `location_id` is not in `readableContactStudios`) and `class_bookings` for its `glofox_event_id` at that studio: `[{ contact_id, name, status, attended }]`.
  - `get_appointments` `{ studio_id?, start, end }` (≤ 31 days) → `bookings` permission → `bookings` (`id, booking_date, start_time, end_time, status, contact_id, event_types(name, slug), contacts!contact_id(name)`) at `location_id` in the window.

- [ ] **Step 1: Write the failing tests**

```js
it('get_classes builds the window in the studio zone and counts booked and waitlisted per event', …)
it('get_classes refuses more than 14 days', …)
it('get_class_roster answers not_found when the occurrence is at an unreadable studio', …)
it('get_appointments needs the bookings permission and caps the range at 31 days', …)
```

- [ ] **Step 2: Run to verify failure** → FAIL
- [ ] **Step 3: Implement; add to index.js**
- [ ] **Step 4: Run** — `npx vitest run src/lib/agent-tools tests/agent-tools-guard.test.js && npm run check:select-columns && npm run check:guardrails` → PASS
- [ ] **Step 5: Commit** — subject `MCP.1 — classes, class roster and appointment tools`

---

### Task 9: Consent page and the four allowlists

**Files:**
- Create: `src/app/oauth/consent/page.js`, `src/components/OAuthConsentForm.jsx`
- Modify: `src/proxy.js:267`, `src/components/AppShell.jsx:81`, `src/lib/brands.js:93`, `src/lib/tenant-domains-edge.js:119`
- Test: `src/components/OAuthConsentForm.test.jsx`, `src/app/oauth/consent/page.test.js`, `src/public-compliance-paths.test.jsx` (new section)

**Interfaces:**
- Consumes: `getCurrentUser`, `hasPermissionAtAnyLocation`, `mcpEnabledOrgIds` (Task 3), `createBrowserClient` (`@/lib/supabase`), `safeInternalPath` (`@/lib/urlish`).
- Produces:
  - `page.js` (server): reads `searchParams.authorization_id`; missing → render "This link is incomplete"; no user → `redirect('/login?redirect=' + encodeURIComponent('/oauth/consent?authorization_id=' + id))`; computes `eligibility = { ok: boolean, reason: null | 'mcp_disabled' | 'assistant_permission' }` (ok when `mcpEnabledOrgIds` non-empty AND `hasPermissionAtAnyLocation(user, 'assistant')`); renders `<OAuthConsentForm authorizationId eligibility personName />`.
  - `OAuthConsentForm` (`'use client'`): on mount `supabase.auth.oauth.getAuthorizationDetails(id)`; a reply with no `authorization_id` → `window.location.assign(reply.redirect_url)`; shows `client.name`, the plain-words capability list from the spec (three lines), Approve (disabled with the reason copy when `!eligibility.ok`) and Deny (always enabled), both `type="button"`; `approveAuthorization` / `denyAuthorization` then `window.location.assign(redirect_url)`; errors inline.
  - Copy for the two refusals: `"MCP access is not switched on for your organisation. Ask an organisation admin."` and `"Ask an admin to switch on AI Assistant for you."`

- [ ] **Step 1: Write the failing tests**

`page.test.js`: `redirects to /login with the consent path preserved when signed out`; `passes eligibility mcp_disabled when no org has it on`; `passes eligibility assistant_permission when the permission is held nowhere`.
`OAuthConsentForm.test.jsx` (RTL): `renders the client name and disables Approve with the reason when ineligible`; `calls approveAuthorization and assigns the redirect_url`; `follows redirect_url straight away when the client is already approved`; `every button has type="button"`.
`public-compliance-paths.test.jsx`: a new section `'/oauth/consent'` following the file's pattern (proxy admits anonymously; AppShell renders; both brand tiers allow).

- [ ] **Step 2: Run to verify failure** → FAIL

- [ ] **Step 3: Implement the page, the form and the four allowlist entries** (`'/oauth/consent'` in all four; proxy and brands are raw prefixes, AppShell is segment-aware). `safeInternalPath` keeps the `?authorization_id=` query (root-relative, no whitespace); if `/login`'s redirect handling drops queries, fix it there with a test.

- [ ] **Step 4: Run** — `npx vitest run src/app/oauth src/components/OAuthConsentForm.test.jsx src/public-compliance-paths.test.jsx src/proxy.test.js && npm run check:guardrails` → PASS

- [ ] **Step 5: Commit** — subject `MCP.1 — /oauth/consent: Supabase OAuth consent page, public on every host`

---

### Task 10: Organisation switch — route and Integrations hub card

**Files:**
- Create: `src/app/api/settings/org-mcp/route.js`, `src/components/settings/AgentAccessCard.jsx`
- Modify: `src/app/settings/integrations-hub/page.js` (pass `mcp` per managed org), `src/components/settings/IntegrationsHub.jsx:~949` (render the card beside "Organisation numbers"), `src/lib/openapi.js`
- Test: `src/app/api/settings/org-mcp/route.test.js`, `src/components/settings/AgentAccessCard.test.jsx`

**Interfaces:**
- Consumes: `resolveAdminOrgId(user, requested)`, `isOrgAdminSomewhere` (`@/lib/org-admin`); `validateBody`, `uuidLike`; `getAppUrl`.
- Produces:
  - `GET /api/settings/org-mcp?organization_id=` → `{ success, data: { organization_id, mcp_enabled, connector_url, people_30d } }` (`people_30d` = count of distinct `profile_id` in `mcp_tool_calls` for the org in the last 30 days).
  - `PUT /api/settings/org-mcp` body `{ organization_id?, enabled: boolean }` → upsert `org_settings` `{ organization_id, mcp_enabled, updated_by: user.id }` (`await`, `error` handled) → `{ success, data: { mcp_enabled } }`. 401 / 403 as `org-branding`.
  - `AgentAccessCard({ organization, mcp, canManage })` (`'use client'`): switch (PUT), the connector URL with a copy button, one paragraph "In Claude: Settings → Connectors → Add custom connector → paste this URL. In Claude Code: `claude mcp add --transport http repset <url>`.", and "<n> people used it in the last 30 days".

- [ ] **Step 1: Write the failing tests** — route: `refuses a studio owner who is not an org admin (403)`, `writes mcp_enabled and updated_by for an org admin`, `GET counts distinct people in 30 days`; card: `renders the URL and toggles via PUT`, `every button is type=button`.
- [ ] **Step 2: Run to verify failure** → FAIL
- [ ] **Step 3: Implement route, card, hub wiring, openapi registration**
- [ ] **Step 4: Run** — `npx vitest run src/app/api/settings/org-mcp src/components/settings/AgentAccessCard.test.jsx src/app/settings/integrations-hub && npm run check:route-guards && npm run check:location-scoping` → PASS
- [ ] **Step 5: Commit** — subject `MCP.1 — organisation switch: /api/settings/org-mcp and the Agent access card in the hub`

---

### Task 11: Connected apps on /account

**Files:**
- Create: `src/app/api/account/connected-apps/route.js`, `src/components/ConnectedAppsCard.jsx`
- Modify: `src/app/account/page.js:112` (render the card under `CalendarFeedCard`), `src/lib/openapi.js`
- Test: `src/app/api/account/connected-apps/route.test.js`, `src/components/ConnectedAppsCard.test.jsx`

**Interfaces:**
- Produces:
  - `GET /api/account/connected-apps` → `{ success, data: { clients: [{ client_id, last_used_at, calls_7d }] } }` from `mcp_tool_calls` where `profile_id = user.id` (`client_id, created_at`, last 7 days; grouped in JS). The grant list itself is read in the browser.
  - `ConnectedAppsCard()` (`'use client'`): `createBrowserClient().auth.oauth.listGrants()` → rows `{ client.name, created_at, last_used_at (from the route by client_id), calls_7d }`, a Revoke button (`window.confirm`, then `revokeGrant({ clientId })`, then reload); empty state "Nothing connected. Add the CRM in Claude from <connector URL>."; every button `type="button"`.

- [ ] **Step 1: Write the failing tests** — route: `only the caller's own rows, grouped by client with last_used_at and calls_7d`; card: `lists grants with usage and revokes through revokeGrant`.
- [ ] **Step 2: Run to verify failure** → FAIL
- [ ] **Step 3: Implement**
- [ ] **Step 4: Run** — `npx vitest run src/app/api/account/connected-apps src/components/ConnectedAppsCard.test.jsx && npm run check:route-guards && npm run check:location-scoping` → PASS (the route reads `mcp_tool_calls` by `profile_id`, a per-user row; if the scoping scan flags it, register the reason in `EXEMPT`, never a bare skip)
- [ ] **Step 5: Commit** — subject `MCP.1 — Connected apps card on /account with revoke`

---

### Task 12: Call-log retention cron

**Files:**
- Create: `src/app/api/cron/purge-mcp-tool-calls/route.js`, `supabase/migrations/802_mcp_tool_calls_purge_heartbeat.sql`
- Modify: `vercel.json:234` (add `{ "path": "/api/cron/purge-mcp-tool-calls", "schedule": "35 4 * * *" }`)
- Test: `src/app/api/cron/purge-mcp-tool-calls/route.test.js`

**Interfaces:**
- Consumes: the shape of `src/app/api/cron/purge-webhook-payloads/route.js` (CRON_SECRET check, `.range()` pages of 500, `MAX_PAGES` 20, `stampHeartbeat('purge-mcp-tool-calls', { cutoff, deleted })` only on success).
- Produces: `RETENTION_DAYS = 90`; the heartbeat row `('purge-mcp-tool-calls', now(), 86400, 43200, '…')` in mig 802, applied AFTER the code deploys (Rollout step 3).

- [ ] **Step 1: Write the failing tests** — `refuses without CRON_SECRET`, `deletes rows older than 90 days in pages and stamps`, `does not stamp when a delete errors`.
- [ ] **Step 2: Run to verify failure** → FAIL
- [ ] **Step 3: Implement route, vercel.json entry, migration 802**
- [ ] **Step 4: Run** — `npx vitest run src/app/api/cron/purge-mcp-tool-calls && grep -L stampHeartbeat src/app/api/cron/*/route.js` → PASS; the grep lists only `health-check` and `ad-insights-backfill`.
- [ ] **Step 5: Commit** — subject `MCP.1 — purge-mcp-tool-calls: 90-day retention of the call log`

---

### Task 13: Docs, CI mirror, PR

**Files:**
- Modify: `docs/architecture/INTEGRATIONS.md` (new "Staff MCP server" section: dashboard steps, Site URL move, DCR, the canonical URL, how to connect from Claude / Claude Code, where the switch and the Connected apps card are, what is logged), `CLAUDE.md` Invariants (one bullet: an OAuth-issued token opens `/api/mcp` only; every tool lives in `src/lib/agent-tools/` and declares a gate and a studio; `tests/agent-tools-guard.test.js`), `docs/domain-migration-stage3.md` (tick item 8 once done in the dashboard)
- Create after the PR exists: `docs/changelog/entries/<PR>.md`

- [ ] **Step 1: Write the docs**
- [ ] **Step 2: Run the full CI mirror**

Run: `npm test && npm run lint && npm run check:mobile-parity && npm run check:mobile-imports && npm run check:mobile-lint && npm run check:route-guards && npm run check:location-scoping && npm run check:rls-restrictive && npm run check:guardrails && npm run check:select-columns && npm run check:rpc-names && npm run check:bundle-sql && npm run check:ota-paths`
Expected: all green. Then `npm run build` once more (Tasks 9-12 added routes after Task 5's build). Never run the full suite and the build at the same time (8 GB machine).

- [ ] **Step 3: Push and open the PR**

Push the branch and open a PR against `main` titled `MCP.1 — staff MCP server`. Body: what shipped; the dashboard steps that must happen BEFORE enabling for an org (OAuth server on, authorization path, DCR, Site URL); mig 801 before deploy and 802 after; the token-reach acceptance; the week-one test plan. End with `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.

- [ ] **Step 4: Add the changelog entry and push**

`docs/changelog/entries/<PR>.md`, one row keyed `#<PR>`.

---

## Rollout (operator steps, not code)

1. Supabase dashboard, one window: Site URL → `https://crm.repset.ie`; send yourself an invite and a password reset and follow both; Authentication → OAuth Server: enable, Authorization Path `/oauth/consent`, dynamic client registration ON.
2. Apply mig 801 via Supabase MCP (`apply_migration`, project `iyvtbjjxdggiadzwwvdj`); `get_advisors` security.
3. Merge; after the deploy is live apply mig 802.
4. Vercel: confirm the project's firewall does not challenge `/api/mcp` (Anthropic's cloud IPs).
5. `/settings/integrations-hub` → Agent access → on for UN1T Group. Richard connects from Claude Desktop and Claude Code; MCP Inspector for raw output.
6. One manager or head coach, one studio, one week. Review `mcp_tool_calls` by tool and `error_code`.
