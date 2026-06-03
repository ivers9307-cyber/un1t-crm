# UN1T CRM — Operator-Experience & Flow Audit

**Date:** 2026-06-03 · **Scope:** the web operator surface (`crm.un1tdublin.com`) · **Method:** 4 parallel read-only codebase sweeps (information architecture, cross-feature flow, correctness/half-built surfaces, UI consistency) + synthesis. No app click-testing; findings are structural. Companion to [PLATFORM_AUDIT_2026-06.md](PLATFORM_AUDIT_2026-06.md) (which covered security / Supabase / tech-debt) — this one is purely about the *experience*: does it work, and does it feel like one product.

> Prompted by operator feedback: "it feels disjointed and I think it could work/flow better between the different app features."

---

## Diagnosis (one line)

**We've built ~15 genuinely good feature islands with no connective layer between them.** Each module (Pipeline, Churn Radar, Communications, Schedule, Cars, Invoices, Bookings…) is solid in isolation, but three "glue" layers are thin or missing — and that is the disjointed feeling:

1. **No launchpad** — the dashboard *reports* numbers but doesn't *route you to the work*.
2. **The person isn't quite the centre of gravity** — the contact page is a strong hub, but a parallel "segment / communications" world runs alongside it and never meets it, and message history is fragmented.
3. **No shared design language in actual use** — the UI primitives exist but are used by ~4 of 172 components, so every island looks and behaves slightly differently.

Fix those three and the islands get bridges. None of this is breakage — it's connective tissue + polish (with exactly one real functional bug).

---

## Status — updated 2026-06-03 (post-implementation)

All five quick wins, the three structural bigger bets, **and** bet 4 (settings consolidation) shipped this session; the one real bug is fixed. **The full audit backlog is complete.**

| Item | Status | PR |
|---|---|---|
| Bug — scheduled-report email no-op | ✅ Fixed | [#321](https://github.com/ivers9307-cyber/un1t-crm/pull/321) |
| Quick win A — dashboard KPI deep-links | ✅ Done | [#318](https://github.com/ivers9307-cyber/un1t-crm/pull/318) |
| Quick win B — contact at-risk badge + active sequences | ✅ Done | [#319](https://github.com/ivers9307-cyber/un1t-crm/pull/319) |
| Quick win C — contact message-history panel | ✅ Done | [#320](https://github.com/ivers9307-cyber/un1t-crm/pull/320) |
| Quick win D — scheduled-report email delivery | ✅ Done | [#321](https://github.com/ivers9307-cyber/un1t-crm/pull/321) |
| Quick win E — consistent sidebar badges | ✅ Done | [#322](https://github.com/ivers9307-cyber/un1t-crm/pull/322) |
| Bet 1 — person action bar | ✅ Done (**rescoped** — pipeline cards only; radars already have richer actions) | [#324](https://github.com/ivers9307-cyber/un1t-crm/pull/324) |
| Bet 2 — ⌘K command palette | ✅ Done | [#325](https://github.com/ivers9307-cyber/un1t-crm/pull/325) |
| Bet 3 — shared EmptyState/Loading primitives | ✅ Done (first adoption; further migration opportunistic) | [#323](https://github.com/ivers9307-cyber/un1t-crm/pull/323) |
| Bet 4 — settings consolidation | ✅ Done (hub regroup + customer-agent surfaced; per-location page tabbed) | [#327](https://github.com/ivers9307-cyber/un1t-crm/pull/327) · [#328](https://github.com/ivers9307-cyber/un1t-crm/pull/328) |

---

## 1. Is it working correctly? — Yes, with one real bug

The app is functionally healthy (the recent mobile crash and the Glofox-invoice data issues are fixed). The sweep found **one genuinely broken operator-facing thing** (corroborated by the earlier platform audit), plus minor polish gaps:

| Severity | Issue | Detail |
|---|---|---|
| ✅ **Fixed** (REPORTS-EMAIL.1, PR #321) | ~~Scheduled-report email silently no-ops~~ | Was: the report generated, stamped `email_sent: false`, and never sent (`run-scheduled-reports/route.js` TODO stub). **Now wired** — the cron renders the report summary into a transactional email (`buildReportEmailHtml`) and sends via Postmark's outbound stream to `email_recipients`, stamping `email_sent` only on a confirmed send. |
| 🟡 Polish | BCA integration tab, non-master | Shows a bare *"view-only mode is not implemented yet"* error instead of a read-only view (`components/settings/integrations/BcaIntegrationTab.jsx`). |
| 🟡 Polish | Booking-sequence trigger | Still shows *"per-event-type filter coming soon"* (`SequenceEditor.jsx:1287`) — fires on **any** booking. |
| ✅ By design | Inbound SMS, checklist Phase 2 | Documented as phased; no false UI promises. Leave as-is. |

## 2. What's genuinely good — do not touch

- **Contact detail is a strong 360° hub** (~75–80% complete): membership/Glofox status, timeline, deals, bookings, races, WhatsApp conversations, consent history, LTV. (`app/contacts/[id]/page.js`, ~853 lines.)
- **Churn Radar is a clean closed loop** — identify at-risk → act in-context (mark-contacted / task / dunning / refresh) → stay in place. The best interaction model in the app; use it as the template.
- **SequencePicker reuse** across contact detail / deal card / bulk contacts — the right abstraction is already in place (it's just not obvious).
- **Role-based dashboard variants** (Today / Studio / Business) and the **grouped, badge-aware sidebar** are good bones.

---

## 3. The disjointed seams (worst-first)

### ① Dashboard is a snapshot, not a launchpad
It tells you "3 approvals pending, 5 WhatsApp unread, pipeline £X open" — but the numbers mostly **don't deep-link**. You read a KPI, then go hunt the sidebar for where to act. Most sidebar destinations (Invoices, Approvals, Issues…) aren't surfaced on it at all. Across all three variants there are ~3 click-through links total.

### ② Two parallel worlds that never cross
"Act on **one person**" lives on the contact page; "act on a **segment**" lives in Communications (campaigns / sequences / broadcasts). They never cross-reference:
- On a contact you **can't see which campaigns/sequences they're in**.
- After a campaign send you **can't drill into recipients**.
- Net effect: *"message this member"* has **~10 different entry points** (contact composer, sequence picker ×3 surfaces, 4 broadcast/campaign builders, radar outreach, WhatsApp inbox), and none of them shows what's already in flight.

### ③ "What have we tried with this member?" is unanswerable
WhatsApp history shows on the contact page; **SMS and email history don't appear anywhere on it**. The data exists (`email_sends`, `sms_broadcast_recipients`, sequence sends) — it's just not surfaced. No delivered / opened / bounced visibility per contact.

### ④ The contact page is great at *retrospective*, weak at *prospective*
- No **at-risk / churn badge** at the top (the radar knows; the profile doesn't).
- No **"active sequences" panel** — you can enrol someone in a 2nd sequence without seeing they're already in one (no dedup signal).
- Glofox membership status and CRM pipeline stage are two separate taxonomies shown side by side; they don't tell one story.

### ⑤ Inbox + badge fragmentation
Invoices / Approvals / Churn / Lead are sidebar-badged; **Issues, WhatsApp-unread and email are not** — so it's unclear which inboxes "ping you" vs which you must remember to open. Approvals also appear in two places (sidebar + a Schedule tab).

### ⑥ Every module looks/behaves a little differently
- **UI primitives at ~2% adoption** — `src/components/ui/` (Button/Modal/Card/Field/Table) is imported by ~4 of 172 components. ~689 hand-rolled `<button>`s, **0** uses of the Table primitive, ad-hoc cards (~123 bespoke "rounded+border" divs).
- **List/filter patterns differ per module** — Contacts (inline chips + client toggle) vs Bookings (route-ish filter tabs) vs Cars (status in the route) vs Pipeline (kanban columns) vs Invoices (embedded approval UI). Detail-entry differs too (link-to-page vs inline vs modal).
- **Loading / empty / error states are bespoke per page** — different wording ("Loading radar…" / "Loading plans…" / "Loading…"), different empty states (nothing → richly illustrated), no shared component, no error boundary.
- **Terminology drift** — the same action is "Add" / "Create" / "New" in different places; "Delete" vs "Remove".
- **Complexity hotspots** that make interactions feel fragile: `ScheduleCalendar.jsx` (~2,023 lines, 40 `useState`), `StaffForm.jsx` (~1,942), `SequenceEditor.jsx` (~1,516), `InvoicesInbox` (~1,940).
- **13+ scattered settings surfaces** — notifications alone is configured in ~6 places (`/settings/notifications`, per-location card, per-event reminders, per-campaign, per-broadcast, `/admin/matrix`).

---

## 4. Recommendations — prioritized

### Quick wins (high impact / low effort) — first sprint · ✅ all shipped
| | Fix | Why | Status |
|---|---|---|---|
| **A** | **Make dashboard KPIs deep-link** to their work (approvals# → `/approvals`, unread → `/communications`, overdue → churn, understaffed → schedule, pipeline → `/pipeline`) | Turns the snapshot into a launchpad — biggest "it flows now" payoff for least effort | ✅ #318 |
| **B** | **Churn/at-risk badge + "Active sequences" panel on the contact header** | Closes the prospective gap; the radar's signal follows the person | ✅ #319 |
| **C** | **SMS + email send history into the contact timeline** (data already exists) | Kills the "what have we tried?" friction | ✅ #320 |
| **D** | **Fix the scheduled-report email no-op** | The one real correctness bug | ✅ #321 |
| **E** | **Consistent sidebar badges** (add Issues + WhatsApp-unread) | Even, trustworthy urgency signals | ✅ #322 |

### Bigger bets (structural — the real cohesion)
1. ✅ **A reusable "person action bar"** (Message / Task / Sequence). **Rescoped on build (PR #324):** the audit assumed this belonged on the radar rows *and* pipeline cards, but the churn + lead radars already carry richer, purpose-built action clusters (Mark contacted / Assign task / Outreach / Payment reminder / Snooze) — a generic bar there would be a downgrade. The genuine gap was the sparse **pipeline cards**, where `PersonActionBar` now lives (Message deep-links to the contact composer; Task; Sequence). The radars were left alone; the contact-header swap is optional follow-up. Still the highest-leverage cohesion move *where it was missing*.
2. ✅ **Global command palette + quick-create** in the AppShell (PR #325) — ⌘K to jump to any contact, go to any destination, or quick-create a contact. (Deal/task quick-create deferred — no standalone create flow exists; they're contact-scoped.)
3. ✅ **Incremental design-system adoption** (PR #323) — shipped the shared `EmptyState` + `Loading` primitives with a first adoption; module migration continues opportunistically. Biggest driver of the *visual* disjointedness.
4. ✅ **Consolidate settings** (PRs #327 + #328) — reading the code showed it was in better shape than "13+ scattered" (integrations already tabbed in SETTINGS.1-3). The genuine gaps: the orphaned customer-agent page (now linked) + the long-scroll per-location page (now tabbed). The hub gained a Communications group.

### Suggested sequencing — ✅ executed (2026-06-03)
1. **This sprint:** A + B → C → D + E. ✅ all shipped.
2. **Next:** person action bar (bet 1) + shared EmptyState/Loading (bet 3). ✅ both shipped.
3. **Then:** command palette (bet 2). ✅ shipped.
4. **Then:** settings consolidation (bet 4). ✅ shipped.

**The full audit backlog is complete.** Next horizon: the strategic bets in `docs/PLATFORM_ROADMAP.md`.

---

## Appendix — supporting detail

**Sidebar IA:** 23 top-level items across 5 sections + a pinned Dashboard; one collapsible group (Studio Management); ~19 visible at once for a typical operator. "Operations" is an 8-item catch-all spanning scheduling / finance / issues / cars. No global search or quick-create at the shell level.

**Contact hub — present vs missing:** present = profile, Glofox membership, HR devices, marketing prefs, deals, CRM bookings, races, WhatsApp conversations, tasks, unified timeline, consent. Missing = active-sequence enrolments, SMS log, email engagement (open/click/bounce), CRM-invoice/dunning state, an at-risk badge, "who owns this contact".

**Orphaned-but-intentional pages** (no sidebar link, reachable by URL — fine): `/admin/achievements`, `/admin/bridges`, `/admin/checklists`, `/admin/policies`, `/admin/studio-devices`, plus redirect stubs `/email` `/whatsapp` `/segments` → `/communications`.

> All file:line references verified read-only as of `main` @ 152b5b9; re-confirm before editing as the tree moves.
