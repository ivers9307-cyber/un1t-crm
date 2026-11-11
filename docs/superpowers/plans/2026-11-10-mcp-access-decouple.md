# MCP access decouple (MCPACCESS.1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Gate the staff MCP server on a new `mcp_access` web permission instead of `assistant`, so MCP works while the paid in-app assistant stays switched off.

**Architecture:** A new key in the existing three-tier permission model. Three enforcing call sites on the MCP surface swap keys, two informational ones follow, and the refusal code and its operator-facing copy are renamed so a refusal no longer points people at the AI Assistant switch. No migration, no new route, no tool changes.

**Tech Stack:** Next.js 16 App Router, Supabase, vitest. Permission model in `shared/permissions.js` + `shared/permission-bundles.js`.

**Spec:** [`docs/superpowers/specs/2026-11-10-mcp-access-decouple-design.md`](../specs/2026-11-10-mcp-access-decouple-design.md)

## Global Constraints

- `locations.features->'assistant'` stays `false` everywhere. The in-app assistant is not re-enabled, capped, or migrated onto `src/lib/agent-tools/`.
- No migration. The key lives in code; grants use mig 058's `profile_locations.permissions` JSONB; no RLS policy asks about this key.
- Role defaults: `true` for **master** and **owner** only; explicit `false` for manager, head_coach, staff, reception.
- `KEY_BUNDLES` gets `mcp_access: ['bundle_sales']`, matching `assistant`.
- The key stays subject to the tier-1 location gate. Do not add it to `NOTIFY_KEYS` or `APPROVAL_SUBPERMISSION_KEYS`.
- Label is exactly `Connect an Agent`. Not "Agent access" — that name belongs to the hub's org-level switch card.
- Branch off fresh `origin/main`. `main` is branch-protected: PR required, **Test & lint** and **Next build** must be green, branch up to date.
- Run the full thirteen-command CI mirror from CLAUDE.md before pushing, plus `npm run build`.

## Review Focus

Five classes the spec implies but would otherwise ship untested. Each has a test placed in the task that owns the code.

1. **A person holding the key at studio A but not studio B, asking about B explicitly.** Must refuse, never silently fall back to A. This is the exact shape of the Pride Training Club bug the spec exists to prevent. → Task 2.
2. **A location with `features.mcp_access === false`.** The per-studio off switch must deny even master, or the switch is decorative. → Task 1.
3. **`assistant` true and `mcp_access` false, and the reverse.** Both directions, or the decouple could pass while a site still reads the old key. → Task 2.
4. **`features.bundle_sales === false` at a location.** Must deny `mcp_access`, or the `KEY_BUNDLES` entry is wrong and the tier gate is bypassable. → Task 1.
5. **`mcp_access` true but `contacts` false.** `readableContactStudios` must return `[]` — a careless swap can replace both checks or drop the `contacts` half. → Task 2.

---

## File Structure

| File | Responsibility | Task |
|---|---|---|
| `shared/permissions.js` | The key's registry entry and its six role defaults | 1 |
| `shared/permission-bundles.js` | The key's tier mapping | 1 |
| `scripts/check-mobile-parity.mjs` | Records that the key is deliberately web-only | 1 |
| `src/lib/mcp/context.js` | `resolveStudio` — the per-studio gate every tool passes through | 2 |
| `src/lib/agent-tools/_contact-scope.js` | The contact-set fence | 2 |
| `src/app/oauth/consent/page.js` | Whether a client can be approved at all | 2 |
| `src/lib/mcp/auth.js` | The door's carried flag (informational) | 2 |
| `src/lib/agent-tools/whoami.js` | Reports what gated the call (informational) | 2 |
| `src/lib/agent-tools/registry.js` | The refusal code and its message | 3 |
| `src/components/OAuthConsentForm.jsx` | The consent page's refusal copy | 3 |
| `CLAUDE.md`, `docs/architecture/INTEGRATIONS.md` | The invariant and the integration doc | 3 |

---

### Task 1: Register the `mcp_access` permission

After this task the key exists and resolves correctly for every role and every gate tier. Nothing uses it yet.

**Files:**
- Modify: `shared/permissions.js` — add to `WEB_PERMISSIONS` beside `assistant` (`:100`); add one entry per role in `DEFAULT_WEB_PERMISSIONS_BY_ROLE` (the `assistant` values sit at `:350` master, `:385` staff, `:425` reception, `:460` head_coach, `:497` manager, `:534` owner)
- Modify: `shared/permission-bundles.js:122` — add to `KEY_BUNDLES` beside `assistant`
- Modify: `scripts/check-mobile-parity.mjs:76` — add to `WEB_ONLY_OK`
- Test: `shared/permissions.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces: the string key `'mcp_access'`, resolvable through the existing `resolvePermission({ role, location, permissions, roleTemplate, defaults, key })`. Task 2 reaches it via `hasPermissionForLocation(user, locationId, 'mcp_access')` and `hasPermissionAtAnyLocation(user, 'mcp_access')`, both already exported from `src/lib/permissions.js` and unchanged.

- [ ] **Step 1: Write the failing tests**

Add one `describe('resolvePermission — mcp_access (MCPACCESS.1)')` block to `shared/permissions.test.js`, following the file's existing idiom (import `resolvePermission` and `DEFAULT_WEB_PERMISSIONS_BY_ROLE`, pass `location`/`permissions`/`defaults` explicitly):

```js
it('defaults true for master and owner only', () => {
  for (const role of ['master', 'owner']) {
    expect(resolvePermission({ role, location: { features: {} }, permissions: null,
      defaults: DEFAULT_WEB_PERMISSIONS_BY_ROLE, key: 'mcp_access' })).toBe(true)
  }
  for (const role of ['manager', 'head_coach', 'staff', 'reception']) {
    expect(resolvePermission({ role, location: { features: {} }, permissions: null,
      defaults: DEFAULT_WEB_PERMISSIONS_BY_ROLE, key: 'mcp_access' })).toBe(false)
  }
})

// Review Focus 2 — the per-studio off switch must bind master too.
it('is denied by an explicit location false, even for master', () => {
  expect(resolvePermission({ role: 'master', location: { features: { mcp_access: false } },
    permissions: null, defaults: DEFAULT_WEB_PERMISSIONS_BY_ROLE, key: 'mcp_access' })).toBe(false)
})

// Review Focus 4 — the bundle entry must actually bind.
it('is denied when bundle_sales is off at the location, even for master', () => {
  expect(resolvePermission({ role: 'master', location: { features: { bundle_sales: false } },
    permissions: null, defaults: DEFAULT_WEB_PERMISSIONS_BY_ROLE, key: 'mcp_access' })).toBe(false)
})

it('is location-gated (not notify-exempt, not approvals-exempt)', () => {
  expect(isFeatureGatedByLocation('mcp_access')).toBe(true)
})

it('a per-user override wins over the role default for manager', () => {
  expect(resolvePermission({ role: 'manager', location: { features: {} },
    permissions: { mcp_access: true }, defaults: DEFAULT_WEB_PERMISSIONS_BY_ROLE,
    key: 'mcp_access' })).toBe(true)
})
```

Add `isFeatureGatedByLocation` to the file's existing import list from `./permissions.js`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- shared/permissions.test.js`
Expected: FAIL — the role-default and bundle assertions return `false`/`true` wrongly because the key is unregistered.

- [ ] **Step 3: Register the key**

In `shared/permissions.js`, immediately after the `assistant` entry in `WEB_PERMISSIONS`:

```js
{ key: 'mcp_access', label: 'Connect an Agent',
  hint: 'Connect Claude or another MCP client to the CRM as yourself. Not the in-app chat.' },
```

Add `mcp_access: true` to the `master` and `owner` maps and `mcp_access: false` to `manager`, `head_coach`, `staff` and `reception` in `DEFAULT_WEB_PERMISSIONS_BY_ROLE` — all six written explicitly, so the map reads as a decision. Place each beside that role's `assistant` line.

In `shared/permission-bundles.js`, add `mcp_access: ['bundle_sales'],` to `KEY_BUNDLES` beside `assistant`, with a one-line comment saying why it is bundled (an unbundled key is never bundle-denied, which would bypass the tier gate).

- [ ] **Step 4: Record the parity decision**

In `scripts/check-mobile-parity.mjs`, add to `WEB_ONLY_OK`:

```js
mcp_access: 'MCPACCESS.1: MCP is a desktop/CLI connector (Claude Desktop, Claude Code). No phone counterpart — the mobile `assistant` key stays mapped to web `assistant`.',
```

- [ ] **Step 5: Run the tests and the parity gate**

Run: `npm test -- shared/permissions.test.js && npm run check:mobile-parity`
Expected: PASS, and the parity check reports no unmatched web key.

- [ ] **Step 6: Commit**

```bash
git add shared/permissions.js shared/permissions.test.js shared/permission-bundles.js scripts/check-mobile-parity.mjs
git commit -m "MCPACCESS.1 — register the mcp_access web permission

Master and owner by default (Richard, 10 Nov); explicit false for the
other four roles. Bundled under bundle_sales like assistant, because an
unbundled key is never bundle-denied and would bypass the tier gate.
Web-only, recorded in WEB_ONLY_OK. Nothing reads the key yet."
```

---

### Task 2: Point the MCP surface at `mcp_access`

After this task MCP is gated on the new key and works at studios where `features.assistant` is `false`. The refusal *copy* still names AI Assistant — Task 3 fixes that.

**Files:**
- Modify: `src/lib/mcp/context.js:15,19,23,30,38`
- Modify: `src/lib/agent-tools/_contact-scope.js:35`
- Modify: `src/app/oauth/consent/page.js:65,69`
- Modify: `src/lib/mcp/auth.js:27,76,107`
- Modify: `src/lib/agent-tools/whoami.js:42`
- Test: `src/lib/mcp/context.test.js`, `src/lib/mcp/auth.test.js`, `src/lib/agent-tools/whoami.test.js`, and the fixture context in `src/lib/agent-tools/registry.test.js:42`, `class-tools.test.js:41`, `roster-tools.test.js:51`, `contact-tools.test.js:69`

**Interfaces:**
- Consumes: the `'mcp_access'` key from Task 1.
- Produces: `resolveStudio(user, studioId)` keeps its signature and its two refusal codes (`'studio_not_found'`, `'assistant_permission'` — renamed in Task 3). `verifyMcpToken`'s `extra` carries `mcpAccessAnywhere: boolean` in place of `assistantAnywhere`; nothing in `src/` reads it, only tests. `readableContactStudios(user, ctx)` keeps its signature and returns location ids.

- [ ] **Step 1: Write the failing tests**

In `src/lib/mcp/context.test.js`, extend the `describe('resolveStudio')` block. Build users whose `assistant` and `mcp_access` differ, following the file's existing user-fixture shape:

```js
// Review Focus 3 — the whole point of the decouple, both directions.
it('resolves a studio for someone holding mcp_access but not assistant', () => { /* expect ok: true */ })
it('refuses someone holding assistant but not mcp_access', () => { /* expect ok: false */ })

// Review Focus 1 — the Pride Training Club shape. An explicit studio_id must
// never fall back to another studio the person does hold the key at.
it('refuses an explicit studio_id the person lacks mcp_access at, without falling back', () => {
  // user holds mcp_access at studio A only; ask for studio B (a member studio)
  // expect { ok: false, code: … } and NOT { ok: true, studio: A }
})
```

In `src/lib/agent-tools/contact-tools.test.js` (or wherever `readableContactStudios` is covered):

```js
// Review Focus 5 — the contacts half of the fence must survive the swap.
it('returns no studios when mcp_access is held but contacts is not', () => {
  expect(readableContactStudios(user, ctx)).toEqual([])
})
```

In `src/lib/mcp/auth.test.js`, rename the two existing `assistantAnywhere` cases (`:66`, `:77`) to `mcpAccessAnywhere` and assert on `r.extra.mcpAccessAnywhere`.

In `src/lib/agent-tools/whoami.test.js`, assert the per-studio report carries `mcp_access` rather than `assistant`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- src/lib/mcp src/lib/agent-tools`
Expected: FAIL — the new decouple cases fail because every site still reads `'assistant'`; the renamed `auth.test.js` cases fail on an undefined `mcpAccessAnywhere`.

- [ ] **Step 3: Swap the three gates**

- `src/lib/mcp/context.js:23` — rename the local `holdsAssistant` to `holdsMcpAccess` and read `'mcp_access'`. Update the JSDoc at `:15` and `:19`.
- `src/lib/agent-tools/_contact-scope.js:35` — `'assistant'` → `'mcp_access'`. **Leave the adjacent `hasPermissionForLocation(user, l.id, 'contacts')` exactly as it is**; update the doc comment above `readableContactStudios`, which names `assistant`.
- `src/app/oauth/consent/page.js:65` — `'assistant'` → `'mcp_access'`, and rename the local `assistant` to `mcpAccess` (used at `:69`).

- [ ] **Step 4: Follow the two informational sites**

- `src/lib/mcp/auth.js:107` — `assistantAnywhere` → `mcpAccessAnywhere`, reading `'mcp_access'`. Update the comment at `:27` and the JSDoc return type at `:76`.
- `src/lib/agent-tools/whoami.js:42` — report `mcp_access: hasPermissionForLocation(user, l.id, 'mcp_access')`.

Update the `assistantAnywhere: true` fixture line in `registry.test.js`, `class-tools.test.js`, `roster-tools.test.js` and `contact-tools.test.js` to `mcpAccessAnywhere: true`.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm test -- src/lib/mcp src/lib/agent-tools`
Expected: PASS. `tests/agent-tools-guard.test.js` must also still pass untouched — it pins `defineTool` + `studio_id` + a `gate:`, and names no permission key.

- [ ] **Step 6: Commit**

```bash
git add src/lib/mcp src/lib/agent-tools src/app/oauth/consent/page.js
git commit -m "MCPACCESS.1 — gate the MCP surface on mcp_access

Three enforcing sites: resolveStudio (the per-studio gate every tool
passes through), the contact-set fence in _contact-scope.js (only the
assistant half — the adjacent contacts check is unchanged), and the
consent page. Two informational sites follow: the door's carried flag,
renamed mcpAccessAnywhere, and whoami's per-studio report.

No tool module names the key, so none of the 18 tools change and
tests/agent-tools-guard.test.js stays green. The refusal code and its
copy still say AI Assistant; MCPACCESS.1 part 3 fixes that."
```

---

### Task 3: Rename the refusal code and its copy, and update the docs

Found while planning, not in the spec: the refusal code `assistant_permission` carries operator-facing copy in two places. Left alone, a refused operator is told to *"switch on AI Assistant"* — pointing them at the paid feature this change exists to keep off. Nothing has ever connected (0 consents, 0 tool calls), so the code string has no client or log history and renaming it is free now and never again.

**Files:**
- Modify: `src/lib/agent-tools/registry.js:43,44,77`
- Modify: `src/components/OAuthConsentForm.jsx:15,38`
- Modify: `src/lib/mcp/context.js:15,19,30,38` (the code string in both returns and the JSDoc union)
- Modify: `src/app/oauth/consent/page.js:69`
- Modify: `CLAUDE.md` — the MCP.1 invariant bullet, which says "the `assistant` permission" twice
- Modify: `docs/architecture/INTEGRATIONS.md` — § Staff MCP server, which says connecting requires the `assistant` permission
- Test: `src/lib/mcp/context.test.js`, `src/lib/agent-tools/registry.test.js`

**Interfaces:**
- Consumes: Task 2's swapped gates.
- Produces: `resolveStudio`'s refusal code becomes `'mcp_access_permission'`; `MESSAGES` keys become `mcp_access_permission` and `mcp_access_permission_default`; the consent page's `eligibility.reason` union becomes `null | 'mcp_disabled' | 'mcp_access_permission'`.

- [ ] **Step 1: Write the failing tests**

In `src/lib/mcp/context.test.js`, update the three existing refusal assertions (`:40`, `:45`, and the new Review Focus 1 case) to expect `code: 'mcp_access_permission'`.

In `src/lib/agent-tools/registry.test.js`, assert the message text names the new permission and not the old one:

```js
it('names Connect an Agent, never AI Assistant, in a permission refusal', () => {
  // both the studio-named message and the no-studio default
  expect(studioMessage('mcp_access_permission', 'loc-1')).not.toMatch(/AI Assistant/)
  expect(studioMessage('mcp_access_permission', null)).toMatch(/Connect an Agent/)
})
```

`studioMessage(code, studioId)` is module-private in `registry.js:76`. Export it (named, no behaviour change) so the test can reach it directly rather than driving a full `runTool` for a copy assertion.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- src/lib/mcp/context.test.js src/lib/agent-tools/registry.test.js`
Expected: FAIL — the code is still `assistant_permission` and the messages still say "AI Assistant".

- [ ] **Step 3: Rename the code and rewrite the copy**

Rename `assistant_permission` → `mcp_access_permission` (and `assistant_permission_default` → `mcp_access_permission_default`) at `context.js:30,38`, `registry.js:43,44,77` and `consent/page.js:69`, with the JSDoc unions at `context.js:19` and `OAuthConsentForm.jsx:38`.

New copy, all three naming the permission as the operator sees it in `/settings/staff`:

- `registry.js` `mcp_access_permission`: `'The Connect an Agent permission is not held at that studio.'`
- `registry.js` `mcp_access_permission_default`: `'No studio where the Connect an Agent permission is held.'`
- `OAuthConsentForm.jsx` `mcp_access_permission`: `'Ask an admin to switch on Connect an Agent for you.'`

- [ ] **Step 4: Update the two docs**

In `CLAUDE.md`, the MCP.1 invariant bullet: replace both mentions of the `assistant` permission with `mcp_access`, and add that `mcp_access` is a separate key from `assistant` *because* the in-app assistant is paid (it calls Anthropic) and MCP is not, so they must be grantable apart.

In `docs/architecture/INTEGRATIONS.md` § Staff MCP server, correct the switch/permission description the same way, and add `mcp_access` to its known-limits or permissions note.

- [ ] **Step 5: Run the full CI mirror and the build**

Run the thirteen-command mirror from CLAUDE.md, then `npm run build`.
Expected: all green. `check:mobile-parity` in particular must pass on Task 1's `WEB_ONLY_OK` entry.

- [ ] **Step 6: Commit**

```bash
git add src/lib/mcp/context.js src/lib/mcp/context.test.js src/lib/agent-tools/registry.js src/lib/agent-tools/registry.test.js src/components/OAuthConsentForm.jsx src/app/oauth/consent/page.js CLAUDE.md docs/architecture/INTEGRATIONS.md
git commit -m "MCPACCESS.1 — rename the refusal to mcp_access_permission

Not in the spec; found while planning. The refusal code carried
operator-facing copy in registry.js and OAuthConsentForm.jsx telling a
refused person to switch on AI Assistant — the paid feature this change
exists to keep off. Nothing has ever connected (0 consents, 0 tool
calls), so the code string has no client or log history and the rename
is free now.

Also corrects the CLAUDE.md invariant and INTEGRATIONS.md, which both
still said connecting requires the assistant permission."
```

---

## After merge — manual, not a task

Green tests are not evidence here: `mcp_tool_calls` has never held a row, so nothing on this path has run against the real database. In order:

1. Connect `https://crm.repset.ie/api/mcp` from Claude Code and Claude Desktop. As master, Richard holds the key by default.
2. Call `whoami`. It should name the expected studios with `mcp_access` true.
3. One read at Stillorgan and one at Hatch Street.
4. Confirm `mcp_tool_calls` goes from 0 to non-zero **with the studio you expect**. If `resolveStudio` still lands on Pride Training Club (host events), the swap did not take.
5. For the week-long pilot, grant **Connect an Agent** to one manager or head coach at `/settings/staff`, per studio.
