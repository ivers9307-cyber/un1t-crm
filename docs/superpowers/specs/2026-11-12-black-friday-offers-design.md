# Black Friday Head Start — studio offer pages (design)

Date: 12 Nov 2026. Owner: Richard. Source: the "Black Friday Head Start" staff brief (both studios).

## Intent

Black Friday runs Mon 23 Nov to Mon 30 Nov 2026 at both studios: bonus time on every membership and
bonus classes on every pack, plus Cyber Monday gifts on 30 Nov. Today `/offers` is a single storefront
pinned to Stillorgan (`src/lib/offers-home.js`) and Hatch Street has no offer page at all. Each studio
gets its own offer page that sells its own Black Friday products at its own prices, ready to take money
at 00:00 Dublin time on 23 Nov and closing itself at 23:59 on 30 Nov, with no extensions.

Success means a person from an ad, an email or an Open Week visit can pick a studio, see that studio's
offer, and pay in a couple of minutes. Staff get every sale in front of them to set up and add the bonus.
Team goal from the brief: Stillorgan 220 and Hatch Street 100.

## The offer (from the brief)

New members:

| Product | Bonus | Stillorgan | Hatch Street |
|---|---|---|---|
| 12-month | +3 months free | €2,169 | €2,268 |
| 6-month | +6 weeks free | €1,144 | €1,194 |
| 3-month | +3 weeks free | €597 | €627 |
| 1-month | +2 weeks free | €99 | €99 |
| 30-class pack | +10 classes | €510 | €540 |
| 20-class pack | +5 classes | €380 | €400 |

Cyber Monday gifts (on sale Mon 30 Nov only): buy a €100 gift card and get a €20 bonus card (bonus used
Jan to Feb); Gift a Reset €39.

Also in the brief, shown as information only (not sold on the page):
- **Current members:** bring a friend and the friend gets a free Reset plus Black Friday pricing. Each
  friend who joins earns a free HYROX SIM or UN1TY entry. Whoever brings the most friends wins 3 months free.
- **Former members:** rejoin for €99 for the first month, plus the Black Friday bonuses. Bring a friend
  free for 1 month.
- **Black Friday Open Week:** 23 to 29 Nov at both studios.

## Decisions Richard made (12 Nov)

1. **Web addresses:** `/offers/stillorgan` and `/offers/hatch-street`. Plain `/offers` becomes a
   "pick your studio" page, so old links (emails, Instagram bio) still work.
2. **No was-price.** This is bonus time, not a discount. Remove the August €100 struck-through price
   and the "€100 discount is already included" line. Nothing on the page claims a discount.
3. **1-month = one payment of €99 for 6 weeks.** It is not the first month of a subscription.
4. **Info blocks:** current members, former members and Open Week appear as short blocks under the
   products. They point people to staff or a reply and have no checkout. The €99 former-member rejoin
   is handled by staff only, because the page cannot tell who is a former member.
5. **Teaser now.** Both pages go live straight away with "Opens Monday 23 November" and a countdown
   to opening. Products can be seen but not bought before 00:00 on 23 Nov. After 23:59 on 30 Nov they
   show as closed.
6. **Cyber Monday gifts:** shown during the week as "Cyber Monday only", buyable only on 30 Nov.
   "Members get first access" in the brief means nothing extra: everyone starts on the 23rd.
7. **Where each sale came from** (Open Week, direct, referral, former member, corporate): **staff log
   it.** Checkout gets no new field.
8. **Stillorgan pays as today:** the existing Revolut checkout, and staff set the buyer up by hand from
   Offer sales (`/offer-sales`).
9. **Hatch memberships and packs pay through un1t.online's own hosted checkout,** as the Hatch €39 trial
   does. Staff add the bonus weeks or classes by hand afterwards. The existing Hatch products are already
   priced at the Black Friday figures, so they are used as they are:
   3-month `de6fbadc…` €627, 6-month `d60b05bb…` €1,194, 1-year `a85d6e20…` €2,268,
   20-pack `741855ef…` €400, 30-pack `b1d7ab46…` €540. The 3, 6 and 12-month products are
   **recurring in un1t.online and renew as normal.** Richard confirmed this.
10. **Hatch 1-month:** Richard will create a €99 one-off "1 Month (Black Friday)" product in
    un1t.online. The page links it once the sync mirrors it into `un1t_products`. Until then, the Hatch
    1-month card is hidden (no row, or `active=false`).
11. **Hatch Cyber Monday gifts go through Revolut,** the same rail as Stillorgan's gift cards, because
    un1t.online has no gift-card product. Staff issue them by hand. Hatch gets only the €100 + €20 card
    and Gift a Reset. Stillorgan keeps its existing €100/€200/€500/€1,000 cards and adds the two
    Cyber Monday gifts.

### Second round (12 Nov, after the builder check)

12. **Late payments are honoured.** New checkouts stop at 23:59 on 30 Nov. A Hatch buyer who started
    a un1t.online checkout before then and pays later (the link lasts about 24 hours) still gets the offer.
    The settle sweep keeps matching those rows past `ends_at`, within the existing expiry.
13. **Anyone can buy.** There is no "new members only" check at either studio. Staff sort out any
    existing member who buys, such as a Hatch member who ends up with two subscriptions.
14. **Hatch buys made off the page also get the bonus.** Every un1t.online purchase of a Black Friday
    product at Hatch dated 23 Nov 00:00 to 30 Nov 23:59 Dublin (in the app, at the desk, or on the page)
    appears in staff's list with its bonus to add. The page's own rows settle as in decision 9. Mirrored
    transactions with no page row are listed too, and none is listed twice.
15. **Hatch renewal line.** Each Hatch 3, 6 and 12-month card and product page says plainly that
    the plan renews at the normal price, in the shape "Renews at €X every N months after your bonus time.
    Cancel any time before." Richard confirms the final words. Packs and the 1-month have no renewal line.
16. **€100 gift card + €20 bonus:** the €100 card is valid for 5 years (the legal minimum for a bought
    voucher). The free €20 bonus card is promotional and can be used 1 Jan to 28 Feb 2027 only. The page
    says both.
17. **Gift a Reset (€39):** this is the €39 Reset at the studio it is bought for, redeemable within
    12 months. If the recipient has had a trial before, staff swap it for €39 of credit.
    **Open legal check (Richard):** the Consumer Protection (Gift Vouchers) Act 2019 sets a 5-year minimum
    on gift vouchers, and a 12-month expiry on a paid gift may conflict with it. Until that is confirmed,
    the builder writes the validity as data (one field), so it can change to 5 years without a deploy.

### My calls (from the builder check; Richard can overrule)

- **Hatch checkout gets a terms tick box.** `ensureUn1tAccount` will not create a un1t.online account
  without `terms_accepted_at`/`terms_source`/`terms_version`, so without the tick every new Hatch
  buyer would land on a staff help card. It uses the same terms source and version as /trial. Decision 7
  ("no new field") was about the sale-source dropdown, not this.
- **Hatch offer buyers get the set-password email** after they settle, so they can sign in to
  un1t.online. Its copy is a new "offer purchase" variant with a default, not the trial's.
- **The un1t.online 30-writes-a-minute budget is accepted.** A buyer who hits it sees "busy, try again
  in a minute" rather than a bare error. No queue is built.
- **Gift-card copy becomes per studio.** The hard-coded "at UN1T Stillorgan" lines take the studio's
  name, and the €100 + €20 and Reset gifts state their own terms (decisions 16 and 17).

## Goals

- Two studio storefronts, each driven by that studio's `sale_offers` rows, with the studio's own name
  in the header, tab title and copy. No "Stillorgan" text on the Hatch page and none of its timetable lines.
- A timed sale whose window is data: opening and closing happen with no deploy or manual switch on
  either day.
- An "upcoming" state: an offer whose `starts_at` is in the future is shown (where the storefront
  chooses to show it) with an "opens" label and no buy button. The checkout routes refuse it.
- Hatch membership and pack purchases appear in staff's Offer sales list beside the Revolut ones, with
  the product, the buyer and "add bonus: +N weeks / +N classes", so staff know what to add.
- Copy that is honest per category: bonus time for memberships, bonus classes for packs, gift copy for
  gifts. No discount or was-price anywhere.

## Non-goals

- No automatic bonus. Staff add the free time or classes in Glofox and un1t.online by hand.
- No referral tracking, friend codes or leaderboard for "most friends brought".
- No sale-source field at checkout (decision 7).
- No early or member-only access.
- No new payment rail. Hatch uses un1t.online's existing hosted checkout path; gifts use the existing Revolut rail.
- Emails, ads and the staff brief itself are out of scope (separate work).

## Anti-goals (failure even if it "works")

- A buyer is charged a price that differs from the brief, or a Hatch buyer is charged on the Revolut
  rail for a membership or pack (or the reverse).
- The page takes money before 00:00 on 23 Nov or after 23:59 on 30 Nov (Dublin time).
- Any "€100 off" or struck-through price appears.
- A paid Hatch un1t.online purchase never reaches staff, so the buyer never gets their bonus.
- An old `/offers/<slug>` link (August and November emails, gift-card links) breaks.

## Constraints (from CLAUDE.md invariants and the existing code)

- **Data:** `sale_offers.slug` is globally `unique` (mig 503). Both studios need `3-month-membership`
  and similar slugs, so uniqueness moves to `(location_id, slug)`. The product route then has to
  resolve a slug **within a studio**. New migration, forward-only, applied through the Supabase MCP on
  `iyvtbjjxdggiadzwwvdj` before the code deploys. State the grants (`sale_offers` is
  service-role-surface only), and keep any new column in mind for `check:select-columns`.
- **Studio key:** `/offers/<studio>` keys on `locations.slug` (`un1t-stillorgan`, and Hatch's real
  slug, which the builder must look up) through a small map from public key to location slug. Do not
  invent a parallel studio list. The resolver replaces `resolveOffersHomeLocationId`. A missing
  location renders empty or 404, never "every studio" (the W0.4 rule).
- **Public pages:** `/offers/` is already public. Confirm every new path (`/offers/<studio>`,
  `/offers/<studio>/<slug>`, the un1t.online return URL, any new public API route) against all
  **four** allowlists: `src/proxy.js` `publicPaths`, `AppShell` `PUBLIC_PATHS`, `brands.js`
  un1t-marketing `allowedPaths`, and `tenant-domains-edge.js` `DB_BRAND_DEFAULTS.allowedPaths`.
  Allowlist the whole flow, including where un1t.online sends the buyer back.
- **Old links:** `/offers/<slug>` for a Stillorgan slug redirects to `/offers/stillorgan/<slug>`, and
  Revolut's `?purchase=` resume must still work for orders created before the deploy.
  `[slug]` and `[studio]` share one dynamic segment, so the route decides "studio key or legacy slug".
- **Time:** Dublin wall clock. 23 Nov 00:00 Dublin = `2026-11-23T00:00:00Z`; 30 Nov 23:59:59 Dublin =
  `2026-11-30T23:59:59Z` (Ireland is on GMT). The gifts open `2026-11-30T00:00:00Z`. Display through the
  existing zone helpers (`formatSaleDeadline`, `displayZoneFor`). No `'Europe/Dublin'` literal
  (`check:guardrails`).
- **Hatch un1t.online writes** live only in `un1t-online-write*.js`. `createCheckoutLink` is the one
  allowed call. Never `/purchases/charge`, never `/credits/grant` (both are pinned by
  `tests/un1t-online-write-guard.test.js`). Reuse the trial path's shape:
  `ensureUn1tAccount` → `createCheckoutLink` (idempotency key per purchase, a new ledger origin such as
  `web_offer`) → settle off the `un1t_transactions` mirror with the rule "one transaction settles at
  most one row" (`trial-purchase-un1t-settle.js`), matched by **product id** and **amount**.
  Settlement may ride an existing cron as an arm (`un1t-online-sync`, or the 2-minute
  `process-trial-purchases`). If it rides one, it gets its own `cron_heartbeats` row and
  `stampHeartbeat`, applied after the deploy. Note that a Hatch Reset (trial) bought in the same window
  is a different product and must never settle an offer row.
- **Prices:** prices are read only from the server row. For a un1t.online offer, the page must show
  exactly the un1t.online product's mirrored price. If `sale_offers.price_cents` ≠
  `un1t_products.price_cents`, the offer is not sold (buy refused, staff alerted) rather than showing
  one price and charging another.
- **Copy:** customer-facing copy should be operator-editable where practical (invariant). At minimum,
  the per-studio hero, the info-block text and the bonus lines live in data or settings with a default,
  not inline JSX per studio.
- **Silent failures:** `await` every write and destructure `error`. A paid purchase whose bookkeeping
  write fails is logged with `logError` and still reaches staff. It is never dropped.
- **Sale tag:** `OFFER_SALE_TAG` becomes the Black Friday tag (e.g. `offer-sale-bf-2026`) for both
  studios, so the sale emails can suppress buyers.

## Data to load (after the code ships, before 23 Nov)

- Stillorgan: six rows (category `membership` ×4, `class_pack` ×2) with the brief's prices and bonus
  headlines, `starts_at 2026-11-23T00:00Z`, `ends_at 2026-11-30T23:59:59Z`. Two gift rows (€100 with
  "+€20 bonus card, use Jan–Feb", and Gift a Reset €39) with `starts_at 2026-11-30T00:00Z` and the same
  `ends_at`. The four evergreen gift cards stay untouched. The old August and November rows stay inactive.
- Hatch: five membership/pack rows linked to the un1t.online product ids above, plus the 1-month row
  once Richard's product exists, and the two Revolut gift rows. Same windows.
- Descriptions say what the bonus is in plain words (e.g. "12 months of unlimited coached training,
  plus 3 months on the house").

## Left to the builder

- Exact component split for the studio storefront, the studio picker and the upcoming state, and how
  the Cyber Monday gifts section labels itself during the week.
- Whether Hatch un1t.online purchases go in `offer_purchases` (with a provider column and un1t ids) or
  a sibling table. Either works if staff see one Offer sales list and the approvals badge counts both.
- Which cron the settle sweep rides, within the heartbeat rule above.
- The information-block layout, and the countdown target (to opening before 23 Nov, to close after).

## What Richard still has to do

- Create the €99 one-off "1 Month (Black Friday)" product in un1t.online at Hatch.
- Confirm the final words for the info blocks, or accept the brief's wording as written.
