# Decouple MCP access from the in-app assistant (MCPACCESS.1) — design

Branched off `origin/main` at `1f8f78b86`. Follows
[`2026-11-01-mcp-server-design.md`](2026-11-01-mcp-server-design.md) and
reverses one of its decisions, deliberately and for a reason that was not
known on 1 Nov.

## Why

The staff MCP server (MCP.1, #2275) shipped and merged on 1 Nov, migration
801 applied, and `org_settings.mcp_enabled` is **on for UN1T Group**. The
Supabase dashboard steps are done: `/.well-known/oauth-protected-resource/api/mcp`
answers 200 and an unauthenticated `POST /api/mcp` answers 401 with a correct
RFC 9728 `WWW-Authenticate` challenge.

Nothing has ever connected. Verified live on 10 Nov: `auth.oauth_clients` 0,
`auth.oauth_authorizations` 0, `auth.oauth_consents` 0, `mcp_tool_calls` 0
rows, 0 distinct people, no first call.

**The reason it would have failed on first connect:**
`locations.features->'assistant'` is explicitly `false` at **UN1T Stillorgan**,
**UN1T Hatch Street** and **Test Studio**. MCP.1 gates connecting and acting on
the existing `assistant` web permission, and tier 1 of `resolvePermission`
([`shared/permissions.js`](../../../shared/permissions.js)) is a hard veto that
runs *before* the master bypass:

```js
// Tier 1: location gate. Applies to all roles including master.
if (!isFeatureEnabledAtLocation(location, key)) return false
if (role === 'master') return true
```

`isFeatureGatedByLocation('assistant')` is true (it is neither a `notify_*` key
nor an approvals sub-permission), so the explicit `false` denies — master
included. The behaviour is already pinned by
[`shared/permissions.test.js:33`](../../../shared/permissions.test.js) ("returns
false when the location explicitly disables the feature, even for master").

The failure would not have read as a permission problem. `resolveStudio`
([`src/lib/mcp/context.js:37`](../../../src/lib/mcp/context.js)) falls back to
the first location the person holds `assistant` at, and the only UN1T Group
location without the deny is **Pride Training Club (host events)** — so a
question asked without an explicit `studio_id` would have been answered,
confidently, about an empty host-events location. Only an explicit
`studio_id` for Stillorgan returns a clean `assistant_permission` refusal.

**Why the flag is false — and why that is not going to change.** Richard
switched the in-app assistant off to stop Anthropic token spend. That was the
only lever available: `/api/assistant/chat` burns `ANTHROPIC_API_KEY` on
`claude-sonnet-4-20250514`, is gated on `hasPermission(user, 'assistant')`, and
**enforces no spend ceiling at all** — `getAiCapStatus`
([`src/lib/usage-caps.js`](../../../src/lib/usage-caps.js)) exists and works but
is wired only into Mia's paths
([`src/lib/agent/auto-reply.js:642`](../../../src/lib/agent/auto-reply.js),
[`src/lib/wa-studio-pick/classify.js:32`](../../../src/lib/wa-studio-pick/classify.js)).
The assistant route records usage and nothing stops it.

**The MCP server, by contrast, spends nothing on AI.** No file under
`src/lib/mcp/`, `src/app/api/mcp/` or `src/lib/agent-tools/` references
Anthropic or a model call. Inference happens in the operator's own Claude
client, billed to their Claude subscription; the server-side cost of a tool
call is a Postgres query.

So the two capabilities share one permission key and have opposite cost
profiles. Flipping `features.assistant` back on would re-open the exact spend
that was killed, in order to enable something that costs nothing. **That is the
bug this change fixes, and sharing the key will keep producing it.**

## Decisions (Richard, 10 Nov 2026)

| Question | Answer |
|---|---|
| Scope | A new permission key only. The in-app assistant's missing spend ceiling is written up as a follow-up and **not built here** — it must not block connecting. |
| Who holds it by default | **Master and owner.** Off for manager, head coach, staff and reception, granted per person by an admin. Matches the one-person-for-a-week rollout, and is the cautious default given the token's reach outside this app (MCP.1 § Token reach). |
| Reverses | MCP.1's "No new permission key" and its "Connecting requires the existing `assistant` web permission". |

## Goals

- MCP works at Stillorgan and Hatch Street with `features.assistant` still
  `false` everywhere, and the in-app assistant still dead.
- A person's right to connect an agent is grantable without granting them a
  paid in-app chat.
- No change to the in-app assistant: not re-enabled, not capped, not migrated.

## Non-goals

- Wiring `getAiCapStatus` into `/api/assistant/chat` (see Follow-up).
- Re-enabling the in-app assistant, or changing the `assistant` key's own
  defaults or bundle.
- The org-level `mcp_enabled` switch, the consent flow, the call log, the 18
  tools, service profiles, the REST API / `unitk_` keys.
- Migrating the in-app assistant onto `src/lib/agent-tools/` (still a MCP.1
  non-goal).

## Anti-goals

- A key that is exempt from the tier-1 location gate. A brand-new key has no
  value in any `locations.features`, so the gate is **default-allow** and costs
  nothing today, while preserving an org's ability to switch MCP off at one
  studio. Special-casing it out of tier 1 would be a quiet exception to a rule
  the whole permission model rests on.
- Special-casing `master` inside the MCP door to dodge the veto. It would
  unblock one person, contradict the deliberate "applies to all roles including
  master" rule, and do nothing for the pilot manager.
- An unbundled key (see Bundle, below).

## How it works

### 1. The permission

In `WEB_PERMISSIONS`, beside `assistant`
([`shared/permissions.js:100`](../../../shared/permissions.js)):

```js
{ key: 'mcp_access', label: 'Connect an Agent',
  hint: 'Connect Claude or another MCP client to the CRM as yourself. Not the in-app chat.' },
```

**Named "Connect an Agent", not "Agent access"** — the Integrations hub already
has an **Agent access** card for the org-level `mcp_enabled` switch
(`AgentAccessCard.jsx`), and two controls with one name is how this gets
misread. The org card is the door; this permission says who may walk through it.

### 2. Role defaults

In `DEFAULT_WEB_PERMISSIONS_BY_ROLE`, one entry per role, written explicitly
for all six so the map reads as a decision rather than an oversight. Current
`assistant` values are shown for contrast:

| Role | `assistant` (line) | new `mcp_access` |
|---|---|---|
| master | `true` (350) | `true` |
| owner | `true` (534) | `true` |
| manager | `true` (497) | **`false`** |
| head_coach | `true` (460) | **`false`** |
| staff | `false` (385) | `false` |
| reception | `false` (425) | `false` |

### 3. Bundle

`KEY_BUNDLES` gets `mcp_access: ['bundle_sales']`, matching
`assistant: ['bundle_sales']`
([`shared/permission-bundles.js:122`](../../../shared/permission-bundles.js)).

**Builder's call.** An unbundled key is never denied by a bundle —
`deniedByEveryBundle(features, undefined)` returns `false` on the missing
entry — which would let a tenant on a tier without `bundle_sales` read contacts
and pipeline through MCP while the tier gate blocks them in the app. It changes
nothing today (UN1T Group is the only org with the switch on) and closes the
hole before it is one. Change it if the tier mapping should differ.

### 4. The gate swap

Three sites gate; two are informational. No tool module *enforces* the key —
tools reach enforcement through `context.js` and `_contact-scope.js`, so none
of the 18 tools changes behaviour.

**Corrected 10 Nov after review:** several tool modules nonetheless *name* the
permission in prose that does change — `whoami`'s shipped `description`
string (the text the MCP client shows Claude), plus header comments in
`whoami`, `get-contact`, `get-classes`, `get-class-roster`, `registry.js`,
`_contact-scope.js` and `mcp/auth.js`. The original wording here read as "no
tool file is touched", which is how the first pass shipped a tool
description still telling the agent the gate is AI Assistant.
`tests/agent-tools-guard.test.js` now fails any tool whose `title` or
`description` names the AI Assistant permission.

**Gates:**

| Site | Change |
|---|---|
| [`src/lib/mcp/context.js:23`](../../../src/lib/mcp/context.js) | `holdsAssistant` → `holdsMcpAccess`, key `mcp_access`. This is `resolveStudio`'s per-studio gate, which every tool passes through, and the site currently blocking every call. |
| [`src/lib/agent-tools/_contact-scope.js:35`](../../../src/lib/agent-tools/_contact-scope.js) | `'assistant'` → `'mcp_access'`. **Only this half changes**: the adjacent `hasPermissionForLocation(user, l.id, 'contacts')` is the data permission and stays exactly as it is. |
| [`src/app/oauth/consent/page.js:65`](../../../src/app/oauth/consent/page.js) | `'assistant'` → `'mcp_access'`, local `assistant` → `mcpAccess`. Governs whether a client can be approved at all. |

**Informational, not enforcement:**

| Site | Change |
|---|---|
| [`src/lib/mcp/auth.js:107`](../../../src/lib/mcp/auth.js) | `assistantAnywhere` → `mcpAccessAnywhere`, on `mcp_access`. **Nothing in `src/` reads this field** — only tests do; it is carried in `extra` for a future door-level refusal (see the comment at `auth.js:27`). Renamed rather than dropped, to keep that door open. Update the JSDoc at `auth.js:76` too. |
| [`src/lib/agent-tools/whoami.js:42`](../../../src/lib/agent-tools/whoami.js) | Report `mcp_access` per studio instead of `assistant`, so `whoami` names what actually gated the call. |

### 5. What this does not need

**No migration.** The key lives in code; per-person grants already go in
`profile_locations.permissions` (mig 058); `resolvePermission` tier 2.5 falls
through on a role-template key that is absent, so no template reseed is needed.
CLAUDE.md's mobile-defaults reseed rule applies only to keys an RLS policy asks
about — no policy asks about this one, and it is web-only.

**No dashboard step, no org-switch change, no `features.assistant` change.**

## Guards and gates

- `check:mobile-parity` **fails** without a `WEB_ONLY_OK` entry in
  [`scripts/check-mobile-parity.mjs:76`](../../../scripts/check-mobile-parity.mjs),
  reason: *MCP is a desktop/CLI connector; no phone counterpart.* The mobile
  `assistant` key (`shared/permissions.js:593`, `webEquivalent: 'assistant'`)
  stays mapped to web `assistant` and is untouched. The linter forces this
  decision rather than letting it be assumed.
- [`tests/agent-tools-guard.test.js:169`](../../../tests/agent-tools-guard.test.js)
  pins `defineTool` + `studio_id` + a `gate:` and does **not** name the
  permission key, so it stays green unchanged.
- [`shared/permissions.test.js:33`](../../../shared/permissions.test.js) and
  `:81` pin the tier-1 veto behaviour in both its key and bundle forms. Unchanged.
- Tests to update, all for the renamed field or key: `src/lib/mcp/context.test.js`,
  `src/lib/mcp/auth.test.js`, `src/lib/agent-tools/whoami.test.js`, and the
  fixture context in `src/lib/agent-tools/{contact,class,roster}-tools.test.js`
  and `registry.test.js`.
- Full CI mirror (all thirteen) before pushing; `npm run build` because the
  change adds no imports but touches a page.

## Rollout

1. PR: the key, six role defaults, the bundle entry, three gate swaps, two
   informational renames, the `WEB_ONLY_OK` entry, the CLAUDE.md invariant line
   (which currently names "the `assistant` permission"), and the corresponding
   correction in `docs/architecture/INTEGRATIONS.md` § Staff MCP server.
2. Merge. Nothing else changes.
3. Richard connects `https://crm.repset.ie/api/mcp` from Claude Code and Claude
   Desktop. As master he holds the key by default.
4. For the week-long pilot, grant **Connect an Agent** to the one manager or
   head coach at `/settings/staff`, per studio.

## Verification

Green tests are not evidence here: `mcp_tool_calls` has never held a row, so
nothing on this path has ever run against the real database.

After merge, in order:

1. Call `whoami`. It should name the expected studios with `mcp_access` true.
2. One read at Stillorgan and one at Hatch Street.
3. Confirm `mcp_tool_calls` goes from 0 to non-zero **with the studio you
   expect**. If `resolveStudio` still lands on Pride Training Club (host
   events), the swap did not take.

## Follow-up, not built here

**The staff assistant has no spend ceiling.** Before `/api/assistant/chat`
could safely come back it needs the `getAiCapStatus` check that Mia's paths
already have. That surfaces a decision this spec does not make:
`org_settings.ai_hard_cap_cents` is **one org-wide monthly budget that Mia
spends against too**, so capping staff chat on the same number lets staff usage
starve customer messaging — worse than the feature being off. Options: a
per-feature budget split, a separate staff-assistant cap, or accepting the
shared pool. Worth its own spec when the feature is wanted back.

Two smaller notes:

- `/api/assistant/chat` is pinned to `claude-sonnet-4-20250514`. Mia moved to
  Sonnet 5 in August; that route did not.
- `docs/domain-migration-stage3.md:37` still shows runbook item 8 as `[ ]`
  though the Supabase Site URL and OAuth Server steps are done. Stale, and it
  misled this investigation.
