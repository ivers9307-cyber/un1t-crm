# Customer Agent settings redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn `/settings/customer-agent` from one 23-screen form into a section menu with one save bar, grouped and searchable messages, an Off/Test/Live switch and a studio/organisation scope switch, without changing any stored value, route or permission.

**Architecture:** One field registry (`fields.js`) describes every Mia setting once, for both scopes; shared components render it. The studio editor's state and save logic move into one hook (`useAgentSettings`), and a shell (`CustomerAgentClient.jsx`) renders the header, the menu, one section at a time (all mounted, inactive ones `hidden`) and the save bar. The existing pure helpers (`save-payload.js`, `src/lib/agent/settings-overrides.js`, `src/lib/agent/settings-org.js`) and both API routes are reused unchanged. A golden round-trip test, written first against today's page, proves every PR saves exactly what today's page saves.

**Tech Stack:** Next.js 16 App Router (client components), React 19, Vitest 5 + Testing Library (jsdom), Tailwind with `un1t-*` tokens, `@/components/ui` primitives.

**Spec:** `docs/superpowers/specs/2026-11-04-customer-agent-settings-redesign-design.md` (read it first; this plan argues from it).

## Global Constraints

- No change to `locations.settings.customer_agent`, `org_settings.customer_agent`, `/api/settings/customer-agent`, `/api/settings/customer-agent/org`, `settings-contract.js`, `settings-overrides.js`, `settings-org.js`, `save-payload.js` behaviour. No migration.
- Permissions unchanged: page manager+; studio settings `canEditMiaSettings` (owner at studio or master); voices `canEditVoices`; knowledge any manager+; org scope only when the server passes `orgDefaults`.
- Hatch only = `membership_source_key === 'un1t_online'`. Booking link fields show when `bookings !== true || membership_source_key === 'un1t_online'` (today's `showBookingLink`). Hatch-only conditions are ignored in org scope.
- Staff copy: sentence case, no em or en dashes in any new or moved label, help or placeholder, "and" not "&".
- Every `<button>` gets `type="button"` unless it submits (`check:guardrails` `no-untyped-button-in-form`).
- Colours: `un1t-*` tokens only; chips `bg-<c>-500/10 text-<c>-700`.
- Section keys, exactly: `overview`, `personality`, `handoffs`, `bookings`, `messages`, `followups`, `cancellation`, `knowledge`, `member-app`. URL params: `?section=<key>`, `?scope=org`.
- Worktree: `/Users/richardivers/code/un1t-crm-mia-settings`, branch per PR off `origin/main` (see Rollout). Run `npm ci` once in a fresh worktree before tests or build.
- Before each push run the CI mirror from `CLAUDE.md` once (`npm test && npm run lint && … && npm run check:ota-paths`) and `npm run build`; never run the full suite beside the build on this 8 GB Mac. Each PR adds `docs/changelog/entries/<PR>.md` after `gh pr create`.

## Review Focus

1. **A non-owner (read-only) must still be able to move around.** The disabled `<fieldset>` would also disable the section menu, the messages search and the knowledge search if they sit inside it. Expected: the controls that only change what you see stay usable, and the setting inputs are disabled. Test lives in Task 6 (menu) and Task 9 (search).
2. **A stored row with Live and Test both on, then an unrelated edit and Save.** Expected: both flags are saved exactly as stored. Only clicking Live clears `test_mode`. Test lives in Task 5.
3. **A legacy full blob (T3-D) or a Hatch studio with no blob, saved with no edits.** Expected: the PUT body is identical to today's. Test lives in Task 1 and runs again in every later task.
4. **Save is held by a field you can't see.** An invalid trial finisher or booking link sits in another section while you're on Messages. Expected: the save bar says why, names the section and links to it. Test lives in Task 7.
5. **A deep link to a section or scope you can't have.** For example `?scope=org` without org rights, `?section=cancellation&scope=org`, or `?section=nonsense`. Expected: it falls back to the studio scope and to Overview, never shows a blank panel. Tests live in Task 6 and Task 12.

---

## File structure

All under `src/app/settings/customer-agent/` unless a path says otherwise.

| File | Responsibility |
|---|---|
| `fields.js` (new) | `AGENT_FIELDS` registry + `fieldsFor(scope, section, ctx)` + `MESSAGE_GROUPS` |
| `fields.test.js` (new) | registry completeness, no dashes, org view equals today's |
| `org-fields.js` (modify) | becomes a thin view: `ORG_FIELD_GROUPS`/`ORG_FIELDS` derived from `fields.js`, same export names |
| `components/AgentField.jsx` (new) | renders one registry field (text, textarea, number, select, checkbox) with label, help, tag |
| `components/SourceTag.jsx` (new) | the Default / Organisation default / "Use … default" tag (moved out of the client) |
| `components/StatusSwitch.jsx` + `status.js` (new) | Off/Test/Live control and its pure state mapping |
| `components/SaveBar.jsx` (new) | sticky bar: count, holds, Discard, Save, Saved |
| `components/GuardedLink.jsx` (new) | a `next/link` that asks before leaving with unsaved changes |
| `components/SectionMenu.jsx` (new) | left menu (desktop) / select (mobile), dirty dots, counts |
| `sections.js` (new) | `SECTIONS`, `parseLocation(search, { canOrg })`, `sectionForPath(path)` |
| `dirty.js` (new) | `changedPaths(before, after)`, `dirtySections(paths)` |
| `useAgentSettings.js` (new) | all studio state, load, save, discard, overrides, holds (moved from the client) |
| `sections/*.jsx` (new, 9 files) | one per section key, each a pure render of hook state |
| `sections/CancellationFormFields.jsx` (new) | today's cancellation-form JSX, moved verbatim |
| `messages-filter.js` (new) | `filterMessages(...)` |
| `knowledge-filter.js` (new) | `filterKnowledge(...)` |
| `CustomerAgentClient.jsx` (rewrite) | the shell: header, scope switch, menu, sections, save bar |
| `OrgDefaultsClient.jsx` (modify) | renders by section from the registry in org scope; save bar |
| `page.js` (modify) | passes `canEditVoices` into the client; stops rendering `MiaVoicesCard` itself |
| `round-trip.test.jsx` + `__fixtures__/agent-settings.js` (new) | the golden PUT-body safety net |

---

## PR 1: registry and shared field components (no visible change)

Branch `customer-agent-settings-redesign` (already holds the spec and this plan; rebase on `origin/main` first).

### Task 1: Golden round-trip test against today's page

**Files:**
- Create: `src/app/settings/customer-agent/__fixtures__/agent-settings.js`
- Create: `src/app/settings/customer-agent/round-trip.test.jsx`

**Interfaces:**
- Produces: fixtures `STILLORGAN_GET`, `HATCH_GET`, `LEGACY_FULL_BLOB_GET`, `HATCH_NO_BLOB_GET` (GET bodies shaped like `/api/settings/customer-agent`'s: `{ success, settings, studio, org, inherited, location, brand, bookings, membership_source_key, checkin_stats }`); helpers `renderEditor(getBody, props?)`, `lastPutBody()`, `saveNow()` (clicks the save control by role name `/^Save( settings)?$/`), and `EDIT_ONE_PER_SECTION`: an array of `{ section, label, value, expectKey }` used by later tasks.
- Build the fixture `settings` through `buildCustomerAgentSettings`/`mergeAgentSettings` from `@/lib/agent/settings-contract` and `settings-resolve` (as `CustomerAgentClient.test.jsx` does), so they are valid by construction. `HATCH_GET` carries `membership_source_key: 'un1t_online'`, `bookings: false`, a stored `trial_done` block and two Hatch copy fields; `STILLORGAN_GET` carries `bookings: true`, a stored org layer setting `tone` and `followups.daily_cap`, and a studio override of `holding_message`. `LEGACY_FULL_BLOB_GET` has `enabled: true, test_mode: true` too (Review Focus 2 and 3).

- [ ] **Step 1: Write the tests**

```js
describe('round trip: saving with no edits', () => {
  for (const [name, get] of [['Stillorgan', STILLORGAN_GET], ['Hatch', HATCH_GET], ['legacy full blob', LEGACY_FULL_BLOB_GET], ['Hatch with no blob', HATCH_NO_BLOB_GET]]) {
    it(`${name}: the PUT body equals buildSavePayload of what was loaded`, async () => {
      await renderEditor(get)
      await saveNow()
      expect(lastPutBody()).toEqual(buildSavePayload(get.settings, initialOverridden(get.studio)))
    })
  }
})
describe('round trip: one edit changes one key', () => {
  for (const e of EDIT_ONE_PER_SECTION) {
    it(`${e.section}: editing "${e.label}" changes only ${e.expectKey}`, async () => { /* edit by label, save, diff against the no-edit body: exactly [e.expectKey] differs */ })
  }
})
```

`EDIT_ONE_PER_SECTION` covers one field per future section: `agent_name` (personality), `handoff_cooldown_hours` (handoffs), `membership_signup_url` (bookings), `no_credits_handoff_text` (messages), `followups.daily_cap` (followups), `cancellation_form.intro` (cancellation), `monthly_points_target` (member-app), `test_phones` (overview). Use Hatch for all except where the field is Glofox-only.

- [ ] **Step 2: Run against today's page; it must PASS** (it pins current behaviour)

Run: `npx vitest run src/app/settings/customer-agent/round-trip.test.jsx`
Expected: all pass. A failure here means the fixture or helper is wrong, not the page. Fix the test.

- [ ] **Step 3: Commit** `MIASETTINGS.1a — golden round-trip test for the Mia settings save`

### Task 2: The field registry

**Files:**
- Create: `fields.js`, `fields.test.js`
- Modify: `org-fields.js` (derive from `fields.js`; keep `ORG_FIELD_GROUPS`, `ORG_FIELDS`, `ORG_FIELDS_NOT_EDITED` exports and shapes)
- Test: `org-fields.test.js` must pass unchanged

**Interfaces:**
- Produces:
  ```js
  // one entry per setting
  { id, paths: string[], kind: 'text'|'textarea'|'number'|'select'|'checkbox'|'custom',
    section: SectionKey, group?: MessageGroupKey, scope: 'studio'|'org'|'both',
    label, help?, placeholder?: string | ((ctx) => string), maxLength?, min?, max?, step?, options?,
    when?: (ctx) => boolean,                 // studio scope only; ignored in org scope
    org?: { label?, help?, kind?, placeholder? }, // per-scope differences (behaviour only, plus the Hatch "(un1t.online studios)" suffix)
    component?: string }                     // for kind 'custom': 'QuietHours'|'TemplatePicker'|'StatusSwitch'|'TrialDone'|'CancellationForm'|'Offers'|'Voices'|'Knowledge'
  export const AGENT_FIELDS
  export const MESSAGE_GROUPS // [{ key: 'greeting', title: 'Greeting and links' }, { key: 'bookings', title: 'Bookings' }, { key: 'booking-form', title: 'WhatsApp booking form' }, { key: 'events-credits', title: 'Events and credits' }, { key: 'hatch-payments', title: 'Payments at Hatch' }]
  export function fieldsFor(scope, section, ctx) // registry order; applies scope, `when` (studio only), `org` overrides; section null = every section
  // ctx = { membershipSourceKey, bookings, brand, agentName }
  ```
- Section and group per field: exactly the spec's "The sections" and Messages table. `booking_flow_text` gets `scope: 'both'`, `when: hatch`. `chat_booking_unavailable_text` goes in group `hatch-payments` with the other Hatch copy fields. In org scope it keeps its current place under Messages; `org-fields.js` keeps it there so its test holds.
- Labels and help: the studio's wording (from today's `CustomerAgentClient.jsx` and `hatch-copy-fields.js`), with `&` spelled out and dashes removed. Drop the trailing "Leave blank to use the default shown." from every message's help; Task 9 says it once at the top of Messages. The effort options become the org's dash-free wording (`'Low: fastest and cheapest, for simple chat'`, and so on).

- [ ] **Step 1: Write `fields.test.js`**
  - `every field today's studio editor shows is in the registry exactly once`: a hard-coded list of the studio paths (every `setField`/`setFollowup`/`setCheckin`/`setTrialDone`/`setInlineSuggestion`/`setCancelForm`/quiet-hours path in today's client, plus `un1t_chat_actions_enabled` and `booking_flow_text`) compared with `AGENT_FIELDS.filter(f => f.scope !== 'org').flatMap(f => f.paths)`. The cancellation form counts as one `custom` entry with path `cancellation_form` plus `glofox_auto_cancel`; the trial finisher counts as one with path `trial_done`.
  - `org view equals today's org editor`: `ORG_FIELDS.map(f => f.id)` equals the id list currently in `org-fields.js` (copy it into the test before changing that file).
  - `no em or en dash and no ampersand in any label, help, placeholder or option`, for both scopes and both ctx variants (Hatch and Glofox).
  - `every field has a known section; every messages field has a known group`.
  - `Hatch-only fields are absent for a Glofox ctx in studio scope and present in org scope`.
- [ ] **Step 2: Run, expect FAIL** (`fields.js` missing). `npx vitest run src/app/settings/customer-agent/fields.test.js`
- [ ] **Step 3: Implement `fields.js`, then rewrite `org-fields.js` to build `ORG_FIELD_GROUPS` from `fieldsFor('org', …)`.** Keep group ids `behaviour`, `messages`, `hatch`, `followups`, `checkin`, `inline` and titles as today.
- [ ] **Step 4: Run** `npx vitest run src/app/settings/customer-agent/` and confirm `fields.test.js`, `org-fields.test.js` and `OrgDefaultsClient.test.jsx` pass. A label assertion that fails only because of the canonical wording is updated in the same commit, and the commit body names each one.
- [ ] **Step 5: Commit** `MIASETTINGS.1b — one field registry for Mia's settings`

### Task 3: Shared field components, studio editor rendered from the registry

**Files:**
- Create: `components/AgentField.jsx`, `components/SourceTag.jsx`, `components/AgentField.test.jsx`
- Modify: `CustomerAgentClient.jsx`: replace each hand-written plain input with `<AgentField>`, keeping today's order and sections. Custom editors (quiet hours, template pickers, trial finisher, cancellation form, offers, knowledge, check-in stats) stay as they are for now.

**Interfaces:**
- Produces:
  ```jsx
  <AgentField field ctx value onChange(path, value) tag disabled? error? />
  // label text = field.label (or field.org.label in org scope, decided by the caller passing the resolved field from fieldsFor)
  // number: '' -> null; select: '' -> null; text/textarea: raw string; checkbox: boolean
  // inline_suggestion.enabled checkbox: checked = value !== false (as today)
  <SourceTag source canEdit orgHas onRevert />   // same output as today's sourceTag()
  ```
- Consumes: `fieldsFor` (Task 2).

- [ ] **Step 1: Write `AgentField.test.jsx`**: one test per kind for the value mapping; the label is tied to the input (`getByLabelText(field.label)`); a placeholder function receives `ctx`; `error` renders `role="alert"`.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement both components; swap them into `CustomerAgentClient.jsx`.**
- [ ] **Step 4: Run** `npx vitest run src/app/settings/customer-agent/` and confirm the round-trip test and every existing test pass, with label assertions updated as in Task 2.
- [ ] **Step 5: CI mirror + `npm run build`, push, `gh pr create`, changelog entry.** Commit `MIASETTINGS.1c — render the Mia settings from the registry`

---

## PR 2: the shell, sections, status switch and save bar

Branch `mia-settings-2-shell` off `origin/main` after PR 1 merges.

### Task 4: `useAgentSettings` hook and dirty tracking

**Files:**
- Create: `useAgentSettings.js`, `dirty.js`, `dirty.test.js`, `useAgentSettings.test.jsx`
- Modify: `CustomerAgentClient.jsx`: use the hook (layout unchanged in this task)

**Interfaces:**
- Produces:
  ```js
  changedPaths(before: { settings, overridden }, after: { settings, overridden }) => string[]
  // dotted paths whose value differs ('tone', 'followups.daily_cap', 'cancellation_form', 'trial_done'),
  // plus 'overridden:<path>' when only the override set changed (a "Use default" click)
  dirtySections(paths: string[]) => Set<SectionKey>   // via sectionForPath (Task 6 owns sections.js; add sectionForPath there now)

  useAgentSettings({ canEdit }) => {
    loading, loadFailed, reload, settings, overridden, org, inherited, location, brand, bookings,
    membershipSourceKey, checkinStats, templates, ctx,
    setField(path, value), setQuietHours(end, value), setNoQuietHours(on), revertToInherited(paths),
    sourceTag(paths) /* returns <SourceTag/> */, inheritedNumber(path, fallback),
    dirtyPaths, dirtySections, holds /* [{ section, message }] */,
    saving, savedAt, error, serverFieldErrors, save(), discard(), refreshInherited(),
  }
  ```
  `setField` handles dotted paths, with the same override bookkeeping as today's `setFollowup`/`setCheckin`/`setInlineSuggestion`. For `trial_done.*` and `cancellation_form.*` it does no override bookkeeping, matching today. The snapshot is taken after every successful load, save and `refreshInherited`. `holds` is built from today's three checks: `isHalfQuietWindow` → overview, `bookingLinkErrors` → bookings, `trialDoneErrors` → followups.
- [ ] **Step 1: `dirty.test.js`**: no change gives `[]`; a scalar, a nested field, a cancellation reason label and an override-only change each produce the expected path; the result is order independent.
- [ ] **Step 2: `useAgentSettings.test.jsx`** (render the hook with a tiny harness component):
  - `discard restores the loaded settings and overrides`
  - `save PUTs buildSavePayload and resets dirtyPaths to []`
  - `holds name the section`
  - `a failed read leaves loadFailed true and save unavailable`
- [ ] **Step 3: Run both, expect FAIL; implement by moving code out of the client; run until PASS, round-trip included.**
- [ ] **Step 4: Commit** `MIASETTINGS.2a — Mia settings state in one hook, with unsaved-change tracking`

### Task 5: Off / Test / Live switch

**Files:** Create `status.js`, `status.test.js`, `components/StatusSwitch.jsx`, `components/StatusSwitch.test.jsx`

**Interfaces:**
- Produces:
  ```js
  statusOf({ enabled, test_mode }) => 'off' | 'test' | 'live' | 'live_and_test'
  flagsFor(choice: 'off'|'test'|'live') => { enabled, test_mode }  // off: F,F  test: F,T  live: T,F
  <StatusSwitch settings onChoose(choice) disabled />  // radiogroup "Mia is", options Off / Test / Live; 'live_and_test' renders Live selected + the amber warning ending "Click Live to tidy this up."; test numbers input shows only for 'test'
  ```
  `onChoose` calls `setField('enabled', …)` and `setField('test_mode', …)` from `flagsFor`, and never touches `test_phones`.
- [ ] **Step 1: Tests**
  - `statusOf` covers all four flag pairs.
  - `flagsFor` covers each choice.
  - Clicking Live on a `live_and_test` row produces `{ enabled: true, test_mode: false }`.
  - **Review Focus 2:** load `LEGACY_FULL_BLOB_GET`, edit `agent_name`, save; the PUT body has `enabled: true, test_mode: true`.
  - Switching to Live then back to Test keeps `test_phones`.
- [ ] **Step 2: FAIL → implement → PASS → commit** `MIASETTINGS.2b — one Off/Test/Live switch for Mia`

### Task 6: Sections, menu and shell

**Files:**
- Create: `sections.js`, `sections.test.js`, `components/SectionMenu.jsx`, `sections/OverviewSection.jsx`, `PersonalitySection.jsx`, `HandoffsSection.jsx`, `BookingsSection.jsx`, `MessagesSection.jsx` (a plain list per group in this PR), `FollowupsSection.jsx`, `CancellationSection.jsx` + `CancellationFormFields.jsx` (today's JSX moved verbatim, minus its Save button), `KnowledgeSection.jsx` (today's editor moved), `MemberAppSection.jsx`
- Rewrite: `CustomerAgentClient.jsx` as the shell
- Modify: `page.js` (pass `canEditVoices={canEditVoices(user, user.activeLocation?.id)}` to the client; remove its own `MiaVoicesCard`), `page.test.js` (assert `can-edit-voices=`)
- Modify: `CustomerAgentClient.test.jsx`: add `openSection(name)` helper (clicks the menu item); prefix each existing test with the section its field now lives in. No assertion is deleted.

**Interfaces:**
- Produces:
  ```js
  SECTIONS = [{ key, label, scopes: ('studio'|'org')[] }]  // labels: Overview, Personality and voice, Handoffs, Bookings and sales, Messages, Follow-ups, Cancellation form, Knowledge, Member app; org scopes: overview, personality, handoffs, messages, followups
  parseLocation(search: string, { canOrg: boolean }) => { section: SectionKey, scope: 'studio'|'org' }
  // unknown/missing section -> 'overview'; scope 'org' without canOrg -> 'studio'; a section not in that scope -> 'overview'
  sectionForPath(path) => SectionKey   // from AGENT_FIELDS; already added in Task 4
  writeLocation({ section, scope })    // window.history.replaceState; omits defaults
  ```
- Shell layout as in the spec. The header shows the studio name, a status tag from `statusOf` of the SAVED settings (the snapshot, not unsaved edits), and a quiet-hours tag when a window applies. "Only an owner can change these settings." shows at the top of every section when `canEdit` is false. Below 768px `SectionMenu` renders a `<select>` instead of the list. Every section is mounted and inactive ones get the `hidden` attribute, so drafts survive a switch. The header, menu and links sit **outside** the disabled `<fieldset>`; each section's settings sit inside it. Voices, offers and knowledge stay outside the fieldset, as today, each with its own permission. The two old link cards go. The menu foot has Activity, Requests and Channel connections (`hubManageHref(location.id, 'instagram')`). The load-failure state is unchanged: `ReadFailedNote`, no menu, no save.
- [ ] **Step 1: `sections.test.js`** covers `parseLocation` (Review Focus 5) for: none, a valid section, nonsense, `scope=org` with and without `canOrg`, and `section=cancellation&scope=org`; and `sectionForPath` for one field per section.
- [ ] **Step 2: Shell tests in `CustomerAgentClient.test.jsx`:**
  - opens on Overview
  - `?section=messages` opens Messages
  - clicking a menu item updates `location.search`
  - an edit in Personality, a switch to Messages and back keeps the edit
  - **Review Focus 1:** with `canEdit` false the menu items are enabled and the setting inputs disabled
  - the load-failure test is unchanged
- [ ] **Step 3: FAIL → implement → PASS** (the whole folder, round-trip included).
- [ ] **Step 4: Commit** `MIASETTINGS.2c — Mia settings in nine sections`

### Task 7: Save bar, unsaved-change guards and menu dots

**Files:** Create `components/SaveBar.jsx`, `components/GuardedLink.jsx`, tests beside them; modify the shell and `SectionMenu.jsx`.

**Interfaces:**
- `<SaveBar count holds saving savedAt error onSave onDiscard onGoTo(section) />`. Hidden when `count === 0` and no `savedAt` in the last 4 s. With holds, Save is disabled and each hold renders "<message> in <Section label>" as a button calling `onGoTo`. The bar is not rendered on Knowledge, or at all without `canEdit`.
- `<GuardedLink href dirty>` uses `window.confirm('Discard your unsaved changes?')` when `dirty`.
- The shell adds a `beforeunload` listener only while `dirtyPaths.length > 0`.
- `SectionMenu` shows a dot for each key in `dirtySections`.
- [ ] **Step 1: Tests**
  - The count matches the number of edits.
  - Discard empties it and restores values.
  - **Review Focus 4:** an invalid trial finisher shows a hold naming "Follow-ups"; clicking it opens Follow-ups.
  - Saving from Messages saves an edit made in Personality (the round-trip body contains both).
  - No bar for a non-owner.
  - `GuardedLink` confirms only when dirty.
  - `beforeunload` is registered only while dirty.
- [ ] **Step 2: FAIL → implement → PASS → commit** `MIASETTINGS.2d — one save bar for Mia's settings`

### Task 8: Overview summary

**Files:** Modify `sections/OverviewSection.jsx`; create `overview-counts.js` + test.

**Interfaces:** `overrideCountsBySection(overridden: string[]) => Partial<Record<SectionKey, number>>`. It uses `sectionForPath`, and `quiet_hours.*` counts once. The Overview lists the non-zero sections as `<button type="button">` links that open the section. Shown only when `org` is not null.
- [ ] **Step 1: Tests**: counts for a mixed list, quiet-hours pair counted once, hidden when `org` is null.
- [ ] **Step 2: FAIL → implement → PASS.** CI mirror, build, push, PR, changelog. Commit `MIASETTINGS.2e — what this studio has changed, on the Overview`

---

## PR 3: messages, follow-ups and knowledge

Branch `mia-settings-3-messages` off `origin/main` after PR 2 merges.

### Task 9: Folded, searchable messages

**Files:** Create `messages-filter.js` + test, `components/MessageRow.jsx` + test; modify `sections/MessagesSection.jsx`.

**Interfaces:**
- `filterMessages(fields, { query, changedOnly, settings, overridden }) => fields`. The query matches label, help and current value, case-insensitive and trimmed; an empty query matches all. `changedOnly` keeps fields whose paths are overridden.
- `<MessageRow field ctx value tag open onToggle onChange disabled />`. When folded it shows the label, the one-line preview (the value, or the placeholder in muted text when blank) and the tag. When open it shows the `AgentField`.
- The section has one line at the top: "Leave a message blank to use the default shown." Then the search input, the "Changed only" toggle, and the groups from `MESSAGE_GROUPS`, each with its count and a fold button. A group with no matches is hidden; no matches at all shows "No messages match."
- [ ] **Step 1: Tests**
  - filter: query, changed-only, both, empty
  - row: folded preview of value vs default; click opens; editing marks the studio's own; Hatch group absent at a Glofox studio
  - **Review Focus 1:** search and fold work when `canEdit` is false
- [ ] **Step 2: FAIL → implement → PASS → commit** `MIASETTINGS.3a — Mia's messages grouped, folded and searchable`

### Task 10: Follow-up cards

**Files:** Modify `sections/FollowupsSection.jsx`; tests in `CustomerAgentClient.test.jsx`.

**Interfaces:** Each of the four cards has its switch and `SourceTag` in the header. When the switch is off, the detail fields are not rendered: they stay in state and still save (the round-trip proves it). The check-in stats block and the trial finisher's test tag stay as they are.
- [ ] **Step 1: Tests**: switching off hides the details; a stored value in a hidden detail is still in the PUT body; the trial finisher card shows only at Hatch.
- [ ] **Step 2: FAIL → implement → PASS → commit** `MIASETTINGS.3b — follow-up cards fold when off`

### Task 11: Knowledge search and filter

**Files:** Create `knowledge-filter.js` + test; modify `sections/KnowledgeSection.jsx`.

**Interfaces:** `filterKnowledge(entries, { query, category }) => entries`. The query matches title and content, case-insensitive. `category` is one of `CATEGORIES` or `''` for all. Entries keep their saved-on-blur behaviour.
- [ ] **Step 1: Tests**: query, category, both; an entry edited while filtered out still persists; the menu count shows the total.
- [ ] **Step 2: FAIL → implement → PASS.** CI mirror, build, push, PR, changelog. Commit `MIASETTINGS.3c — search and filter Mia's knowledge`

---

## PR 4: organisation scope

Branch `mia-settings-4-org-scope` off `origin/main` after PR 3 merges.

### Task 12: Scope switch and org sections

**Files:** Modify `OrgDefaultsClient.jsx`, `OrgDefaultsClient.test.jsx`, the shell, `sections.js`; test in `CustomerAgentClient.test.jsx`.

**Interfaces:**
- `OrgDefaultsClient` gets new props: `{ organizationId, organizationName, section, onSaved, onDirtyChange(count) }`. It renders only `fieldsFor('org', section)`, using `AgentField` and its own `SaveBar` labelled "Save organisation defaults". On Overview it shows "Start from a studio's settings" and the copy preview, unchanged. The per-field studio line and the "Saving starts these for…" preview stay.
- Shell: the header switch "This studio | All studios (organisation)" is rendered only when `orgDefaults` is set. Switching while either scope is dirty asks `Discard your unsaved changes?`. A no means no switch. A yes discards and then switches. In org scope the menu lists only the org sections. `writeLocation` writes `scope=org`.
- [ ] **Step 1: Tests**
  - No switch without `orgDefaults`.
  - Switching shows org fields and hides Cancellation form, Knowledge, Member app and Bookings and sales.
  - **Review Focus 5:** `?scope=org&section=cancellation` lands on the org Overview, and `?scope=org` without rights lands on studio.
  - A dirty studio edit asks before switching.
  - The org save re-reads what the studio inherits (port today's test).
  - Hatch copy fields show in org scope while working from Stillorgan.
  - Every `OrgDefaultsClient.test.jsx` assertion still holds, run with the `section` prop set to the field's section.
- [ ] **Step 2: FAIL → implement → PASS.**
- [ ] **Step 3: Live check.** Use the preview deploy via `web_fetch_vercel_url`, or production after merge, at Hatch and Stillorgan, as a master:
  - Open each section.
  - Save once with no edits. The network panel shows a PUT body equal to before.
  - Switch scope.
- [ ] **Step 4: CI mirror, build, push, PR, changelog.** Commit `MIASETTINGS.4 — organisation defaults behind a scope switch`

---

## Rollout

Four PRs in order. Each one leaves the page working and is merged before the next branch is cut from fresh `origin/main`. No migration and no deploy ordering. After PR 4 merges, delete `CustomerAgentClient`'s leftover link-card code and any dead imports in the same PR, never later.
