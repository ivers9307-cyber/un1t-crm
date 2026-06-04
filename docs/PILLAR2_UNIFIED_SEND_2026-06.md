# Pillar 2 — Unified ad-hoc send + richer triggers (design)

**Date:** 2026-06-04 · **Status:** approved, Phase 0 in progress · **Owner:** Richard

Pillar 2 of the sequencing redesign (Pillars 1 + 3 — the visual flow builder and
the AI flow agent — shipped). Pillar 1 = ongoing automation. **Pillar 2 = ad-hoc
"message off the cuff" customer messaging** — the other half of the original brief.
Bundled with it: the **richer-triggers** backlog item (membership-state changes +
editable audience conditions on sequences), because both lean on the same shared
audience-condition picker.

---

## The problem

Customer messaging today is **channel-first and fragmented**. Three separate
broadcast surfaces, each a heavyweight saved object (draft → scheduled → sending):

| Surface | Route | Channel | Schedule | Send lib |
|---|---|---|---|---|
| Email campaigns | `/communications/campaigns` | email | yes | `postmark.sendCampaign` |
| WhatsApp broadcasts | `/communications/broadcasts` | WhatsApp | no | `whatsapp.sendBroadcast` |
| SMS broadcasts | `/communications/sms/broadcasts` | SMS | yes | `sms.sendBroadcast` |

Per-contact ad-hoc is already unified in `ContactComposer.jsx` (SMS + WhatsApp on a
contact's profile). What's missing is a single **audience-first** "pick who → write →
pick channel → send once" surface. You always start by choosing a channel page first.

The audience engine (`AudienceBuilder` + the `AUDIENCE_FIELDS` whitelist in
`src/lib/audience-filter.js`) is already channel-agnostic and reused by all three
broadcast paths — and it already includes `glofox_membership_state`
(active / paused / **locked** = arrears). So a unified surface is very feasible
without rebuilding the senders.

## Decisions (locked)

- **Shape: replace the three broadcast pages** with one unified surface (like the
  classic-sequence-editor retirement). Cleaner end state.
- **Channel model: channel-aware compose.** Pick ONE channel per send; the composer
  adapts (subject+body for email, plain text for SMS, template-or-text for WhatsApp)
  and shows how many of the audience are reachable + consented on that channel.
  (Best-reach multi-channel fallback is a possible later enhancement, not v1.)
- **Architecture: facade over the existing senders.** On send, the unified surface
  writes to the *existing* per-channel tables (`campaigns` / `whatsapp_broadcasts` /
  `sms_broadcasts`) and fires the *existing* send libs + cron runners. **The senders
  and their crons are never touched** — same philosophy as Pillar 1 (the graph
  compiles to `sequence_steps`; the runner is untouched). Rejected the
  new-unified-table approach (would force re-validating the proven
  chunked/resumable/rate-limited send paths for no user-visible gain).
- **Email keeps Unlayer.** When email joins the unified composer (Phase 2), the
  existing Unlayer visual builder is lifted in (full parity), and enhanced where we
  can — not swapped for a lighter editor.

## Architecture

```
Unified compose surface  (/communications/send — Phase 1/2)
  ├── Audience    : AudienceBuilder (saved segment | inline filter | explicit recipients)
  ├── Channel     : email | sms | whatsapp  (only channels the operator has perms for)
  ├── Compose     : channel-aware pane + live "reachable & consented" count
  └── Send / schedule
        └── writes the matching per-channel record  ─────►  existing send lib + cron
            (campaigns / whatsapp_broadcasts / sms_broadcasts)   (UNTOUCHED)

Unified "Sent" history : union read across the three tables.
```

Explicit-recipient mode (one or a few contacts, "off the cuff") rides the existing
senders as an `id in […]` audience filter, so the send libs stay untouched. Bulk
ad-hoc sends respect marketing consent for free (the send libs already gate on
`email_marketing` / `sms_marketing` / `whatsapp_marketing`).

## Phasing (each phase ships value; de-risks the "replace" call)

- **Phase 0 — segment / trigger items (IN PROGRESS).** Independent + small; unblocks
  win-back / dunning. Proves the `AudienceBuilder`-in-the-builder integration the
  unified surface reuses.
  - `membership_state_change` sequence trigger — fired from the Glofox member-sync
    (`applyMemberSync`) when `glofox_membership_state` transitions, mirroring
    `pipeline_stage_change` (`trigger_config: { from_state?, to_state? }` over
    active/paused/**locked**). The primitive for dunning (→ locked → dunning sequence).
  - Editable **audience condition** on a sequence — the sequence already has an
    `audience_filter` the runner enforces on every enrolment; surface it as an
    `AudienceBuilder` in `SequenceSettings` so any sequence can be gated by any
    contact attribute (the "trigger on an attribute, not just a saved segment" gap).
  - Segment-trigger discoverability — link out to create a segment when none exist.
- **Phase 1 — Pillar 2 core (SMS + WhatsApp).** The unified surface for the two
  simpler channels; retire those two editors.
- **Phase 2 — Pillar 2 email (scoped 2026-06-04; approach revised after exploring Unlayer).**
  **Finding:** the email visual builder is NOT `react-email-editor` — it's a hand-rolled
  `window.unlayer` **global** from `editor.unlayer.com/embed.js` (single shared global →
  multiple editors on one page collide; a 2.5s export-timeout band-aid; no SSR wrapper).
  Re-hosting it fresh in the unified composer is risky + unverifiable without a browser.
  **Decision (honours "maintain Unlayer & enhance"):** keep `CampaignEditor` (Unlayer's
  home) as-is; unify the **entry** + **history** around it instead of re-hosting the editor.
  - **PR 2a (additive):** Email channel in the unified composer — collect audience (+ subject),
    then "Continue in the email designer" creates a draft `campaigns` row (session-authed
    `POST /api/communications/email-draft`) and opens `/email/campaigns/[id]?edit=1` (the
    proven Unlayer editor, pre-seeded with the audience). Email joins the `/communications/sent`
    history. Enhance Unlayer: add the missing merge-tag chips (`{{pipeline_stage}}`,
    `{{last_name}}`, `{{phone}}`).
  - **PR 2b (retire):** campaign **list** → `/communications/sent`; **new** entry
    (`/email/campaigns/new`) → `/communications/send`; hub "Campaigns" card folds in. The
    campaign **editor** (`/email/campaigns/[id]`) STAYS — it hosts Unlayer.
  Email scheduling + send stay in the editor (it already does both). A future option is the
  full inline Unlayer embed (extract a `useUnlayerEditor` hook) — deferred as higher-risk;
  this ships the unification safely now.

## Non-goals (for now)

- Best-reach multi-channel fallback (one send = one channel in v1).
- A new unified `messages` table / rewritten cron runners (facade instead).
- Touching the runner / send libs / consent model.

---

*Companion to `docs/SEQUENCING_REDESIGN_2026-06.md` (Pillars 1 + 3). The
richer-triggers backlog note in CLAUDE.md is the source for the Phase 0 items.*
