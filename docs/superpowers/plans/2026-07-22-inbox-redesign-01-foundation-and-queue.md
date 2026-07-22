# Inbox Redesign — Plan 1: Foundation & Queue — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the inbox its new channel identity (WhatsApp/Instagram/Email logo + colour ring + label) and a cleaner one-row filter + search, delivering the approved "Refined" look for the conversation list with zero backend changes.

**Architecture:** A pure, mobile-safe channel-metadata module in `shared/` feeds two small web-only presentational components (`ChannelGlyph`, `ChannelAvatar`). The unified queue row in `UnifiedInbox.jsx` is re-anatomised to lead with the glyph + ringed avatar and drop the old corner dot / `[WA]` tag. The three-row filter stack collapses to one segmented filter + a client-side search box. New Tailwind `channel.*` + `mia` colour tokens back it all.

**Tech Stack:** Next.js 16 (App Router) · React 19 · Tailwind 3.4 (`un1t.*` intent tokens) · Vitest (pure-lib tests, no DB) · `lucide-react` (existing icon lib).

**Spec:** `docs/superpowers/specs/2026-07-22-inbox-visual-redesign-design.md` (§2, §3, §4.1, §4.2, §6 step 1–3).

**Repo invariants that bite here (from `CLAUDE.md`):**
- **Tailwind JIT only sees *literal* class strings.** Never build a class via template string (`` `text-channel-${key}` ``) — the JIT won't emit it. Use a static lookup map so every full class name (`text-channel-wa`, `ring-channel-ig`, …) appears verbatim in source. `shared/**` is already in the Tailwind `content` globs.
- **`shared/` is the web↔mobile seam; mobile (RN) cannot render `<svg>`.** Keep `shared/channels.js` pure data (no JSX). Put all SVG/JSX in a **web** component file. `npm run check:mobile-imports` guards mobile importing non-exported/native-incompatible names.
- **`next build` is the real gate** — vitest runs on mocked imports, so a new import only fails in the Turbopack build. Run `npm run build` for any task that adds an import or touches a page/component.
- **Chip recipe** stays `bg-<c>-500/10 text-<c>-700` (lint-enforced `no-low-contrast-chip`).
- **Every `<button>` in a `<form>` defaults to `type="submit"`** — set `type="button"` on filter pills / the search-clear.
- **zsh globs `[id]`** — single-quote any path with brackets in git/test commands.

**CI mirror to run before every commit that touches JS:**
```bash
npm test && npm run lint && npm run check:mobile-parity && npm run check:mobile-imports && npm run check:route-guards && npm run check:guardrails
```

---

### Task 1: Add `channel.*` + `mia` design tokens

**Files:**
- Modify: `tailwind.config.js` (the `theme.extend.colors` object — the `un1t` / `stage` block)

- [ ] **Step 1: Add the tokens**

In `tailwind.config.js`, inside `theme.extend.colors`, add two sibling entries next to `un1t` and `stage`:

```js
        // Channel identity — the one sanctioned use of colour beyond
        // semantic state (INBOX-REDESIGN 2026-07). Values darkened from
        // brand hues for AA text/ring contrast on the light canvas.
        channel: {
          wa: '#1F9D57', // WhatsApp
          ig: '#D6417E', // Instagram
          em: '#3E6FD6', // Email
        },
        // Mia / AI accent (approvals, agent state). Solid, never a gradient.
        mia: '#6D5CE0',
```

- [ ] **Step 2: Prove the JIT emits the classes**

Add a temporary literal usage so the build compiles the utilities, then confirm the build is green. Create `src/app/_token-probe.txt` with the literal strings (Tailwind scans `.txt`? No — use a real file it scans). Instead, verify via the next tasks which use the classes literally. For now just typecheck the config:

Run: `npm run build`
Expected: PASS (config parses; unused colours are harmless).

- [ ] **Step 3: Commit**

```bash
git add tailwind.config.js
git commit -m "INBOX-REDESIGN.1 — add channel.* and mia colour tokens"
```

---

### Task 2: Channel metadata module (pure, mobile-safe)

**Files:**
- Create: `shared/channels.js`
- Test: `shared/channels.test.js`

- [ ] **Step 1: Write the failing test**

```js
// shared/channels.test.js
import { describe, it, expect } from 'vitest';
import { CHANNELS, CHANNEL_KEYS, channelOf, channelMeta } from './channels';

describe('channels', () => {
  it('exposes wa/ig/em with label + name + token', () => {
    expect(CHANNEL_KEYS).toEqual(['wa', 'ig', 'em']);
    expect(CHANNELS.wa).toMatchObject({ key: 'wa', label: 'WA', name: 'WhatsApp', token: 'channel-wa' });
    expect(CHANNELS.ig).toMatchObject({ key: 'ig', label: 'IG', name: 'Instagram', token: 'channel-ig' });
    expect(CHANNELS.em).toMatchObject({ key: 'em', label: 'EM', name: 'Email', token: 'channel-em' });
  });

  it('channelOf reads the merged-conversation _ch tag', () => {
    expect(channelOf({ _ch: 'ig' })).toBe('ig');
    expect(channelOf({ _ch: 'em' })).toBe('em');
  });

  it('channelOf falls back to wa for unknown/missing', () => {
    expect(channelOf({})).toBe('wa');
    expect(channelOf(null)).toBe('wa');
    expect(channelOf({ _ch: 'sms' })).toBe('wa');
  });

  it('channelMeta returns the full record', () => {
    expect(channelMeta({ _ch: 'ig' }).name).toBe('Instagram');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run shared/channels.test.js`
Expected: FAIL — `Cannot find module './channels'`.

- [ ] **Step 3: Write the module**

```js
// shared/channels.js
// Channel identity metadata. PURE DATA ONLY — no JSX/SVG, so this file is
// safe to import from mobile (RN). SVG logos + components live in the web-only
// src/components/inbox/ChannelBits.jsx. (INBOX-REDESIGN 2026-07)

export const CHANNELS = {
  wa: { key: 'wa', label: 'WA', name: 'WhatsApp', token: 'channel-wa' },
  ig: { key: 'ig', label: 'IG', name: 'Instagram', token: 'channel-ig' },
  em: { key: 'em', label: 'EM', name: 'Email', token: 'channel-em' },
};

export const CHANNEL_KEYS = ['wa', 'ig', 'em'];

// UnifiedInbox tags each merged conversation with `_ch` ('wa' | 'ig' | 'em').
export function channelOf(conversation) {
  const ch = conversation && conversation._ch;
  return CHANNELS[ch] ? ch : 'wa';
}

export function channelMeta(conversation) {
  return CHANNELS[channelOf(conversation)];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run shared/channels.test.js`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add shared/channels.js shared/channels.test.js
git commit -m "INBOX-REDESIGN.2 — channel metadata module (pure, mobile-safe)"
```

---

### Task 3: `ChannelGlyph` + `ChannelAvatar` web components

**Files:**
- Create: `src/components/inbox/ChannelBits.jsx`

> Uses **static class maps** (not template strings) so Tailwind's JIT emits every `text-channel-*` / `ring-channel-*` utility. Ring is a `ring-2` box-shadow (no layout shift); keep the neutral border underneath.

- [ ] **Step 1: Create the component file**

```jsx
// src/components/inbox/ChannelBits.jsx
'use client';
import { CHANNELS, channelOf } from '../../../shared/channels';

// --- static class maps (literal strings for the Tailwind JIT) ---
const TEXT = { wa: 'text-channel-wa', ig: 'text-channel-ig', em: 'text-channel-em' };
const RING = { wa: 'ring-channel-wa', ig: 'ring-channel-ig', em: 'ring-channel-em' };

// --- brand-recognisable logos, drawn to currentColor ---
function Logo({ channel, className }) {
  if (channel === 'ig') {
    return (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" className={className} aria-hidden="true">
        <rect x="3.2" y="3.2" width="17.6" height="17.6" rx="5.2" />
        <circle cx="12" cy="12" r="4.1" />
        <circle cx="17.3" cy="6.7" r="1.15" fill="currentColor" stroke="none" />
      </svg>
    );
  }
  if (channel === 'em') {
    return (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" className={className} aria-hidden="true">
        <rect x="3" y="5" width="18" height="14" rx="2.5" />
        <path d="M4 7l8 6 8-6" />
      </svg>
    );
  }
  // WhatsApp (default)
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden="true">
      <path d="M12 2.2A9.8 9.8 0 0 0 3.4 17L2.2 21.4l4.5-1.2A9.8 9.8 0 1 0 12 2.2zm0 1.8a8 8 0 0 1 6.9 12A8 8 0 0 1 7.9 18.7l-.3-.2-2.7.7.7-2.6-.2-.3A8 8 0 0 1 12 4zm-3.1 3.9c-.15 0-.4 0-.6.35-.2.35-.8.78-.8 1.9 0 1.13.82 2.22.94 2.38.11.15 1.6 2.55 3.96 3.48 1.96.77 2.36.62 2.79.58.43-.04 1.38-.56 1.57-1.1.2-.55.2-1.01.14-1.11-.06-.1-.21-.16-.45-.28-.24-.12-1.38-.68-1.6-.76-.21-.08-.37-.12-.52.12-.15.24-.6.76-.73.91-.13.15-.27.17-.5.06-.24-.12-1-.37-1.9-1.18-.7-.63-1.18-1.4-1.31-1.64-.13-.24-.01-.37.1-.48.11-.11.24-.28.36-.42a1.6 1.6 0 0 0 .24-.4.44.44 0 0 0-.02-.42c-.06-.12-.52-1.27-.72-1.74-.18-.44-.37-.38-.52-.39z" />
    </svg>
  );
}

// Leading channel logo for a conversation row.
export function ChannelGlyph({ conversation, channel }) {
  const key = channel || channelOf(conversation);
  const m = CHANNELS[key];
  return (
    <span className={`grid h-6 w-6 flex-none place-items-center ${TEXT[key]}`} title={m.name}>
      <Logo channel={key} className="h-[21px] w-[21px]" />
      <span className="sr-only">{m.name}</span>
    </span>
  );
}

// Initials tile with a channel-colour ring and an optional corner logo badge.
export function ChannelAvatar({ conversation, channel, initials, badge = false, className = '' }) {
  const key = channel || channelOf(conversation);
  const m = CHANNELS[key];
  return (
    <div
      className={`relative grid h-9 w-9 flex-none place-items-center rounded-[11px] border border-un1t-border bg-un1t-surface text-[13px] font-semibold text-un1t-text ring-2 ${RING[key]} ${className}`}
    >
      {initials}
      {badge && (
        <span
          className={`absolute -bottom-1 -right-1 grid h-[18px] w-[18px] place-items-center rounded-md border border-un1t-border bg-un1t-bg ${TEXT[key]}`}
          title={m.name}
        >
          <Logo channel={key} className="h-3 w-3" />
        </span>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Verify it builds and lints**

Run: `npm run build && npm run lint`
Expected: PASS (component compiles; `text-channel-*`/`ring-channel-*` now appear literally so the JIT emits them).

- [ ] **Step 3: Commit**

```bash
git add src/components/inbox/ChannelBits.jsx
git commit -m "INBOX-REDESIGN.3 — ChannelGlyph + ChannelAvatar components"
```

---

### Task 4: Re-anatomise the queue row

**Files:**
- Modify: `src/components/UnifiedInbox.jsx` (the conversation-row render, current-state map ~L252–308; `import` block at top)

> New row anatomy: `[ChannelGlyph] [ChannelAvatar (ringed)] [ name · MIA chip / preview / state badges ] [ time / unread ]`. Remove the old corner channel dot and the `[WA]`/`[IG]` text tag. Keep the Mia chip, state badges, unread pill, and the selected left-rail.

- [ ] **Step 1: Import the new components**

At the top of `src/components/UnifiedInbox.jsx`, add:

```jsx
import { ChannelGlyph, ChannelAvatar } from '@/components/inbox/ChannelBits';
import { channelOf } from '../../shared/channels';
```

- [ ] **Step 2: Replace the row's leading avatar + name-tag markup**

Find the row container (a grid/flex row keyed by conversation, ~L252–308). Make the row a 4-column grid and replace the leading avatar block and the `[WA]` tag. The row's outer element becomes:

```jsx
<button
  type="button"
  onClick={() => selectConversation(c)}
  className={`relative grid w-full grid-cols-[auto_auto_1fr_auto] items-center gap-[11px] border-b border-un1t-border px-[15px] py-3 text-left ${
    isSelected ? 'bg-un1t-surface before:absolute before:inset-y-0 before:left-0 before:w-[2.5px] before:bg-un1t-text before:content-[""]' : 'hover:bg-un1t-surface'
  }`}
>
  <ChannelGlyph channel={channelOf(c)} />
  <ChannelAvatar channel={channelOf(c)} initials={initialsFor(c)} />
  <div className="flex min-w-0 flex-col gap-[3px]">
    <div className="flex items-center gap-[7px]">
      <span className="truncate font-display text-[13.5px] font-semibold">{rowName(c)}</span>
      {c.handledByMia && (
        <span className="inline-flex items-center gap-1 rounded-md bg-mia/10 px-1.5 py-[3px] text-[9.5px] font-semibold text-mia">MIA</span>
      )}
    </div>
    {/* existing preview line + state badges stay, unchanged */}
  </div>
  {/* existing right column (time + unread pill) stays, unchanged */}
</button>
```

Notes for the engineer:
- `rowName(c)` / `initialsFor(c)` / `selectConversation` / `isSelected` are the row's existing helpers — reuse whatever the current row already computes; do not invent new ones. If initials aren't already derived, compute from `rowName(c)` (first letters of first two words).
- **Delete** the old channel-dot element and the `<span>` rendering the `[WA]`/`[IG]` label.
- Keep the existing preview line, the state badges (Approval / Needs a human / Not in contacts / resolved) and the right-hand time+unread exactly as they are — only their container grid changed to `grid-cols-[auto_auto_1fr_auto]`.
- If the row was a `<div>` with an `onClick`, prefer the `<button type="button">` shown (keyboard-focusable); if that's too invasive, keep the existing element but ensure it has `role`/`tabIndex`/`onKeyDown` for a11y.

- [ ] **Step 3: Verify build + lint + guardrails**

Run: `npm run build && npm run lint && npm run check:guardrails`
Expected: PASS.

- [ ] **Step 4: Visual check**

Run: `npm run dev`, open `http://localhost:3000/communications/inbox`, confirm: WhatsApp rows show a green logo + green-ringed avatar, Instagram rows pink, Email blue; no `[WA]` tag or corner dot remains; selected row shows the left rail.

- [ ] **Step 5: Commit**

```bash
git add src/components/UnifiedInbox.jsx
git commit -m "INBOX-REDESIGN.4 — channel logo + ring on queue rows"
```

---

### Task 5: One-row filter + client-side search

**Files:**
- Modify: `src/components/UnifiedInbox.jsx` (the queue header `qhead`, ~L194–231; add a `search` state + a filter helper)
- Test: `src/components/UnifiedInbox.filter.test.js` (pure helper only)

> Collapse the three header rows (title / channel chips / queue chips) into: **Row A** title + needs-reply count + refresh; **Row B** a search input; **Row C** one segmented filter `All · Needs reply · Handoff · Approvals` using the existing `src/lib/inbox-queues.js` predicates. Search filters the already-loaded list client-side.

- [ ] **Step 1: Write the failing test for the search helper**

```js
// src/components/UnifiedInbox.filter.test.js
import { describe, it, expect } from 'vitest';
import { matchesSearch } from '@/lib/inbox-search';

describe('matchesSearch', () => {
  const c = { name: 'Aoife Nolan', lastMessagePreview: 'pause my membership' };
  it('matches on name, case-insensitive', () => {
    expect(matchesSearch(c, 'aoife')).toBe(true);
    expect(matchesSearch(c, 'NOLAN')).toBe(true);
  });
  it('matches on message preview', () => {
    expect(matchesSearch(c, 'membership')).toBe(true);
  });
  it('empty query matches everything', () => {
    expect(matchesSearch(c, '')).toBe(true);
    expect(matchesSearch(c, '   ')).toBe(true);
  });
  it('no match returns false', () => {
    expect(matchesSearch(c, 'zzz')).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/components/UnifiedInbox.filter.test.js`
Expected: FAIL — `Cannot find module '@/lib/inbox-search'`.

- [ ] **Step 3: Write the search helper**

```js
// src/lib/inbox-search.js
// Client-side conversation search over the already-loaded queue.
// Match on the fields the row actually shows: display name + last-message preview.
export function matchesSearch(conversation, query) {
  const q = (query || '').trim().toLowerCase();
  if (!q) return true;
  const hay = [
    conversation?.name,
    conversation?.contactName,
    conversation?.lastMessagePreview,
    conversation?.lastMessage,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  return hay.includes(q);
}
```

> The engineer should confirm which preview field the row actually reads (`lastMessagePreview` vs `lastMessage` vs a computed `preview`) and include it in the `hay` array — keep all candidates as shown so it's robust.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/components/UnifiedInbox.filter.test.js`
Expected: PASS (4 tests).

- [ ] **Step 5: Wire search state + collapse the header**

In `UnifiedInbox.jsx`:
- Add state: `const [search, setSearch] = useState('');`
- Import: `import { matchesSearch } from '@/lib/inbox-search';`
- Where the visible list is computed (after the existing queue-filter predicate is applied), add `.filter((c) => matchesSearch(c, search))`.
- Replace the `qhead` markup with three rows:

```jsx
<div className="flex flex-col gap-[11px] border-b border-un1t-border px-[15px] pb-[11px] pt-[14px]">
  {/* Row A: title + count + refresh (reuse existing count + refresh handler) */}
  <div className="flex items-center gap-[9px]">
    <span className="font-display text-xs font-bold uppercase tracking-[0.2em]">Inbox</span>
    {needsReplyCount > 0 && (
      <span className="ml-auto rounded-full bg-green-500/10 px-2 py-1 font-mono text-[11px] text-green-700">
        {needsReplyCount} need reply
      </span>
    )}
    {/* existing refresh <button type="button"> stays */}
  </div>

  {/* Row B: search */}
  <label className="flex items-center gap-2 rounded-[9px] border border-un1t-border bg-un1t-surface px-[11px] py-2 text-un1t-subtle">
    <SearchIcon className="h-[15px] w-[15px] flex-none" aria-hidden="true" />
    <input
      type="text"
      value={search}
      onChange={(e) => setSearch(e.target.value)}
      placeholder="Search people & messages"
      className="w-full border-0 bg-transparent text-[13px] text-un1t-text outline-none placeholder:text-un1t-subtle"
    />
  </label>

  {/* Row C: segmented filter — reuse existing filter state + counts */}
  <div className="flex flex-wrap gap-1.5">
    {FILTERS.map((f) => (
      <button
        key={f.key}
        type="button"
        onClick={() => setQueueFilter(f.key)}
        className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1.5 text-[11px] font-semibold ${
          queueFilter === f.key ? 'border-transparent bg-un1t-text text-un1t-bg' : 'border-un1t-border text-un1t-muted'
        }`}
      >
        {f.label} <span className="font-mono text-[10px] opacity-70">{f.count}</span>
      </button>
    ))}
  </div>
</div>
```

Notes:
- `SearchIcon` = the existing `lucide-react` search icon already imported elsewhere in the file (`Search`); reuse it, don't add a new dep.
- `FILTERS` = `[{key:'all',label:'All',count:...}, {key:'needs',label:'Needs reply',count:...}, {key:'handoff',label:'Handoff',count:...}, {key:'approvals',label:'Approvals',count:...}]` computed from the **existing** predicates in `src/lib/inbox-queues.js` (`needsReply`, `isAgentHandoff`, `needsAction`) — reuse the counts the header already computes; do not recompute predicates inline.
- The old separate **channel chip row** is removed (channel is now obvious per-row); if you want channel scoping later it lives in search, not a permanent row.

- [ ] **Step 6: Verify build + lint + full CI mirror**

Run:
```bash
npm run build && npm test && npm run lint && npm run check:mobile-parity && npm run check:mobile-imports && npm run check:route-guards && npm run check:guardrails
```
Expected: PASS.

- [ ] **Step 7: Visual check**

`npm run dev` → `/communications/inbox`: header is now three tidy rows; typing in search filters the list live; the four filter pills switch the queue as before.

- [ ] **Step 8: Commit**

```bash
git add src/components/UnifiedInbox.jsx src/lib/inbox-search.js src/components/UnifiedInbox.filter.test.js
git commit -m "INBOX-REDESIGN.5 — single-row filter + client-side search"
```

---

## Ship

- [ ] Open the PR off a fresh branch (`git fetch origin main && git checkout -b inbox-redesign-foundation origin/main` before Task 1 if not already branched), push, `gh pr create --base main --fill`, and report the URL. The Vercel check on the PR is the real build gate.

---

## Self-review (against spec §2, §3, §4.1, §4.2)

- **§2 tokens** → Task 1 (`channel.*`, `mia`). Neutrals/primary reused, not redefined. ✓
- **§3 channel system** → Tasks 2–3 (`shared/channels.js` pure meta + `ChannelGlyph`/`ChannelAvatar`), split web/mobile per the seam. ✓
- **§4.1 queue row** → Task 4 (glyph → ringed avatar → name; dot + tag removed; badges/unread/left-rail kept). ✓
- **§4.2 filter + search** → Task 5 (one-row filter reusing `inbox-queues.js`; client-side `matchesSearch`). ✓
- **Deferred correctly:** thread header / Handled-by / composer / bubbles / Command Centre signals are Plans 2–4, not here. ✓
- **No placeholders:** every code step shows real code; UI-only steps verify via build/lint/guardrails + a named visual check (repo has no component-render tests — pure logic is unit-tested: `channelOf`, `matchesSearch`). ✓

## Program roadmap (subsequent plans — to be expanded when we reach them)

- **Plan 2 — Thread header & Handled-by** *(backend)*: migration adding `whatsapp_conversations.agent_paused_at`; `PATCH /api/whatsapp/conversations/[id]/agent` (service-role → `getCurrentUser` + `assertLocationAccess`, register in `openapi.js`); the Mia WA send path checks the flag before auto-replying; the shared `Mia ⇄ You` control + decluttered header (Resolve primary, `⋯` overflow) across WA/IG/Email; `ChannelAvatar badge` + channel name label in the header. Apply migration via Supabase MCP + `get_advisors` before the reading code deploys.
- **Plan 3 — Composer `＋` & bubble theming** *(no backend)*: single `＋` menu re-parenting Template/Card set/Booking Flow/Media/Consultation; retire the hard-coded WhatsApp bubble palette for tokens; Mia-vs-staff author tag + `bg-mia/10` tint; hover-revealed reactions/thumbs.
- **Plan 4 — Command Centre signals** *(backend)* + **approval-card restyle**: wire Churn (churn-radar) + Arrears (reconcile output, never raw) + Visits-30d (Glofox attendance) into `/api/contacts/[id]/command-centre`; signals strip + notes; restyle `ApprovalActionCard` to the new tokens (behaviour unchanged).
