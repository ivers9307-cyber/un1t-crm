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

## 1. Is it working correctly? — Yes, with one real bug

The app is functionally healthy (the recent mobile crash and the Glofox-invoice data issues are fixed). The sweep found **one genuinely broken operator-facing thing** (corroborated by the earlier platform audit), plus minor polish gaps:

| Severity | Issue | Detail |
|---|---|---|
| 🔴 **Bug** | **Scheduled-report email silently no-ops** | `/schedule` → Scheduled reports has a "deliver email" toggle + recipients field. The report generates, stamps `email_sent: false`, and **never sends** — `api/cron/run-scheduled-reports/route.js:~92` is still a `// TODO: integrate Postmark` stub. No error surfaces, so it *looks* like it works. |
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

### Quick wins (high impact / low effort) — first sprint
| | Fix | Why |
|---|---|---|
| **A** | **Make dashboard KPIs deep-link** to their work (approvals# → `/approvals`, unread → `/communications`, overdue → churn, understaffed → schedule, pipeline → `/pipeline`) | Turns the snapshot into a launchpad — biggest "it flows now" payoff for least effort |
| **B** | **Churn/at-risk badge + "Active sequences" panel on the contact header** | Closes the prospective gap; the radar's signal follows the person |
| **C** | **SMS + email send history into the contact timeline** (data already exists) | Kills the "what have we tried?" friction |
| **D** | **Fix the scheduled-report email no-op** | The one real correctness bug |
| **E** | **Consistent sidebar badges** (add Issues + WhatsApp-unread) | Even, trustworthy urgency signals |

### Bigger bets (structural — the real cohesion)
1. **A reusable "person action bar"** (Message / Task / Sequence) used identically on the radar row, the pipeline card, the WhatsApp conversation, and the contact header — collapses the ~10 entry points into one consistent affordance. **Single highest-leverage cohesion move.**
2. **Global command palette + quick-create** in the AppShell (⌘K: jump to any contact, create a deal / task / campaign) — removes the "land → hunt the sidebar" loop.
3. **Incremental design-system adoption** — start with a shared `EmptyState`, `Loading`, and a standard list/detail scaffold; migrate modules opportunistically. Biggest driver of the *visual* disjointedness.
4. **Consolidate settings** (13+ surfaces) — lower priority.

### Suggested sequencing
1. **This sprint:** A + B (make dashboard → person → action feel like one product), then C, then D + E.
2. **Next:** the person action bar (bet 1) + the shared EmptyState/Loading (bet 3, opportunistically).
3. **Then:** command palette (bet 2) once the spine is connected.

---

## Appendix — supporting detail

**Sidebar IA:** 23 top-level items across 5 sections + a pinned Dashboard; one collapsible group (Studio Management); ~19 visible at once for a typical operator. "Operations" is an 8-item catch-all spanning scheduling / finance / issues / cars. No global search or quick-create at the shell level.

**Contact hub — present vs missing:** present = profile, Glofox membership, HR devices, marketing prefs, deals, CRM bookings, races, WhatsApp conversations, tasks, unified timeline, consent. Missing = active-sequence enrolments, SMS log, email engagement (open/click/bounce), CRM-invoice/dunning state, an at-risk badge, "who owns this contact".

**Orphaned-but-intentional pages** (no sidebar link, reachable by URL — fine): `/admin/achievements`, `/admin/bridges`, `/admin/checklists`, `/admin/policies`, `/admin/studio-devices`, plus redirect stubs `/email` `/whatsapp` `/segments` → `/communications`.

> All file:line references verified read-only as of `main` @ 152b5b9; re-confirm before editing as the tree moves.
