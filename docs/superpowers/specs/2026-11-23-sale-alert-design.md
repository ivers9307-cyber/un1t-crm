# SALEALERT: a push and a cha-ching for every new sale

Date: 23 Nov 2026. Status: awaiting Richard's approval.

## Intent

Owners and managers want to hear, on their phone, the moment their studio
sells something: a push notification with a cash-register sound. It is a
morale and awareness signal, not an ops alert. A ring means "someone just
bought something new at your studio".

## Decisions Richard made

- Every new sale at the studio rings, whichever page or system took the money.
- Renewals do not ring (monthly direct debits, recurring payments).
- Only owners and managers hear it (of the studio where the sale happened).
- The sound is a cha-ching.
- A sale rings straight away at any hour, including 22:00 to 07:00.

## Goals

- One push per new sale, to owners and managers of that sale's location.
- Title and body name the item, the amount when known, and the buyer's first
  name, for example "New sale: 20 Class Pack (€250)" / "Jordan · Stillorgan".
- A per-person on/off switch in notification settings, like every other push.
- A custom sound on iPhone, and a dedicated Android channel ready for when
  Android push works.

## Non-goals

- No sales dashboard, totals or daily digest.
- No change to how any payment settles.
- No fix for Android push (still blocked on the FCM setup; see
  `mobile/docs/android-fcm-setup.md`).
- No per-studio choice of which sale types ring.

## Anti-goals

- A sale that rings twice (webhook, status poll and reconcile all observe the
  same payment).
- A renewal, refund or €0 claim that rings.
- A payment path that fails, slows or retries because the alert failed. The
  alert is fire-and-forget (CLAUDE.md: side effects never fail the main
  response).
- A ring reaching staff who are not owner or manager at that location.

## What counts as a sale (builder's call, shown to Richard, uncorrected)

Rings:

| Source | Settle point today | Notes |
|---|---|---|
| `/offers`, Revolut rail | `runOfferPaidSideEffects` (`src/lib/offer-purchase-paid.js`) | runs once on the paid transition |
| `/offers`, un1t.online rail | `sweepUn1tOfferPurchases` (`src/lib/un1t-offer-purchases.js`, the two `notifyStaffOfPaidPurchase` sites) | |
| €39 trial, Revolut | callers of `markTrialPurchasePaymentStatus` when `released` is true | three callers: webhook, public poll, reconcile |
| €39 trial, un1t.online | `settleUn1tTrialPurchases` (`src/lib/trial-purchase-un1t-settle.js`) and `sweepPaidTrialPurchases` | |
| Paid class booking | callers of `markClassBookingPaymentStatus` when `released` is true | Revolut and Stripe callers; amount must be above €0 |
| Hatch staff payment link | `settleLink` in `src/lib/staff-payment-link-sweep.js` | |
| Event and race entries | `runRacePaymentCompletedEffects` (`src/lib/race-payment-completed.js`) | location from `race_events.location_id` |
| Glofox new membership or pack (Stillorgan) | `INVOICE_UPDATED` in `src/app/api/webhooks/glofox/route.js` | see Glofox below |
| un1t.online in-app purchase (Hatch) | `runUn1tSync` (`src/lib/un1t-online-sync.js`) | see un1t.online below |

Does not ring: renewals, refunds, €0 claims (`/newstart`, Open Week, corp
promos), donations and raffle tickets (charity money, not studio sales),
CCF Autos car deposits (not a studio).

Also does not ring (builder's calls after review, for Richard to check):

- **Fees and recovered arrears.** Late-cancel and no-show fees
  (`chargeClassFee` at Hatch; fee invoices at Stillorgan), staff custom
  charges, `PRORATE` and `NON_SUFFICIENT_FUNDS` recoveries. None is someone
  buying something new. So both filters are allow-lists, not deny-lists:
  Glofox rings only for a first membership payment (`SUBSCRIPTION_PAYMENT`)
  and pack, credit or product purchases; un1t.online rings only for product
  purchases and first subscription payments, and class-fee charges are
  skipped (mark or recognise them by the charge function's own reference).
- **Entries paid to a host.** A race or event payment that settles to a
  host's own Stripe connected account (`src/lib/race-payments.js:170-223`)
  is the host's money, like charity money. Only entries whose money settles
  to the studio ring. A `move_gap` price-difference payment never rings. An
  event with no `location_id` never rings.
- **Other roles.** The send is hard-limited to owner and manager whatever
  the permission key says, and `notify_sale` is not offered for head_coach
  or staff in the permissions editor.

## Constraints found in the code

- `sendPush` hard-codes the sound: `src/lib/push.js:417` sends `'default'`
  or null, so a custom name is dropped today.
- The app has no bundled sounds. `mobile/app.config.js` configures
  `expo-notifications` with `icon` and `color` only. A bundled sound is a
  native-build input: it needs a store build and a `runtimeVersion` decision
  (`mobile/app.config.js:440-457`, `mobile/docs/store-release-one-app.md` §8).
- Android channels are immutable; a custom sound needs a new channel id
  (`shared/push-channels.js` header).
- An unregistered push category fails closed. Registering one means a
  `NOTIFICATION_REGISTRY` entry, a `notify_<category>` key in
  `MOBILE_PERMISSIONS` and `DEFAULT_MOBILE_PERMISSIONS_BY_ROLE`
  (`shared/permissions.js`), and a `CATEGORY_CHANNELS` entry
  (`tests/push-category-literals.test.js` enforces it).
- Offers already call `notifyStaffOfPaidPurchase` → `sendOpsAlert`
  (`src/lib/ops-alerts.js`), which emails when `ops_alert_emails` is set and
  pushes (uncategorised) only when it is empty.
- The Glofox webhook is not a dedup boundary; a retried delivery is processed
  again. `applyInvoiceWebhook` overwrites, so "just became paid" is not
  recorded.
- `glofox_invoices` is stale for amounts owed (CLAUDE.md). The amount on the
  webhook delivery itself is the only figure to show, and only as a label.
- Staff quiet hours (`src/lib/staff-push-hours.js`) are opt-in per sender.
  Its header calls the rule absolute.

## Approaches

1. **One shared alert function called at each settle point (chosen).** Dedup
   by sale key makes it safe to call from every observer. Instant for CRM
   and Glofox sales; Hatch in-app sales within the 15-minute sync. Touches
   about ten call sites, each a one-line fire-and-forget call.
2. **A cron sweep over the sales tables.** One place, no payment-path edits,
   but every ring is late and each run adds a query per table. Rejected:
   lateness defeats the point of a cha-ching.
3. **Widen `sendOpsAlert`.** Smallest diff, but it has no category, no
   per-person switch, no role scoping and no sound. Rejected.

Richard left the how to the builder; approach 1 is the builder's pick.

## Design

### The alert function

A new module, `src/lib/sale-alert.js`, exporting one function, roughly:

```
notifyNewSale(db, { source, saleId, locationId, itemName, amountCents, currency, buyerFirstName })
```

- Sends through `sendPushToRolesAtLocationOnce` (`src/lib/push-dedup.js`,
  `{ locationScoped: true }`) to roles `owner` and `manager`, with dedup key
  `sale:<source>:<saleId>`. That claim in `push_event_sends` is what makes
  the three-observer case ring once, and it is released on outright failure
  so a later observer can finish.
- Category `sale`, `data.type` `sale_new`. Never throws; logs and returns.
- Skips when `amountCents` is known and not above zero.
- Does **not** consult `inStaffPushHours`. This is a deliberate, owner-chosen
  exception; record it in the header of `staff-push-hours.js` and in
  `docs/rules/conventions.md` so the "absolute" wording stays true.
- Masters are included by the existing role helper; leave that as is.

### Registration

- `NOTIFICATION_REGISTRY`: category `sale`, label "New sales", recipients
  owners and managers, not role-configurable, no lead times, no fallback
  email, default on.
- `notify_sale` in `MOBILE_PERMISSIONS`; default true for owner and manager,
  false for head_coach and staff.
- `shared/push-channels.js`: a new Android channel `sales` (importance
  `high`, with a `sound` field) and `sale: 'sales'` in `CATEGORY_CHANNELS`.
  `shared/` is mirrored to champ-app: follow `docs/rules/champ-app-sync.md`.
- `mobile/lib/notification-nav.js`: a `sale_new` case. Tap-through goes to
  the buyer's contact when `contact_id` is present, else the app home.

### The sound

- `sendPush` accepts an optional custom sound name and passes it through
  for this category only; every other push keeps `'default'`.
- Bundle `cha-ching.wav` under `mobile/assets/sounds/` and list it in the
  `expo-notifications` plugin `sounds` array. `push-register.js` passes the
  channel's `sound` when creating the `sales` channel.
- iOS plays the default sound when the named file is missing, so the server
  can send the custom name from day one: phones on the old build chime,
  phones on the new build cha-ching. The builder must confirm this on a
  device before relying on it; if it is silent instead, gate the sound name
  on the device's reported app version.
- The sound file must be one we may ship (royalty-free or made for us).
  Richard picks or approves the file.

### Glofox (Stillorgan)

- Ring on an `INVOICE_UPDATED` delivery whose invoice is PAID, whose amount
  is above zero, and whose line-item sub-types do not include
  `SUBSCRIPTION_RENEWAL` (`src/lib/glofox-arrears.js` names the sub-types).
- Dedup key `sale:glofox:<invoice_id>`. Glofox mints a new `invoice_id` per
  payment attempt, and only a PAID one rings, so a retry after a failed
  attempt rings once, on success.
- The existing early return for a member with no matching contact
  (`route.js` ~line 360) sits before this point. A sale by an unmatched
  member should still ring; the builder moves the alert ahead of that return
  or documents why not.
- Item name comes from the delivery's line items (parse from the payload;
  nothing parses a name today). If absent, say "Glofox purchase".
- Never ring on `MEMBERSHIP_CREATED` as well; one signal only.
- **No second ring for a sale the CRM took.** After a Revolut €39 trial the
  CRM buys the Glofox plan with `payment_method: 'complimentary'`
  (`src/lib/trial-purchase-processor.js:192-200`), and Glofox raises a
  receipt. Skip any Glofox invoice whose payment method is complimentary,
  and skip one whose `invoice_id` matches a stored grant on a CRM purchase.
  What amount a complimentary receipt carries is not known from the code:
  the builder checks a real stored delivery in `glofox_webhook_attempts`
  before finalising the filter. A pack that staff add by hand in Glofox
  after an `/offers` sale is added as complimentary, so it is covered by the
  same skip; if staff charge it in Glofox instead, it rings twice, and that
  is accepted.

### un1t.online (Hatch)

- In `runUn1tSync`, ring for each newly mirrored `un1t_transactions` row
  that is not `type === 'sub_renewal'`, not refunded and above €0, the same
  filter `un1t-offer-purchases.js:152` uses.
- "Newly mirrored" must not replay history: only rows whose
  `remote_created_at` is within the last 24 hours ring. The dedup key
  `sale:un1t:<transaction id>` covers repeats inside that window.
- No burst on first deploy: a code constant holds a cutover instant (set to
  the release time in the PR), and rows created before it never ring. This
  keeps the "no migration" rollout.
- The same transaction may also settle a CRM row (an `/offers` purchase, a
  €39 trial, a payment link). Those CRM paths ring with their own key, so
  the sync must skip transactions already claimed by one of them. The
  simplest rule: every un1t.online-rail CRM path uses the key
  `sale:un1t:<transaction id>` too, so whichever sees it first rings.

### The existing offers alert

`notifyStaffOfPaidPurchase` keeps its email. Its push (the branch taken when
no ops emails are set) is removed for paid offers, so nobody gets two pushes
for one sale.

## Rollout

1. Server and OTA: the function, registration, all call sites. Rings with
   the normal chime. No migration is expected (`push_event_sends` exists).
2. App build: the bundled sound, the plugin `sounds` entry, the `sales`
   channel sound. Follow the store release doc; un-ramped staged rollouts
   block the next OTA.

Both can go in one PR if the builder prefers; the server half is useful on
its own.

## Testing

- Unit: `sale-alert.js` (dedup key, zero amount, never throws, roles).
- Each call site: rings on the paid transition, not on a repeat observation.
- Glofox: renewal sub-type does not ring; paid non-renewal rings once across
  a retried delivery.
- un1t.online: renewal, refund, €0 and older-than-24h rows do not ring.
- `tests/push-category-literals.test.js`, `push-channels.test.js`,
  `check:mobile-parity`, `check:ota-paths`.
- On a real iPhone: chime on the old build, cha-ching on the new one, with
  the phone locked.

## Left to the builder

- Exact copy of title and body, and the tap-through screen.
- Whether one PR or two.
- Field names for the Glofox line-item name.
- How each call site reaches `db` and the buyer's first name.

## Amendments made while planning (23 Nov 2026)

These replace the matching lines above.

- **Android channel timing.** The dedicated `sales` channel is created only
  in the app-build step. Until then `sale` rides the existing `reminders`
  channel. A channel created before the sound file is bundled would be
  stuck without the sound for ever.
- **`runtimeVersion` bumps with the app build**, so the JS that creates the
  `sales` channel never runs on a build without the sound file.
- **The server sends the custom sound name only from the app-build step**,
  not from day one, and only after the old-build fallback is checked on a
  real iPhone.
- **Two PRs**, server first, app build second.
