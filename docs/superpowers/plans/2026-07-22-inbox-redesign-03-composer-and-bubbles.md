# Inbox Redesign — Plan 3: Composer + Bubbles — Implementation Plan

**Goal:** Retire the hard-coded WhatsApp dark bubble palette for design tokens (so the WA thread is light-theme-consistent), distinguish Mia-vs-staff outbound messages, calm the message meta row (hover-reveal), and unify the accreting composer actions behind one `＋` menu. **Frontend-only — no backend, no migration.**

**Spec:** §4.5 (composer unification) + §4.6 (bubble theming / Mia author / hover meta).

**Grounding (current `src/components/WAInbox.jsx`, post-Plan-2):**
- Thread background hard-codes `bg-[#0b141a]` (~L880); timeline = `mergeTimeline(messages, approvals).map(...)` (~L881).
- Outbound bubble hard-codes `bg-[#005c4b] text-un1t-text` (~L904).
- Composer actions: template picker (window-closed path; `templates` state, `selectTemplate`), card sets (`send-carousel`, ~L514), booking Flow (`send-flow`, ~L541).
- `mia` token exists (`tailwind.config.js`); `bg-mia/10 text-mia` is guardrail-safe (verified in Plan 2).

**Invariants:** Tailwind classes literal (no template interpolation); `<button>` in a composer needs `type="button"`; `next build` is the real gate; chip recipe unchanged. Line numbers approximate — read the current file.

---

### Task 1 — Bubble/timeline theming + Mia-vs-staff + hover meta (`WAInbox.jsx`)
- [ ] **Thread background:** replace `bg-[#0b141a]` (~L880) with a token surface — use `bg-un1t-bg` (page) with the messages area distinguished by spacing, or a very subtle `bg-un1t-surface`. Pick whichever reads cleanest against the composer; the point is it must be **light-theme-consistent**, not the WhatsApp dark green.
- [ ] **Outbound bubble:** replace `bg-[#005c4b] text-un1t-text` (~L904) with a neutral token fill: inbound bubbles `bg-un1t-surface text-un1t-text border border-un1t-border`; outbound (staff/Mia) a distinct neutral, e.g. `bg-un1t-text/[0.06]` or a dedicated light fill — must have readable contrast (`text-un1t-text`). No hard-coded hex.
- [ ] **Mia vs staff:** determine sender identity — an outbound message from Mia has `source === 'agent'` (confirm the real field in the message object). Render a small author tag above/below the bubble: `MIA` in `text-mia` (with a Sparkles icon) for agent messages, the staff name (or "You") in `text-un1t-subtle` otherwise. Give Mia bubbles a subtle `bg-mia/10 border border-mia/40` tint so they're visually distinct from staff.
- [ ] **Hover-reveal meta:** the reactions (inbound 👍❤️🔥) and agent thumbs (👍/👎 on `source==='agent'`) + ticks + timestamp currently share the meta row. Move the reaction/thumbs controls into a row that is `opacity-0` by default and `group-hover:opacity-100` (make the message container `group`), so the timeline reads calmly and the controls appear on hover. Keep them keyboard-focusable (`focus-within:opacity-100`). Preserve every existing handler (react, feedback).
- [ ] Verify `npm run build && npm run lint && npm run check:guardrails`. Commit `INBOX-REDESIGN.3.1 — token-based WA bubbles + Mia author tag + hover meta`.

### Task 2 — Unified `＋` composer menu (`WAInbox.jsx`)
- [ ] When the 24h window is OPEN: render one `＋` button (lucide `Plus`) at the start of the composer bar that opens a small popover menu (reuse the kebab-menu idiom from Plan 2's WA header / `PersonActionBar`) with: **Template**, **Card set**, **Booking Flow**, **Media** (if a media action exists; else omit), **Consultation** (if present). Each item triggers the **existing** handler (`selectTemplate` flow / `send-carousel` / `send-flow` / …) — no new behaviour. Remove the separate always-visible card-set/flow rows; they live in the menu now.
- [ ] When the window is CLOSED: keep the existing template-picker path (it's the only way to send), presented in the same composer frame; the `＋` menu can be collapsed to just Template in that state.
- [ ] All menu buttons `type="button"`. Verify `npm run build && npm run lint && npm run check:guardrails`. Commit `INBOX-REDESIGN.3.2 — unified ＋ composer menu`.

---

## Deploy
Full CI mirror → PR → merge on green (no migration, no checkpoint). Post-merge: Vercel visual pass (WA thread now light; Mia bubbles tinted; composer `＋` menu).

## Self-review vs spec §4.5/§4.6
- §4.6 retire hard-coded palette + Mia-vs-staff + hover meta → Task 1. ✓
- §4.5 unified `＋` composer → Task 2. ✓
