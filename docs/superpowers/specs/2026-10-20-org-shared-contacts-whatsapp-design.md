# One organisation, many studios: contacts and WhatsApp as shared assets

**Date:** 2026-10-20 · **Status:** design settled with Richard in chat (§5 decisions, 20 Oct); not built, no implementation plan yet. Reviewed against `origin/main` 394822a2 (migrations to 761).
**Scope:** the two assets Richard named first, Contacts and WhatsApp (with Mia). Nothing here touches Glofox or un1t.online sync mechanics, events, or billing.
**Live numbers:** production reads were refused in this session, so every count below is from the 17-19 Oct specs and migration self-checks, not from today's database.

---

## 1. What is there today, in one paragraph each

### Contacts
A person is one `contacts` row per organisation (mig 712: email unique per org) with ONE home studio, `contacts.location_id`. Everything that says "this person is also at the other studio" is a side channel added one at a time as Hatch came online:

| Side channel | Added by | Says |
|---|---|---|
| `deals` at the other studio's board | mig 251 (June) | a lead there |
| `contact_memberships` (active) | migs 722, 731 | a paying member there (un1t.online) |
| `un1t_clients.contact_id` | migs 726, 732 | a un1t.online client there, any status |
| `glofox_crossover_members` | mig 758 (19 Oct) | a Glofox member there whose contact lives elsewhere |
| `contact_location_preferences` | mig 487 | on that studio's marketing list |

Every consumer re-derives "is this person at studio X" from its own subset of those five, and the subsets disagree:

- **RLS** (`contacts_select`, helper body in mig 758): home studio, or memberships + un1t clients + Glofox crossovers. **Not deals.**
- **Web list and search** (`crossover_contact_ids` RPC): deals + memberships + un1t clients + Glofox crossovers, truncated at 100 ids because they travel as an `id.in()` URL.
- **Contact page** (`canViewContact`): home, memberships, un1t clients, deals. **Not Glofox crossovers**, so a Stillorgan-only staff member can see one of the 13 linked Hatch-homed Glofox members in the list and get a 404 opening them.
- **Phone directory**: the RPC's ids, re-read through RLS, so deal-only crossovers vanish on the phone.
- **Mia** (`member-studios.js`): the person group + Glofox columns + `glofox_crossover_members` + the un1t mirror, a fourth definition.
- **Pipeline exclusion** (`glofox-active-members.js`): `location_id = Stillorgan` + memberships, ignores Glofox crossovers.
- **Glofox readers** (attendance refresh, detail backfill, invoice import, reconcile): each patched individually in GLOFOXREADERS.1 to add the crossover rows.

Single-value columns on `contacts` (`pipeline_stage_slug`, `lead_source`, `last_lead_source`, the `glofox_*` block) hold the home studio's answer even when the person's relationship with the other studio is the live one. The audience view copies `contacts.*`, so a Hatch segment filtering on stage or lead source filters on Stillorgan's values. Edit and delete are home-studio only. Person groups cannot span studios. Two contradictory models are written in the source: "one contact per org" (`contact-studio-link.js`) and "contacts are per studio, linked by a person group" (`pipeline-other-studio-members.js`).

### WhatsApp and Mia
This half is in better shape than it looks. WAORGNUMBER (migs 743-748, PRs #2104-#2115) is fully shipped and WAORGNUMBER.6 already deleted the number-less-sibling workarounds. The model is deliberate and sound:

- numbers belong to the organisation and are switched on per studio (`location_whatsapp_numbers`);
- a send for studio S goes from a number switched on at S and files a thread at S; a member of both studios has one chat on their phone and up to two threads in the CRM;
- a reply lands with the studio that spoke last (`routeInboundThread`: quoted message, ad, latest outbound in 7 days, the contact's home studio, the number's home);
- templates, consent (STOP/START), blast sign-off and the daily limit are per studio or per number as the spec says;
- Mia's settings are org defaults with studio overrides (mig 729), and she answers from the studio where the person actually holds a membership (MIAHATCH, `member-studios.js`).

What is left is (a) leftovers the plan itself scheduled for removal and (b) the same disease as Contacts: WhatsApp and Mia carry their own answers to "which studio is this person at".

- `whatsapp_numbers.is_default` is deprecated but still written and still read by the org numbers route; mig 743's compatibility triggers and the old `UNIQUE(location_id, label)` and per-location default index are still there.
- `whatsapp_numbers.location_id` now means "home studio" by comment only; it decides where unknown senders and coexistence history land, where templates made in Meta's UI appear, and who may edit chat openers.
- Mig 746 (move the three `hatch_*` templates to Hatch) is marked "apply at go-live" and is not confirmable as applied. Hatch's switch-on and `whatsapp_blast_signoff_until` are hand steps with no UI.
- `templateLocationIdFor` is an identity function kept only so a test can count calls.
- Routing step 4 uses `contacts.location_id` (home); Mia uses the person-group scan; the studio picker uses the link table. Three sources for one question.

---

## 2. The one change that removes most of it

**Principle: people belong to the organisation; studios hold relationships with them. One table answers "which studios is this person at", and everything reads it.**

### 2.1 `contact_studios`
One row per (contact, studio) that has ever had a relationship. Replaces the five side channels as the *authority* for presence; the source tables stay as data.

```
contact_studios
  contact_id        uuid  FK contacts (cascade)
  location_id       uuid  FK locations (cascade)
  organization_id   uuid  trigger-maintained from the location (never crosses org: trigger raises)
  kind              text  'member' | 'client' | 'lead'          -- strongest live relationship
  status            text  'active' | 'ended'
  source            text  'glofox' | 'un1t_online' | 'lead_form' | 'deal' | 'manual' | 'import'
  stage_slug        text  the pipeline stage at THIS studio (see 2.4)
  first_seen_at, last_seen_at, ended_at, created_at, updated_at
  PRIMARY KEY (contact_id, location_id)
  service_role only (RLS on, no policy, mig 677 ACL stated)
```

**Lifecycle rules (my call, derivable from the source rows, so a nightly reconcile can re-derive every row):**
- `status = 'active'` while ANY of these holds at that studio: a live membership (Glofox `member`/`credit_member` not ended, or a un1t subscription in `MEMBERSHIP_ACTIVE_STATUSES`, or credits), a provider account (`un1t_clients` row, Glofox link), an open deal, or a marketing-preferences row. Otherwise `'ended'` with `ended_at`. Rows are never deleted.
- `kind` is the strongest current relationship: `member` (live membership) > `client` (provider account, lapsed or not) > `lead` (deal or preferences only). It moves down when a membership ends and up when one starts.
- `last_seen_at` is **last activity**, never a sync tick: attendance, a booking, a deal touch, a message in that studio's thread. Syncs stamp `first_seen_at` and `status` only, so a studio that syncs every few minutes cannot win a tie over one that syncs nightly.
- A marketing-preferences row (`contact_location_preferences`) counts as a relationship (the lead-form writer and the backfill create a `lead` row for it), so "joined this studio" for sequence enrolment and the audience view's reach never shrink from this change.

`contacts.location_id` stays and is renamed in meaning only: the **primary studio**. It decides who may delete the record, which studio's values fill the single-value columns, and the fallback when a rule needs exactly one studio. It is never again a visibility or scoping test on its own: every contact has a `contact_studios` row at its primary studio, so "at studio X" is always a join on this table.

**Writers** (every one already exists; each gains one upsert):

| Writer | Row it maintains |
|---|---|
| contact insert (trigger) | `(contact, primary studio, kind per lead_source, source 'manual'/'lead_form'/'import')` |
| deal insert/move (trigger on `deals`, like mig 736's) | `(contact, board's studio, 'lead', 'deal')`, and `stage_slug` |
| un1t.online sync (`un1t-online-sync.js` step 7) | `'client'` for every `un1t_clients` row, `'member'` while a subscription is live (what `contact_memberships` does now) |
| Glofox sync + webhook (`glofox-sync.js`, `recordGlofoxCrossover`) | `'member'`/`'client'` at the Glofox studio, home-studio or crossover alike |
| lead forms, race registration, `findOrCreateContact` paths | `'lead'` at the form's studio |
| backfill migration | one pass over `contacts.location_id`, `deals`, `contact_memberships`, `un1t_clients`, `glofox_crossover_members` |

### 2.2 Readers collapse to one join
- **RLS**: `contacts_select` keeps its shape but the helper becomes one branch: `id = ANY ((SELECT private.auth_contact_studio_contact_ids())::uuid[])`, where the helper is `SELECT contact_id FROM contact_studios WHERE location_id = ANY (auth_contact_read_location_ids())`. Deals are now covered (fixes the phone), Glofox crossovers are covered everywhere (fixes the 404).
- **Lists and search**: a `security_invoker` view `studio_contacts` (= `contacts` ⋈ `contact_studios`) replaces the `or(location_id.eq.L, id.in.(ids))` filter and the RPC. The 100-id cap and the 414 risk go away because nothing travels as a URL. The "crossover" pill becomes "primary studio ≠ this studio", a display fact, not an access path. **The view is read by service-role pages and routes only.** `contact_studios` itself stays closed to client sessions: the phone keeps reading `contacts` directly, and the widened RLS already answers "at this studio" for it, so the mobile crossover-ids route is simply deleted and the phone's pill comes from `contacts.location_id`. No new client-readable table, no new grant.
- **`canViewContact`**, `isCrossoverAt`, `crossoverIdsAt`, the mobile `crossover-ids` route, PIPEEXCL's active-member read, member pricing, "joined this studio" for sequences, every Glofox reader patched in GLOFOXREADERS.1: all read `contact_studios` through one helper, `contactsAtStudio(db, locationId, { kinds, status })`.
- **Mia's `resolveMemberStudios`**: candidate studios come from `contact_studios` rows of the person group (status active, kind member/client), then the existing live checks (Glofox bookable membership or trial credits; un1t subscription or credits) decide `active`. The person-group plus crossover scan goes.
- **WhatsApp routing step 4**: "the contact's home studio, if a candidate" becomes "the candidate studio where the person has an active `contact_studios` row; two → the one with the later `last_seen_at`; none → primary studio". The 7-day outbound rule, quoted message and ad rules stay above it.
- **Studio picker** candidate list is unchanged (studios with the number switched on and `listed`).

### 2.3 What is deleted at the end
`glofox_crossover_members` (table and `glofox-crossover.js`), `contact_memberships` (folded into `contact_studios`; `member-validation.js` and `contact-memberships.js` read the new table), `crossover_contact_ids` RPC, `private.auth_contact_membership_contact_ids`, the `include_crossovers` flag, `CROSSOVER_ID_CAP`, the `contactAtGlofoxStudio` / `glofoxLinkLocationsByContact` seams, PIPEEXCL's own membership read, the mobile crossover-ids route (the phone's directory query reads the view). Guard tests `contacts-read-scope-migration-guard`, `migration-731/732/758` are rewritten once against the single helper instead of accepting three pinned bodies.

### 2.4 Per-studio values that are single-valued today
- **Pipeline stage**: `contact_studios.stage_slug` is maintained per studio by the deal trigger (the rule in mig 736, applied per row instead of to the primary studio only). `contacts.pipeline_stage_slug` keeps the primary studio's value for one release, then its readers move to the studio row. The audience view LEFT JOINs `contact_studios` on `audience_location_id` so a Hatch segment filters on the Hatch stage, and a person with a preferences row but no stage there keeps their reach with a NULL stage. The two direct writers of the column (`lead-radar/cleanup` and `churn-radar/quarantine` set `'dormant'`) write the radar's own studio row: dormancy is per studio. **This is the one part that changes customer-facing behaviour (who an audience includes); it is decision 3 below.**
- **`lead_source` / `last_lead_source`**: `contact_studios.source` plus `first_seen_at` per studio give the per-studio answer; the contact-wide columns stop being overwritten by the other studio's form.
- **Glofox columns** stay on `contacts` as today (one Glofox account per contact row, person groups for more). Not in scope.

### 2.5 Person groups follow the organisation
`person_groups.location_id` becomes `organization_id` and the link route's same-studio refusal is lifted to same-organisation. A dual-studio person with a ClassPass placeholder at one studio and a un1t account at the other is then one group, which is what Mia and the duplicates queue already assume.

### 2.6 Who may edit
Today only the primary studio may PATCH or DELETE. Proposed: PATCH by anyone holding Contacts at a studio with an active `contact_studios` row (they already see everything); DELETE and "change primary studio" by the primary studio's admins or an org admin. Decision 4.

---

## 3. WhatsApp: finish the model, then point it at `contact_studios`

Keep: org-owned numbers, per-studio switch-on, threads per studio, per-studio templates and consent, per-number limit and sign-off. These were decided with Richard on 17 Oct and the reasoning holds. In particular **threads stay per studio**: a single org-level thread with a "serving studio" pointer was considered and rejected here, because a Stillorgan broadcast to a member mid-conversation with Hatch would move the thread out of Hatch's inbox. Two threads is the honest shape of two inboxes.

Finish:
1. **Drop the leftovers** (one migration + one PR): `whatsapp_numbers.is_default` and its partial index, mig 743's compatibility triggers, `UNIQUE(location_id, label)` → `UNIQUE(organization_id, label)`, `templateLocationIdFor`. The org numbers route stops selecting `is_default`.
2. **Name the home studio for what it does.** `whatsapp_numbers.location_id` becomes `home_location_id` in meaning and UI copy: "Unknown senders, Meta-made templates and chat-opener edits belong to this studio." Shown as a picker on the org numbers page (R8 already allows org admins to change it).
3. **The sign-off date gets a UI**: a "Sign-off until" date on the studio WhatsApp tab (today a hand-set setting). Hatch is already switched on and mig 746 is applied (decision 6), so there is no go-live checklist left.
4. **Routing step 4 and Mia read `contact_studios`** (2.2). Delete `pickInboundContact`'s "prefer a contact at the receiving home studio, else the oldest in the org" in favour of "the contact with an active row at a candidate studio, else primary".
5. **Status webhooks** (delivery, read) route by the message's stored `location_id` (mig 723's trigger already stamps it), not by the number's home.

Mia keeps her settings layering and the per-turn member-studios resolver; only the resolver's first read changes. `answerable` (that studio's Mia gate passes for this sender) is untouched.

---

## 4. Rollout (each PR behaviour-neutral until the flip)

| Phase | What | Risk |
|---|---|---|
| 0 | Quick fixes that need no model change: `canViewContact` admits Glofox crossovers; deals added to the RLS helper (or removed from the RPC, pick one); stale pill tooltip; guard-test title; sign-off UI; WhatsApp leftovers (§3.1-3.3) | low |
| 1 | Mig: `contact_studios` + backfill + triggers; writers dual-write. Nothing reads it yet. Migration self-checks the backfill against the five sources (counts must match). A contact with a NULL `location_id` (the column is nullable since mig 004) gets no primary row and is reported, not fatal; a deal or link that would cross organisations aborts the file, because W0 scoping says none should exist | low |
| 2 | Readers: RLS helper, `studio_contacts` view, lists, search, contact page, phone directory, PIPEEXCL, pricing, Glofox readers. Old paths deleted in the same PRs, one area at a time | medium (visibility) |
| 3 | Mia `resolveMemberStudios` and WhatsApp routing step 4 read the table; `pickInboundContact` simplified | medium (routing) |
| 4 | Per-studio stage and lead source; audience view join; person groups per org; edit rights | decision-gated |
| 5 | Drop `glofox_crossover_members`, `contact_memberships`, the RPC, the old helper; rewrite the CLAUDE.md invariants (contacts read scope, WAORGNUMBER R4) | low |

Every migration forward-only, applied before its code, `get_advisors` after; PGlite tests in the mig 731/758 style with fictional ids.

---

## 5. Decisions (Richard, 2026-10-20, in chat)

1. **Standing rule:** people belong to the organisation, studios hold relationships. Every future source (a third studio, a new booking platform, ClassPass at Hatch) writes a `contact_studios` row and nothing else.
2. **Visibility is any relationship, lapsed too.** Any `contact_studios` row, active or ended, makes the person visible to staff holding Contacts at that studio. `kind`/`status` matter only to Mia, routing and pricing.
3. **Pipeline stage becomes per studio**, audiences and list filters read it per studio, **with a change report first**: before the flip, a one-off report of every existing segment whose membership changes.
4. **Edit anywhere, delete by primary or org admin.** Staff holding Contacts at any studio with a relationship may edit the record; DELETE and "change primary studio" only by the primary studio's admins or an org admin.
5. **Threads stay per studio.** One chat on the phone, up to two threads in the CRM; routing by "who spoke last" and Move stay.
6. **Go-live is done:** the number is switched on at Hatch Street and mig 746 was applied. §3.3 shrinks to the sign-off date UI.

## 6. Non-goals
- Merging Glofox and un1t.online data shapes; the provider seam stays.
- Changing consent semantics (per-studio marketing, contact-wide administrative).
- Instagram, email inboxes, host events.
- A new UI beyond the three small surfaces named (home-studio picker, sign-off date, primary-studio change).
