# Mia Live Pages and Offers (MIAPAGES.1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give Mia one live read of every live landing page and storefront offer in the conversation's organisation, and rules that make it her only source for an offer's price, end date and link.

**Architecture:** A new read-only agent tool, `list_current_offers`, beside `list_upcoming_events`. A pure view module turns page and offer records into model-facing entries; a reader module loads the records with the page's own "can this be sold now" checks; the tool executor wraps the reader and never throws. Prompt rules in `prompt.js` point Mia at the tool and tell her to match entries to the customer.

**Tech Stack:** Next.js 16 App Router, supabase-js (service role), vitest, `createFakeDb`, Anthropic Messages API tool use.

**Spec:** `docs/superpowers/specs/2026-11-23-mia-live-pages-and-offers-design.md`

## Global Constraints

- Work in the worktree `~/code/un1t-crm-mia-live-offers`, branch `mia-live-offers`. Run `npm ci` once before the first test.
- Every read is scoped in code: by organisation id, then by location id. No `locations.settings` in any select; name the columns.
- Nothing internal reaches the model: no promo key, plan code, membership id, product id, offer id, stock number, tag or lead source.
- Zone maths only through `@/lib/location-time`; no `'Europe/Dublin'` literal.
- Model-facing text (tool description, result messages, prompt rules) has no em or en dashes.
- A failed read is "unknown", never an empty list. Log with `logWarn`/`logError` from `@/lib/log`; no `console.log`.
- Destructure `error` from every read. Selects name only columns that exist (`npm run check:select-columns`).
- No migration. The one new stored value lives in `landing_pages.chrome` (jsonb).
- Never run the full vitest suite beside `npm run build` (8 GB machine): run them one after the other.
- Commit messages start `MIAPAGES.1 — `.

## Review Focus

1. A studio with a live page but an unreadable storefront: Mia still gets its pages, with `store_unreadable: true`, and never says "no offers". (Task 2)
2. An Open Week promo whose window ended yesterday on the studio's clock while the page is still live: it is left out. (Task 2)
3. A store offer that is sold out, or whose stock could not be read: `sold_out: true` in the first case, listed as available and not limited in the second, never dropped. (Task 2)
4. A customer on a studio whose organisation has a second studio with a live page switched on only there: the entry appears under the second studio's name, never under the conversation's. (Task 2)
5. A page whose "Who is this for?" line is blank or only spaces: the default by offer type is used. (Task 1)

---

### Task 1: Entry views (pure)

**Files:**
- Create: `src/lib/agent/offer-view.js`
- Test: `src/lib/agent/offer-view.test.js`

**Interfaces:**
- Produces:
  - `forLine(page: { offer_type, title, chrome }, summary: string|null): string`
  - `pageEntry({ page, mergedOffer, promo, zone, url, withOffer }): { title, kind, for, summary, price_label, ends_label, url }`. `kind` is the page's `offer_type`. `promo` is a `promoView` row (`src/lib/corp-promos-db.js`) or null. `withOffer: false` (a studio page whose trial a campaign page already lists, or offer type `none`) gives `price_label: null, ends_label: null`.
  - `storeEntry({ offer, stock, zone, url, now }): { name, category, bonus, price_label, ends_label, opens_label, limited, sold_out, url }`. `stock` is an `offerStockStatus` result or null.
  - `dateTimeLabel(iso: string, zone: string): string` and `dayLabel(isoDate: string, zone: string): string`, e.g. `Mon 30 Nov, 23:59` and `Sun 29 Nov`.

- [ ] **Step 1: Write the failing tests** in `offer-view.test.js`:

```js
it('paid trial: price from the merged block, no end date', () => {
  const e = pageEntry({ page: { title: '14 Day Reset', offer_type: 'paid_trial', chrome: {} },
    mergedOffer: { type: 'paid_trial', price_cents: 3900, currency: 'EUR', duration_days: 14 },
    promo: null, zone: 'Europe/Dublin', url: 'https://x.test/trial', withOffer: true })
  expect(e).toMatchObject({ title: '14 Day Reset', kind: 'paid_trial', price_label: '€39', ends_label: null, url: 'https://x.test/trial' })
  expect(e.for).toBe('Someone new who wants to try the studio.')
})
it('promo: Free, the class count in the summary, the window end as ends_label', () => {
  const e = pageEntry({ page: { title: 'Open Week', offer_type: 'promo_credits', chrome: {} },
    mergedOffer: { type: 'corp_promo', promo_key: 'secret-key' },
    promo: { kind: 'open_week', credits: 3, maxClasses: 3, windowStartsOn: '2026-11-23', windowEndsOn: '2026-11-29', live: true },
    zone: 'Europe/Dublin', url: 'https://x.test/openweek', withOffer: true })
  expect(e.price_label).toBe('Free')
  expect(e.summary).toMatch(/3/)
  expect(e.ends_label).toBe('Sun 29 Nov')
  expect(JSON.stringify(e)).not.toContain('secret-key')
})
it('one class page stores no price: price_label null', () => { /* offer_type one_class → null */ })
it('withOffer false: title, summary and url only', () => { /* price_label and ends_label null */ })
it('the editor line wins; blank or spaces falls back to the default', () => {
  expect(forLine({ offer_type: 'paid_trial', title: 'T', chrome: { mia_note: 'People over 50.' } }, null)).toBe('People over 50.')
  expect(forLine({ offer_type: 'paid_trial', title: 'T', chrome: { mia_note: '   ' } }, null)).toBe('Someone new who wants to try the studio.')
  expect(forLine({ offer_type: 'sale', title: 'T', chrome: {} }, null)).toBe('Anyone buying a pack, a membership or a gift.')
  expect(forLine({ offer_type: 'promo_credits', title: 'New Start', chrome: {} }, 'Three free classes for new members.')).toBe('New Start: Three free classes for new members.')
})
it('store offer: labels in the studio zone, limited and sold out as flags, no number', () => {
  const e = storeEntry({ offer: { name: '20 Class Pack', category: 'class_pack', bonus_headline: '+5 free classes', price_cents: 38000, currency: 'EUR', ends_at: '2026-11-30T23:59:59Z', starts_at: null, stock_limit: 50 },
    stock: { limit: 50, sold: 50, held: 0, left: 0, state: 'sold_out' }, zone: 'Europe/Dublin', url: 'https://x.test/offers/stillorgan/20-class-pack', now: new Date('2026-11-23T12:00:00Z') })
  expect(e).toEqual({ name: '20 Class Pack', category: 'class_pack', bonus: '+5 free classes', price_label: '€380', ends_label: 'Mon 30 Nov, 23:59', opens_label: null, limited: true, sold_out: true, url: 'https://x.test/offers/stillorgan/20-class-pack' })
})
it('store offer not yet open carries opens_label; stock null means not limited, not sold out', () => {})
```

- [ ] **Step 2: Run** `npx vitest run src/lib/agent/offer-view.test.js`. Expected: FAIL, module not found.
- [ ] **Step 3: Implement** the four exports. Price through `formatTrialPrice` (`src/lib/paid-trial.js`). Summary source: paid trial, `paidTrialCopyFromBlock`; one class, `campaignFunnelCopy(...).subhead`; promo, `corpPromoCopyFromBlocks` heading with tokens filled by `fillCorpPromoTokens`, plus "N free classes" from `promo.credits` (or `maxClasses` for an open week); sale and none, `page.chrome.meta_description` or null. One line, at most 200 characters. `limited` is `Number.isInteger(offer.stock_limit) && offer.stock_limit > 0`; `sold_out` is `stock?.state === 'sold_out'`.
- [ ] **Step 4: Run** the test file. Expected: PASS.
- [ ] **Step 5: Commit** `MIAPAGES.1 — entry views for Mia's live offers`.

### Task 2: The reader

**Files:**
- Create: `src/lib/agent/offer-read.js`
- Test: `src/lib/agent/offer-read.test.js`
- Read first: `src/app/(public)/[slug]/[[...rest]]/page.js` (how a page URL is formed per studio and how each offer type decides it can take a customer), `src/lib/landing-pages.js` (`offerReady`, `studioRowReadiness`, `pageStudioRows`, `mergedBlocksFor`, `studioPublicPath`).

**Interfaces:**
- Consumes: Task 1's `pageEntry`, `storeEntry`.
- Produces: `readCurrentOffers(db, { organizationId, threadLocationId, baseUrl, now = new Date() }): Promise<{ ok: true, studios: StudioOffers[] } | { ok: false }>` where `StudioOffers = { studio: string, this_conversation: boolean, pages: PageEntry[], store: StoreEntry[], pages_unreadable?: true, store_unreadable?: true }`. Never throws. `{ ok: false }` only when the page list itself and every storefront read failed.

Decisions:
- Pages: `landing_pages` where `organization_id = organizationId` and `publish_state = 'live'`, ordered by `slug`; their `landing_page_studios` rows with `enabled = true`, selecting `page_id, location_id, enabled, offer, sort_order, locations:location_id ( id, name, slug, membership_source, timezone )`. No `settings`, no `attribution`. Apply `pageStudioRows`.
- An offer is carried (`withOffer: true`) only when the page would take a customer now: reuse `offerReady` with the same inputs `studioRowReadiness` gathers, and for a promo additionally require `promo.live` and, for an open week, `openWeekState(promo, zone, now) === 'open'`. A promo page that fails this is left out entirely. A paid trial or one class page that fails it is left out entirely.
- A `kind = 'studio'` page is listed with `withOffer: false` when a `kind = 'campaign'` page at the same studio carries the same `offer_type`; otherwise it keeps its offer.
- A `sale` page is listed with `withOffer: false`. Store entries come from `sellableSaleOffers(db, locationId, { now })` for each studio that has any enabled live page or any active `sale_offers` row; stock from `readOfferStock` (`src/lib/offer-stock.js`); a null stock read leaves `stock: null`.
- URLs: `baseUrl` plus the path the public route serves for that page at that studio; store offers `/offers/<studioKey>/<slug>` (`saleOfferView` shows the form). `baseUrl` is the origin `executeEventTool` uses for the event sign-up link.
- Order: the thread's studio first, then by studio name. A studio with no pages and no store entries and no unreadable flag is omitted.
- Zone: `zoneOfLocation` from `@/lib/location-time` on the embedded location.

- [ ] **Step 1: Write the failing tests** with `createFakeDb` (see `tests/` helpers and an existing agent reader test for the idiom). One `it` each, asserting on the returned object:
  - a live page enabled at the studio is listed; a draft, a `coming_soon`, a `retired` page and a row with `enabled: false` are not;
  - a page of another organisation is not;
  - the trial appears once: `/trial` with `price_label: '€39'`, the studio page with `price_label: null`;
  - Review Focus 2: open week with `window_ends_on` the day before `now` in the studio zone is absent; the same row with `now` one day earlier is present;
  - a promo row with `live: false` is absent;
  - Review Focus 3: sold out gives `sold_out: true`; a failing `offer_stock_counts` rpc gives `limited` from `stock_limit` and `sold_out: false`;
  - Review Focus 1: `sale_offers` read errors → `{ ok: true }` with `store_unreadable: true` and the pages intact;
  - `landing_pages` read errors and store fine → `pages_unreadable: true` on each studio that has store entries;
  - both fail → `{ ok: false }`;
  - Review Focus 4: a page enabled only at the other studio sits under that studio with `this_conversation: false`;
  - `JSON.stringify(result)` contains none of the fixture's `promo_key`, `plan_code`, `membership_id`, `un1t_product_id`, offer `id` or `tag` values.
- [ ] **Step 2: Run** `npx vitest run src/lib/agent/offer-read.test.js`. Expected: FAIL, module not found.
- [ ] **Step 3: Implement** `readCurrentOffers`. Each source in its own try/catch; a `PageReadError` or a `{ ok: false }` from `sellableSaleOffers` sets the flag and logs with `logWarn('mia-offers', …, { locationId, code })`.
- [ ] **Step 4: Run** the test file, then `npm run check:select-columns && npm run check:location-scoping && npm run check:rpc-names`. Expected: PASS. If `check:location-scoping` asks, register `readCurrentOffers` in `scripts/check-location-scoping.mjs` `SCOPING_HELPERS`, as `resolvePublicPageRequest` is.
- [ ] **Step 5: Commit** `MIAPAGES.1 — live reader for pages and storefront offers`.

### Task 3: The tool, wired into every block

**Files:**
- Create: `src/lib/agent/offer-tools.js`
- Test: `src/lib/agent/offer-tools.test.js`
- Modify: `src/lib/agent/auto-reply.js` (`ALL_AGENT_TOOLS` near line 133; the dispatch chain near line 1310)
- Modify: `src/lib/agent/__fixtures__/glofox-agent-tools.fixture.json`, `no-booking-agent-tools.fixture.json`
- Modify as the tests demand: `src/lib/agent/tool-blocks.test.js`, `tool-schemas.test.js`

**Interfaces:**
- Consumes: `readCurrentOffers` (Task 2).
- Produces: `OFFER_TOOLS` (one tool), `OFFER_TOOL_NAMES: Set<string>`, `executeOfferTool(toolName, input, ctx): Promise<object>`; tool name `list_current_offers`, `input_schema: { type: 'object', properties: {} }`.

Tool description (exact):

> List what the studio is offering right now, read live: every public page that is switched on (trials, free class offers, sales) and every offer in the online store, for this studio and the organisation's other studios. Each entry says who it is for, its price_label, its ends_label when it has an end date, and its url. No identity verification needed. Call this before you answer anything about trying the studio, joining, prices, class packs, gift cards, deals or a sale, and before you state any offer's price, end date or link. Copy price_label and ends_label exactly. Entries flagged limited may be described as limited; never give a number. Never share the url of an entry flagged sold_out.

Results: on `{ ok: true }` return `{ studios }`, or `{ studios: [], message: 'Nothing is on offer online right now. Do not invent an offer; hand off if they want to buy.' }` when the list is empty. On `{ ok: false }` or a throw return `{ error: 'offers_unreadable', message: 'The offers could not be read just now. Say you cannot check at the moment and offer to pass them to the team. Never say there are no offers.' }`.

- [ ] **Step 1: Write the failing tests:** the three result shapes above (reader mocked with `vi.mock('./offer-read')`); the executor passes `organizationId`, the thread's `locationId` and the origin from `ctx`; a reader that throws gives `offers_unreadable`; the description contains no `—` or `–`.
- [ ] **Step 2: Run** `npx vitest run src/lib/agent/offer-tools.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement** `offer-tools.js`. Take the organisation id and origin from the same `ctx` fields `executeEventTool` reads; if `ctx` does not carry the organisation id, add it where `toolCtx` is built in `auto-reply.js` from `loc.organization_id`.
- [ ] **Step 4: Wire it.** Append `...OFFER_TOOLS` to `ALL_AGENT_TOOLS` after `...EVENT_TOOLS` and before `...CARD_TOOLS` (the last tool carries the cache breakpoint and must stay last). Add an `OFFER_TOOL_NAMES.has(block.name) ? await executeOfferTool(...)` arm to the dispatch chain before the `EVENT_TOOL_NAMES` arm. Confirm `executorCtxFor` resolves an unknown read tool to the thread's `toolCtx`; if it does not, add the name to its thread-studio list.
- [ ] **Step 5: Regenerate the two tool fixtures** the way `tool-blocks.test.js` documents, and add to `tool-blocks.test.js`: `list_current_offers` is in all five blocks and `refuseToolForTurn('list_current_offers', { turn: { block, channel: 'instagram' } })` is null for each block.
- [ ] **Step 6: Run** `npx vitest run src/lib/agent`. Expected: PASS (the optional-parameter budget in `tool-schemas.test.js` is unchanged: the tool has no parameters).
- [ ] **Step 7: Commit** `MIAPAGES.1 — list_current_offers tool in every Mia block`.

### Task 4: Mia's rules

**Files:**
- Modify: `src/lib/agent/prompt.js` (the fact rule near line 381, the trial rule near line 442, the entitlement rule near line 453, "When someone says YES" near line 394, the purchase rules near line 156; the no-booking and un1t variants of the same rules)
- Modify: `src/lib/agent/prompt.test.js`, the two `*-system-prompt.fixture.json` files

**Interfaces:**
- Produces: `CURRENT_OFFERS_RULES` (exported string) rendered in every block's system prompt.

`CURRENT_OFFERS_RULES` (exact copy; one section, no dashes):

```
## What is on offer right now
- An offer's price, what it includes, its end date and its link come only from list_current_offers, called in this conversation, copied exactly. KNOWLEDGE is for everything else (classes, policies, hours). If KNOWLEDGE and the tool disagree about an offer, the tool is right.
- Call list_current_offers before answering anything about trying the studio, joining, prices, class packs, gift cards, deals or a sale. Call it again rather than trusting a price from an earlier message in the thread.
- APPLY CONTEXT. First work out what this person is after (trying the studio, a membership, more classes, a gift, an offer for their company) and what you already know about them (new, on a trial, a member, which studio). Then offer the one or two entries whose "for" line fits them, with the price_label, the ends_label when there is one, and the url last with nothing after it. Never list everything. If it is not clear what they want, ask one short question first.
- Never offer a trial or a new customer page to someone you know is a current member. Offer an entry aimed at a group (a company's staff, the over 50s) only when the customer's own words put them in that group. You do not check who is eligible: say who it is for and that the page confirms it.
- Say "free" only for an entry whose price_label is "Free".
- When an entry is limited you may say it is limited. When it is sold_out, say it has sold out and never share its url. Never give a number.
- An entry listed under another studio is that studio's offer: name the studio.
- When they say yes to an entry on the list, or ask how to buy it, send that entry's url as the last thing in your message. Use request_membership_purchase only for a yes to something that is not on the list.
- If the tool cannot read the offers, say you cannot check right now and offer the team. Never say there are no offers.
- Do not open a conversation with an offer. Suggest one only when their message makes it relevant.
```

Edits to existing rules:
- Line 381: "ONLY state facts (prices, offers, policies, hours, what's included) that appear in the KNOWLEDGE section below" becomes "ONLY state facts (policies, hours, what a class involves) that appear in the KNOWLEDGE section below, and offers only as list_current_offers gives them."
- Line 442: the trial sentence reads the trial from `list_current_offers` ("offer the trial list_current_offers lists, with its title, price_label and url exactly as given"); "unless KNOWLEDGE describes one that is on offer now, or a tool says trial_available" becomes "unless list_current_offers lists one with price_label Free, or a tool says trial_available".
- Line 453: "Answer those only when KNOWLEDGE settles them word-for-word" becomes "You may describe an entry from list_current_offers and who it is for. Whether this one person is entitled to something goes to the team unless KNOWLEDGE settles it word for word."
- Line 395 ("When someone says YES"): prefix "If the offer is an entry from list_current_offers, send its url instead and do not call request_membership_purchase."
- Purchase rules (block 3b, line 156 on): add one line, "When list_current_offers has a live store entry that matches what they asked for, mention it with its url alongside the options from list_purchase_options, so a sale price is never hidden."

- [ ] **Step 1: Write the failing tests** in `prompt.test.js`: every block's prompt (glofox, no_booking, un1t_read, un1t_read_dual, un1t_full; WhatsApp and Instagram) contains `CURRENT_OFFERS_RULES`; no prompt contains "that appear in the KNOWLEDGE section below. If" with "prices, offers"; the section has no `—` or `–`.
- [ ] **Step 2: Run** `npx vitest run src/lib/agent/prompt.test.js`. Expected: FAIL.
- [ ] **Step 3: Make the edits.** Place the section in the cached part of the prompt, after the buttons section.
- [ ] **Step 4: Regenerate** the two system-prompt fixtures, then run `npx vitest run src/lib/agent`. Expected: PASS.
- [ ] **Step 5: Commit** `MIAPAGES.1 — Mia's rules read offers from the live list`.

### Task 5: "Who is this for?" in the page editor

**Files:**
- Modify: `src/lib/landing-page-schemas.js` (`landingPageChromeSchema`): add `mia_note: z.string().trim().max(200).nullable()`
- Modify: `src/components/LandingPageSettingsForm.jsx`: one text input in the page settings, label "Who is this for? (Mia reads this)", help text "Optional. One line telling Mia who to suggest this page to. Left blank, she works it out from the page.", bound to `chrome.mia_note`, using the `@/components/ui` input the neighbouring `chooser_label` field uses.
- Test: `src/components/LandingPageSettingsForm.page.test.jsx`, the schema's test file.

**Interfaces:**
- Produces: `page.chrome.mia_note`, read by Task 1's `forLine`.

- [ ] **Step 1: Write the failing tests:** the schema accepts `{ mia_note: 'People over 50.' }` and `{ mia_note: null }` and rejects 201 characters; the form renders the field with the stored value and sends `chrome.mia_note` on save.
- [ ] **Step 2: Run** the two test files. Expected: FAIL.
- [ ] **Step 3: Implement.** Check `mergedChrome` (`src/lib/landing-pages.js:716`) passes the new key through.
- [ ] **Step 4: Run** the two test files. Expected: PASS.
- [ ] **Step 5: Commit** `MIAPAGES.1 — "Who is this for?" line on a page`.

### Task 6: Docs, checks, PR

**Files:**
- Create: `docs/changelog/entries/<PR>.md` (after the PR number exists)
- Modify: `docs/architecture/REFERENCE.md` (Mia's tool list), `docs/rules/conventions.md` and `CLAUDE.md` (one line: "Mia states an offer's price, end date and link only from `list_current_offers`; a new public surface that sells something is added to `readCurrentOffers`.")

- [ ] **Step 1:** `npm run build`. Expected: compiles.
- [ ] **Step 2:** the CI mirror from `CLAUDE.md`, after the build has finished. Expected: all pass.
- [ ] **Step 3:** Real-data check. With the Supabase MCP, run the reader's two selects against project `iyvtbjjxdggiadzwwvdj` and confirm by hand that the entries match the live pages: 14 Day Reset €39 at both studios, Open Week, New Start at Stillorgan, Corporate promo and Hatch's eight store offers ending 30 Nov.
- [ ] **Step 4:** Check the PR is not already merged, push `HEAD:mia-live-offers`, `gh pr create --base main --fill`, add the changelog entry, push again. No customer names in the PR body.
- [ ] **Step 5:** After deploy, send Mia a test WhatsApp at each studio ("any Black Friday deals?", "I'd like to try a class", "do you do gift cards?") and confirm the prices, end dates and links against the pages.
