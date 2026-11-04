# Customer Agent settings: one page, eight sections

Date: 4 Nov 2026. Ticket prefix: MIASETTINGS. Page: `/settings/customer-agent`.

## Why

The page that configures Mia (the WhatsApp and Instagram customer agent) has
grown one feature at a time and is now hard to find anything on or change
safely. Measured on the live page at Hatch Street, signed in as a master:

- About 23 screens of scrolling, 161 inputs and 5 Save buttons in one column.
- The organisation defaults form comes first, fully open, and repeats every
  studio section. "Proactive follow-ups" appears twice and "Hatch payments and
  booking" three times; the studio's own settings start several screens down.
- About 30 customer messages sit in one flat list under "Behaviour", mixed in
  with switches like Live and Reasoning effort. Each carries a long help
  paragraph and nothing shows which ones the studio has changed.
- Two "Save settings" buttons (under Behaviour and under the cancellation form)
  send the same request. Follow-ups, First-class check-in, Trial finisher and
  Inline suggestion have no Save of their own: an edit there is only saved by
  scrolling back up to one of those two buttons.
- Three settings are not about Mia at all: the monthly points target, member
  social, and the post-class join button wording.
- The WhatsApp booking form message (`booking_flow_text`) can be set for the
  organisation but has no field at the studio.

What success looks like: an owner can open the page, go straight to the thing
they want to change ("the no-credits message", "quiet hours", "switch Mia to
test"), change it, save it, and know it saved, without scrolling past anything
unrelated. A master or organisation admin can do the same for the organisation
defaults without that form sitting on top of every studio's page.

## Goals

1. Split the page into named sections, one showing at a time, reachable by a
   link.
2. Make the ~30 customer messages scannable: grouped, folded, searchable, and
   tagged with where each value comes from.
3. One clear way to save Mia's settings, visible wherever you are on the page.
4. Studio and organisation editing on the same layout, chosen by a switch,
   instead of two different forms stacked on one page.
5. Mia's on/off state impossible to misread.

## Non-goals

- No change to what any setting does, how it is stored, or what Mia reads.
  `locations.settings.customer_agent`, `org_settings.customer_agent`, the
  override bookkeeping (`src/lib/agent/settings-overrides.js`), the PUT
  contract (`src/lib/agent/settings-contract.js`) and both API routes stay as
  they are. No migration.
- No change to who can see or edit what (see Permissions below).
- No redesign of the Activity (`/analytics`) or Requests (`/requests`) pages,
  the knowledge editor's behaviour, the offers editor, or the voices card.
  They are moved into sections, not rebuilt.
- No mobile work: the phone has no Mia settings screen.

## Anti-goals (would make this a failure even if it works)

- A saved value lost or changed by the move. Every field that saves today must
  save to the same key with the same value after.
- A field that silently stops saving because it ended up outside the save path
  (the follow-ups problem above, recreated).
- Unsaved edits lost without warning by switching section, switching scope or
  leaving the page.
- A Glofox studio (Stillorgan) shown un1t.online-only fields, or Hatch shown
  fewer fields than today.
- Mia ending up live when the operator meant test (the
  `enabled=true` + `test_mode=true` trap in CLAUDE.md).

## The layout

```
Customer Agent · Hatch Street            [Live]  [Quiet 22:00-07:00]
Editing: This studio | All studios (organisation)      <- masters/org admins only

+---------------------------+------------------------------------------+
| Overview                  |  (the chosen section)                    |
| Personality and voice     |                                          |
| Handoffs                  |                                          |
| Bookings and sales        |                                          |
| Messages              28  |                                          |
| Follow-ups                |                                          |
| Cancellation form         |                                          |
| Knowledge             19  |                                          |
| Member app                |                                          |
| ------------------------- |                                          |
| Activity  ->              |                                          |
| Requests  ->              |                                          |
| Channel connections  ->   |  [ 2 unsaved changes   Discard   Save ]  |
+---------------------------+------------------------------------------+
```

- **Header:** page title, studio name, a status tag (Live / Test / Off) and a
  quiet-hours tag when a window applies. For masters and organisation admins
  only, the scope switch "This studio | All studios (organisation)".
- **Section menu** on the left on desktop. Below 768px it becomes a select
  (or horizontally scrolling pills) above the content. A section with unsaved
  changes shows a dot. Counts are shown only where they help (Messages,
  Knowledge).
- **Section link:** the chosen section is in the URL as `?section=<key>`
  (keys: `overview`, `personality`, `handoffs`, `bookings`, `messages`,
  `followups`, `cancellation`, `knowledge`, `member-app`), and the scope as
  `?scope=org`. Updated with `router.replace` so it does not add history
  entries. No `section` = `overview`. An unknown key = `overview`.
- **Bottom links** to Activity (`/settings/customer-agent/analytics`),
  Requests (`/settings/customer-agent/requests`) and Channel connections
  (`hubManageHref(location.id, 'instagram')`), replacing today's two link
  cards at the top.

## The sections

Every field listed here exists today; this is where each one moves. "Hatch
only" means shown only when `membership_source_key === 'un1t_online'`, exactly
as today. Each field keeps its current label, limits, placeholder, validation
and source tag. Help text is kept but shortened where it repeats itself (see
"Copy" below).

### Overview

- **Status switch:** one three-way control, Off / Test / Live, writing the two
  existing flags:
  - Off: `enabled=false`, `test_mode=false`
  - Test: `enabled=false`, `test_mode=true`; the test numbers field
    (`test_phones`) shows under it, only in Test
  - Live: `enabled=true`, `test_mode=false`

  A stored row with both flags true (today's trap) shows as Live with the
  existing amber warning, which now ends "Click Live to tidy this up".
  Only a deliberate click on a switch position changes the flags: clicking
  Live on such a row sets `test_mode=false` (an unsaved change like any
  other); saving an unrelated edit leaves both flags exactly as stored, so a
  save without edits still round-trips. Test numbers are kept in the stored
  settings when switching to Live or Off, so going back to Test restores them.
  The header status tag shows the saved state, not unsaved edits.
- **Quiet hours** (start, end, "No quiet hours (ignore the organisation's)"),
  unchanged in behaviour.
- **What this studio has changed:** for each section, how many fields this
  studio sets itself (the `overridden` paths), each a link to that section.
  Shown only when the studio inherits from an organisation.
- The read-only note for non-owners ("Only an owner can change these
  settings.") sits here and on every section.

### Personality and voice

- Agent name, Tone and voice, Extra rules, Reasoning effort.
- Mia's voices (`MiaVoicesCard`), with its own Save and its own permission
  (owners and managers), as today.

### Handoffs

- Hand back to the agent after (hours), Auto-resolve after a reply + quiet,
  Auto-resolve when fully stale, Hand off after failed ID checks.
- Hand-off message (`holding_message`).

### Bookings and sales

- Class bookings (book immediately / queue for approval).
- Membership sign-up link.
- Booking link and Booking button label (shown when `showBookingLink`, as today).
- Hatch only: "Mia can book and cancel classes, send payment links and pass
  refund requests to the team in chat" (`un1t_chat_actions_enabled`).
- Hatch only: What Mia can sell (`MiaOffersSection`, its own Save, as today).

### Messages

Every customer-facing message Mia or the system sends, in five groups:

| Group | Fields |
|---|---|
| Greeting and links | `welcome_greeting`, `link_button_text` |
| Bookings | `booking_confirmation_text`, `cancellation_confirmation_text`, `class_move_confirmation_text`, `booking_issue_handoff_text`, `no_credits_handoff_text`, `account_conflict_handoff_text`, `approval_decline_text` |
| WhatsApp booking form | `booking_flow_text` (new at studio level, Hatch only: Mia only sends the booking form where she does not book in chat; the PUT contract already accepts it and it is already inheritable), `flow_booking_ack_text`, `flow_booking_holding_text`, `flow_booking_duplicate_text`, `flow_paid_trial_text` |
| Events and credits | `event_move_confirmation_text`, `event_move_failed_text`, `comp_credits_confirmation_text` |
| Payments at Hatch (Hatch only) | the 12 `HATCH_COPY_FIELDS` |

Each message is one row:

- Folded: the label, a one-line preview of the current text (the saved value,
  or the default in muted text when blank), and the source tag (Default /
  Organisation default / Custom, or "Use organisation default" for an editor).
- Unfolded (click the row): the help text, the placeholders it understands
  (`{class}`, `{from}`, `{to}` …) and the input, exactly as today.
- Only one row open at a time is not required; several may be open.

Above the groups: a search box (matches label, help and current text, case
insensitive) and a "Changed only" toggle (rows this scope sets itself). Each
group header shows its count and folds the whole group.

### Follow-ups

Four cards, each with its on/off switch in the card header and its source tag:

- Proactive follow-ups (nudge after, outside-window template, daily cap).
- First-class check-in (delay, template, daily cap) with the live stats block
  kept as it is.
- Hatch only: Trial finisher follow-up (opener, follow-up, delay, Mia's
  instruction, test contact ids, the "Test: N contacts only" tag).
- Inline suggestion after approvals.

When a card's switch is off, its detail fields fold away (still in state, still
saved). The trial finisher's validation still holds Save, as today.

### Cancellation form

The whole of today's section in its three existing steps (The form page,
Sending the link, After you decide), with "Cancel memberships in Glofox
automatically" at the top. Its own duplicate Save button goes; the shared save
bar covers it.

### Knowledge

Today's knowledge editor, moved as it is (import from Glofox, add entry,
per-entry category / title / on / delete, saved on blur), plus:

- a search box over title and content,
- a category filter (the existing `CATEGORIES`).

It stays outside the owner-only rule, as today (any manager+ can edit it).

### Member app

`monthly_points_target`, `social_enabled`, `membership_cta_label`. They stay
stored where they are and saved by the same Save; they get their own section
so they stop sitting between Mia's settings. Moving them to another page is a
follow-up, not this work.

## Saving

- One page-level state for the studio settings (as today) and one save bar,
  sticky at the bottom of the content panel, visible in every section that
  holds studio settings. It shows the number of changed fields, Discard and
  Save. Save calls the existing `saveSettings()` (one PUT,
  `buildSavePayload(settings, overridden)`), so saving from any section saves
  edits made in every section.
- "Changed" = differs from what was last loaded or saved. Keep a snapshot of
  `settings` and `overridden` after each load/save and compare.
- Discard restores that snapshot.
- Save is held, with the reason shown in the bar, while quiet hours are
  half-set, the booking link is invalid or the trial finisher is invalid (the
  same three holds as today). The bar names the section with the problem and
  links to it.
- The menu shows a dot on each section holding unsaved studio-settings edits.
- Leaving with unsaved changes: a browser `beforeunload` prompt covers
  closing or reloading the tab, and the page's own links out (Activity,
  Requests, Channel connections, and any link inside a section) ask
  "Discard your unsaved changes?" first. The app's main sidebar is NOT
  guarded: App Router client navigation skips `beforeunload`, and a
  sidebar-wide guard is cross-cutting work outside this page. The sticky save
  bar is the mitigation. (Builder's call, recorded below.)
  Switching section: no prompt (state is kept, and sections stay mounted so
  offers, voices and knowledge drafts survive too). Switching scope: the same
  discard prompt.
- After a save, the bar shows "Saved" for a few seconds, then hides.
- The save bar is not shown on Knowledge (saves as you go), and it does not
  count offers or voices, which keep their own Save buttons inside their cards.
- Non-owners: no save bar at all, every control disabled (the existing
  `<fieldset disabled>`), as today.

## Studio and organisation scope

Shown only to users who get `orgDefaults` today (masters and organisation
admins, `resolveAdminOrgId`). Everyone else sees no switch and the page in
studio scope.

- **This studio** (default): the sections above.
- **All studios (organisation)**: the same section menu and layout, showing
  only the fields the organisation can set (today's `ORG_FIELD_GROUPS`),
  saved through `/api/settings/customer-agent/org` with its own save bar. The
  existing organisation behaviours stay: "Start from a studio's settings"
  (shown at the top of Overview in org scope), the per-field note of which
  studios use the value, and the "studios that will start using this" preview
  before saving. Sections with no org fields (Bookings and sales,
  Cancellation form, Knowledge, Member app) are hidden in org scope.
  Hatch-only conditions do not apply in org scope: every org field shows, as
  today (the Hatch payments group keeps its "(un1t.online studios)" label
  there), whichever studio the admin is working from.
- After an organisation save, the studio scope refreshes what it inherits
  (`refreshInherited`), as today.

## Permissions (unchanged)

- Page: manager+ (`MANAGER_ROLES`), else redirect to `/settings`.
- Studio settings: editable by an owner at the studio or a master
  (`canEditMiaSettings`); everyone else read-only.
- Voices: owners and managers (`canEditVoices`).
- Knowledge: any manager+.
- Organisation scope: masters and organisation admins (`resolveAdminOrgId`).

## Copy

Staff-facing, plain, no em or en dashes in new copy (the house rule in
`MiaOffersSection`). Help paragraphs that repeat "Leave blank to use the
default shown" lose that sentence; one line at the top of Messages says it
once. Section intros are one sentence each.

## How it gets built (decided)

- **One field registry for both scopes.** Today the organisation form is
  driven by `org-fields.js` and the studio form is ~900 lines of hand-written
  JSX covering the same fields, with copy that has drifted apart (labels such
  as "Tone & voice" vs "Tone and voice", the effort options, much shorter
  help at org level). One canonical copy per field: the studio's wording,
  with ampersands spelled out and dashes removed per the copy rules. A field
  may carry per-scope differences only where behaviour differs, not wording:
  the follow-up and check-in templates are a picker of the studio's approved
  templates at the studio and a free-text name at the organisation (templates
  belong to each studio's number); `holding_message` and `welcome_greeting`
  have brand-built placeholders at the studio and none at the organisation;
  the Hatch group's org label adds "(un1t.online studios)". Test assertions on
  changed labels are updated deliberately in the PR that changes them.
  Extend the registry so each field
  declares its section, group, kind, limits, label, help, placeholder, whether
  it is studio-only / org-only / both, and any show-condition (Hatch only,
  `showBookingLink`). Both scopes render from it with shared field components.
  Fields with special editors (quiet hours, the status switch, the
  cancellation form's reason list, the trial finisher block, the follow-up
  template pickers, the check-in stats) are named components the registry
  points at.
- Split `CustomerAgentClient.jsx` into one file per section plus a shell
  (header, menu, save bar, scope switch). State stays in the shell (or one
  hook) so every section edits the same `settings`/`overridden`.
- Existing pure helpers (`save-payload.js`, `settings-overrides.js`,
  `settings-org.js`) are reused unchanged.
- Use `src/components/ui` primitives and the `un1t-*` tokens; status chips use
  the `bg-<c>-500/10 text-<c>-700` recipe.

## Testing

- **Round trip, the main safety net:** for a Stillorgan-shaped and a
  Hatch-shaped settings blob, load the new page, save without edits, and
  assert the PUT body equals what `buildSavePayload` produces today for the
  same blob. Then edit one field in each section and assert only that key
  changes.
- Every field in today's studio editor appears in exactly one section
  (registry test: no field lost, none duplicated).
- Hatch-only fields hidden at a Glofox studio and present at Hatch.
- Status switch: the three states write the right flag pairs; a both-true row
  renders as Live with the warning.
- Save bar: count, Discard, the three holds, dots on the menu, scope-switch
  prompt.
- Non-owner: no save bar, controls disabled, knowledge still editable.
- Org scope: same assertions as today's `OrgDefaultsClient.test.jsx`.
- `?section=` and `?scope=` deep links, including unknown values.
- Existing `CustomerAgentClient.test.jsx`, `OrgDefaultsClient.test.jsx`,
  `MiaOffersSection.test.jsx` and `page.test.js` are ported, not deleted:
  each assertion they make still has to hold somewhere.

## Rollout

Ship in reviewable PRs, each leaving the page working:

1. Registry + shared field components, with the studio page still the old
   layout but rendered from the registry (round-trip tests prove nothing
   changed).
2. Shell: header, status switch, section menu, URL, save bar; sections as
   listed.
3. Messages grouping, search and "Changed only"; Follow-ups cards; Knowledge
   search and filter.
4. Organisation scope switch replacing the stacked organisation form.

## Calls made by the designer (not decided by Richard)

These came out of the builder check; each is a reasonable default Richard
can overturn:

1. The main app sidebar is not guarded against losing unsaved edits; only
   tab close/reload and the page's own links are.
2. One canonical wording per field (the studio's), with per-scope
   differences only where behaviour differs.
3. On a stored Live + Test row, only clicking Live clears `test_mode`; an
   unrelated save never changes it.
4. Hatch-only conditions are ignored in organisation scope;
   `booking_flow_text` at studio level is Hatch only.
5. The three member-app settings get their own section on this page rather
   than moving to another page.
6. Bookings and sales is hidden in organisation scope (it has no
   organisation fields).

## Left to the builder

- Exact visual styling of the menu, rows and save bar within the house tokens.
- The small-screen menu control (select vs pills).
- How the "changed" comparison is implemented.
- Section intro wording, within the copy rules above.
