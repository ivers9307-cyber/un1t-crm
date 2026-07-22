# Unified Inbox — Visual Redesign ("Refined") — Design Spec

- **Date:** 2026-07-22
- **Status:** Draft for review (visual direction approved from interactive mockup)
- **Surface:** `/communications/inbox` (staff)
- **Supersedes visually:** `docs/UNIFIED_INBOX_2026-06.md` (the shipped 3‑panel command‑centre — this is a re‑skin, not an IA rebuild)
- **Visual reference:** interactive mockup — https://claude.ai/code/artifact/1453e2c4-3bfd-4c13-bb71-f369f31d3aa3 (Refined direction, light theme)

> Line numbers below come from the 2026‑07 current‑state map and may drift — treat them as "find near here", verify before editing.

---

## 1. Goal & scope

Give the inbox a **fresh, distinctive visual identity** on the **light theme** without changing its information architecture. The 3‑panel layout (queue · thread · command centre) stays. What changes is the look and a small set of decluttering fixes that the re‑skin naturally enables.

**Primary driver (from review):** the inbox has accreted features (WA + IG + Email, inline Mia approvals, templates, card sets, booking Flow, 24h window, Command Centre) and the chrome is straining — an overloaded WA header, an accreting composer, a 3‑row filter stack, and channel identity that's too weak to scan.

### In scope (v1)
1. **Channel identity system** — WhatsApp / Instagram / Email each get a brand logo + a colour ring + a spelled‑out label. This is the one sanctioned use of colour beyond semantics. (Directly addresses the "tell IG and WA apart" ask.)
2. **Queue row re‑anatomy** — logo → ringed avatar → name → preview → state badges.
3. **Single‑row filter + search** — collapse the 3‑row filter stack; add a search field (client‑side filter over loaded conversations for v1).
4. **Decluttered thread header** — one primary action (Resolve), a unified *Handled by* control, everything else into a `⋯` overflow.
5. **Unified composer `＋` menu** — re‑parent the existing actions (Template / Card set / Booking Flow / Media / Consultation) behind one affordance instead of stacked conditional rows.
6. **Token‑based message theming** — replace the hard‑coded WhatsApp bubble palette with design tokens; distinguish **Mia vs staff** outbound by an author tag + subtle violet tint; move reactions/thumbs to hover.
7. **Command Centre signals strip** — a compact Churn / Arrears / Visits‑30d / last‑seen band + surfaced latest note, using data already on the payload where available (rest flagged as dependency, see §7).
8. **Design tokens** — add a `channel` colour group and a `mia` accent; otherwise reuse existing `un1t.*` tokens.
9. **WA agent pause/resume** *(chosen 2026‑07‑22)* — a WhatsApp equivalent of the IG agent toggle: `PATCH /api/whatsapp/conversations/[id]/agent` + a persisted flag (migration) that the Mia WA send path checks before auto‑replying. Makes *Handled by* live on WhatsApp. See §4.3.
10. **Full signals wiring** *(chosen 2026‑07‑22)* — Churn + Arrears + Visits‑30d fed into the Command Centre payload. Arrears reads the **reconcile output** (never computed raw); visits from a Glofox attendance read. See §4.7.

### Explicitly out of scope (YAGNI / follow‑ups)
- **Dark theme** — the mockup proves it works, but v1 ships light‑only (Richard's call 2026‑07‑22). Keep tokens theme‑ready but don't build the dark switch.
- **"Console" direction** — parked as a possible future power‑user mode; not this spec.
- **Mobile parity** — the CRM mobile app consumes these surfaces separately (`mobile-parity-program`); a follow‑up, not v1.
- **New booking/approval logic** — no changes to what approvals do or how bookings work; only their presentation.
- **Search backend** (v1 filters client‑side) and a **display/NEXA web font** — deferred (see §7 Decisions). *(The WA agent‑pause endpoint and full signals wiring were open decisions — now pulled INTO v1 per §7.)*

---

## 2. Visual system

**Aesthetic:** calm cool‑monochrome canvas, one violet accent reserved for Mia/AI, channel identity as the only other colour. Semantic colours (good/attention/critical) are separate from the accent and used only for state.

**Neutrals & primary** — reuse existing intent tokens in `tailwind.config.js` (unchanged):
`un1t.bg #FFFFFF` · `un1t.surface #F7F8FA` · `un1t.border #E2E5E9` · `un1t.subtle #64748B` · `un1t.muted #94A3B8` · `un1t.text #111827` · `un1t.accent #1E293B`.
Primary/active affordance stays the existing **inverted monochrome** (`bg-un1t-text text-un1t-bg`), e.g. the active filter pill, the Send button.

**New tokens to add** (`tailwind.config.js → theme.extend.colors`):

```js
channel: {
  wa: '#1F9D57',  // WhatsApp — brand-adjacent green, darkened for AA text/contrast on white
  ig: '#D6417E',  // Instagram — flattened magenta
  em: '#3E6FD6',  // Email — blue
},
mia: '#6D5CE0',   // Mia / AI accent (approvals, agent). Solid, never a gradient.
```

This unlocks `text-channel-wa`, `ring-channel-ig`, `bg-mia/10`, etc. Semantic state keeps the **lint‑enforced chip recipe** `bg-<c>-500/10 text-<c>-700` on Tailwind's green/amber/red/violet (see `light-theme-chip-contrast`). Solid semantic actions stay as today (resolve = `green-600`, handoff = amber, approvals now = `mia`).

**Typography** — the CRM app currently renders in the **system stack** (`ui-sans-serif, system-ui`); Poppins/NEXA only load on `/welcome`. This redesign's identity comes from layout, the channel colour system, spacing and the violet accent — **not** from a bespoke face. v1 ships on the existing stack. Adding a distinctive display face (NEXA or a `next/font` import scoped to the app segment — a one‑line swap per the `fontFamily` comment in `tailwind.config.js`) is an **optional enhancement** (§7), not a blocker. Use the existing `font-display` utility for names / uppercase labels and `font-mono` for meta (timestamps, counts, phone).

**Motion:** restrained. One staggered column reveal on load; hover reveals for message meta. Respect `prefers-reduced-motion`.

---

## 3. Channel identity (the core new primitive)

New shared module — **`shared/channels.jsx`** (in the `shared/` seam so web + a future mobile pass agree), exporting:

```
CHANNELS = {
  wa: { key:'wa', label:'WA', name:'WhatsApp', token:'channel-wa', Logo: WhatsAppLogo },
  ig: { key:'ig', label:'IG', name:'Instagram', token:'channel-ig', Logo: InstagramLogo },
  em: { key:'em', label:'EM', name:'Email',     token:'channel-em', Logo: MailLogo },
}
channelOf(conversation) -> 'wa' | 'ig' | 'em'   // from the existing `_ch` tag set in UnifiedInbox
```

Two presentational components (co‑located, e.g. `src/components/inbox/ChannelBits.jsx`):

- **`<ChannelGlyph channel />`** — the leading logo in a conversation row. ~22px, `text-channel-<key>`, `title={name}` for a tooltip / a11y.
- **`<ChannelAvatar channel initials size badge />`** — initials tile with:
  - a **ring** in the channel colour: `ring-2 ring-channel-<key>` (box‑shadow ring, no layout shift; keep the existing 1px neutral border underneath),
  - an optional **corner badge** (`badge` prop) showing the same logo on a `bg-un1t-bg` chip — used in the thread header and Command Centre, omitted in the dense row (the row already leads with the glyph).

Logos are small inline SVGs (WhatsApp bubble, Instagram camera outline, envelope) drawn to `currentColor`. These are functional channel indicators of the operator's own conversations (not third‑party impersonation).

**Result — two independent, colour‑blind‑safe cues per channel:** a distinct logo *shape* + a colour, plus the spelled‑out name in detail views. Green WhatsApp vs pink Instagram vs blue Email reads instantly down the left edge.

---

## 4. Component‑by‑component changes

### 4.1 Queue row — `src/components/UnifiedInbox.jsx` (row ~L252–308)
New anatomy (grid: `auto auto 1fr auto`, vertically centered):

```
[ChannelGlyph] [ChannelAvatar initials] [ name · MIA chip / preview / state badges ] [ time / unread ]
```
- **Remove** the corner channel dot and the `[WA]`/`[IG]` text tag (now redundant).
- **Keep** the Mia chip (violet), the state badges (Approval = `mia`, Needs a human = amber, Not in contacts = amber, resolved = green check) and the unread pill (inverted).
- Selected state: 2.5px left rail in `un1t.text` + `bg-un1t-surface`.

### 4.2 Filter + search header — `UnifiedInbox.jsx` qhead (~L194–231)
Collapse the current three rows (title / channel chips / queue chips) into:
- **Row A:** title "Inbox" + a needs‑reply count pill + refresh.
- **Row B:** a **search input** (icon + placeholder + `/` hint). v1 filters the already‑loaded conversation list client‑side by name/preview; server search is a later dependency (§7).
- **Row C:** one segmented filter — **All · Needs reply · Handoff · Approvals** with counts, driven by the existing predicates in `src/lib/inbox-queues.js` (`needsReply`, `isAgentHandoff`, `needsAction`). Channel filtering moves into search/scope (or a small channel toggle) rather than its own always‑on row.

### 4.3 Unified "Handled by" control — new shared component
A segmented **`Mia ⇄ You`** control shown in every channel's thread header (replaces the inconsistent state today: IG has a toggle, WA has none, Email has no agent).
- **IG:** wires to the existing `PATCH /api/instagram/conversations/[id]/agent` (`IGInbox.jsx` ~L362–372).
- **WA (chosen — build now):** add `PATCH /api/whatsapp/conversations/[id]/agent` mirroring the IG route (service‑role, so **`getCurrentUser` + `assertLocationAccess`**; register in `openapi.js`) + a persisted **`agent_paused_at`** flag (migration via Supabase MCP; run `get_advisors` after; apply before the reading code deploys). The **Mia WA send path must check the flag before auto‑replying**. The control toggles it live, same semantics as IG.
- **Email:** control hidden (no agent) or shown as a static "You" affordance.

### 4.4 Thread header declutter — `src/components/WAInbox.jsx` (~L629–703; mirror in IG/Email headers)
- **Left:** `<ChannelAvatar badge>` + name + channel **name label** (`WhatsApp`, coloured) + stage; sub‑line = phone · 24h‑window status (mono; green "open"/amber "closed"), from `window_expires_at` (~L508–511).
- **Right:** the **Handled by** control · a single primary **Resolve** (`green-600`) · a **`⋯` overflow** holding Block, Add‑to‑contacts / View record, Mute. (Today Block + window pill + Resolve + Add‑to‑contacts all compete in one strip — this is the most obvious "bolted‑on" spot.)

### 4.5 Composer unification — `WAInbox.jsx` (~L900–942, template path ~L944–1064)
- One **`＋` menu** at the start of the composer bar: Template · Card set · Booking Flow · Media · Consultation. These are **the existing actions, re‑parented** — no new behaviour (`send-carousel`, `send-flow`, template picker, etc. unchanged).
- Window‑open: text field + `＋` + Send. Window‑closed: swap to the existing **template picker** (keep the RED/YELLOW `quality_rating` chips) but presented in the same frame.

### 4.6 Message bubbles & meta — `WAInbox.jsx` (bubbles ~L797–822, meta row ~L833–870)
- **Retire the hard‑coded WhatsApp palette** (`bg-[#0b141a]`, `bg-[#005c4b]`) in favour of tokens: inbound `un1t.surface`, outbound a neutral `un1t`‑derived fill. This also makes the thread theme‑consistent (and dark‑ready later).
- **Mia vs staff:** outbound messages carry a small author tag — `MIA` (violet) or the staff member's name (muted) — and Mia messages get a subtle `bg-mia/10` tint + `border-mia/40`. Removes today's ambiguity about who sent what.
- **Meta on hover:** reactions (inbound) and agent 👍/👎 (on `source==='agent'`, `POST /api/agent/feedback`) + ticks + time collapse to a hover‑revealed row to calm the timeline.

### 4.7 Command Centre — `src/components/CommandCentre.jsx`
- Header: `<ChannelAvatar badge>` + name + existing chips (stage, `Glofox: <status>`, WA‑unsub) using the chip recipe (~L127–140).
- **New signals strip** under the header: **Churn · Arrears · Visits 30d** stat tiles + a "seen Xd ago" line, all **wired in v1** into `/api/contacts/[id]/command-centre`: **Churn** from churn‑radar classification; **Arrears** read from the arrears **reconciliation output** (never computed raw — respect `awaiting‑authorization` handling and stale `glofox_invoices`); **Visits‑30d** from a Glofox attendance read. This is the fix for operators bouncing out to the full record for triage signals.
- **Notes:** surface the latest contact note (currently not shown in the inbox) as a compact card.
- Tabs (Profile / Activity / Book) and the Book panel's two systems (native consultations + Glofox next‑7‑days) are **unchanged in behaviour**; only restyled to the new tokens.

### 4.8 Approval cards — `src/components/ApprovalActionCard.jsx`
Restyle to the new system: eyebrow `MIA · needs your approval` (violet), the kind label, summary, note, and the Approve / Decline(+reason) / (retention) "Saved the member" actions — all **behaviour unchanged** (`PATCH /api/agent/membership-requests/[id]`). Decided state keeps the status chip + next‑steps pills + "Mia suggests". Just tokens + spacing.

---

## 5. Accessibility & states
- **Never colour‑alone:** channel = logo shape + colour + (in detail) text name. State badges carry text, not just hue.
- Contrast: chip recipe `bg-<c>-500/10 text-<c>-700`; channel tokens chosen for AA text on white.
- Visible `:focus-visible` ring (accent) on all interactive elements; hover‑revealed meta must also be keyboard‑reachable.
- Respect `prefers-reduced-motion`.

## 6. Rollout (incremental, each step shippable behind the existing page)
1. **Tokens** — add `channel.*` + `mia` to `tailwind.config.js`.
2. **`shared/channels.jsx` + `ChannelGlyph` / `ChannelAvatar`** — pure additions, no call sites yet.
3. **Queue row** re‑anatomy (§4.1) + **filter/search** header (§4.2).
4. **Thread header** declutter + **Handled by** control (§4.3–4.4). Includes the **WA agent‑pause migration + `PATCH /api/whatsapp/conversations/[id]/agent`** and the Mia‑send‑path check.
5. **Composer `＋`** (§4.5) + **bubble theming / Mia author** (§4.6).
6. **Command Centre** — **signals data wiring** (churn / arrears / visits into the payload) + notes + restyle (§4.7) + **approval card** restyle (§4.8).

## 7. Decisions (resolved 2026‑07‑22)
1. **WA "Handled by":** **build the WA pause/resume‑Mia endpoint now** (in v1) — not read‑only. → §4.3, scope item 9.
2. **Signals data:** **full wiring in v1** — Churn + Arrears + Visits‑30d. → §4.7, scope item 10.
3. **Display font:** **keep the system stack** for v1; a distinctive display face (NEXA / `next/font`) is a separate evaluation.
4. **Dark theme:** **deferred** — build tokens theme‑ready, no switch in v1.
5. **Search:** **client‑side** filter over loaded conversations for v1; server search later.

## 8. Non‑goals / risks
- Three near‑duplicate channel components (`WAInbox`/`IGInbox`/`EmailInbox`) each re‑implement list/queue/resolve/realtime; this spec restyles them but does **not** merge them. A shared thread‑pane refactor is a separate, larger effort — flagged, not attempted here, to keep the visual redesign low‑risk.
- Keep customer‑facing copy unaffected (this is staff chrome only).
