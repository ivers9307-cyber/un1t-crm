# Glofox API: the calls we make, and how we read the answers

A practical reference from a production integration (a gym CRM talking to Glofox
since mid-2026). Every shape below is what we have **seen live**, not only what
the Glofox spec says; where the two disagree, that is called out. Field lists are
the fields we actually rely on, not the full objects.

Captured 12 Nov 2026. This is a **snapshot of observed behaviour**, not the
contract: the judging rules below are implemented in `src/lib/glofox.js`
(`interpretBookingResult`, `fetchMemberResult`, `interpretRegisterResult`,
`interpretPurchaseResult`, `glofoxFetch`'s retry policy), and CLAUDE.md's Glofox
invariants are what binds. If the two ever disagree, the code and CLAUDE.md win
and this file is stale.

---

## 0. Read this first: five rules that apply to every call

1. **A 200 is not a success.** Older Glofox endpoints answer `HTTP 200` with
   `{ "success": false, "message_code": "...", "message": "..." }` for a bad or
   refused request. Glofox's own guidance: treat that as a 400. Every call below
   says how we judge success; never judge on `response.ok` alone.
2. **Send `Content-Type: application/json` on every POST/PUT with a body.**
   Without it `fetch` sends `text/plain`, Glofox never parses the JSON, and you get
   "The first name field is required., The last name field is required., …" for
   fields you did send.
3. **Never blind-retry a write after a 5xx.** A 5xx can come *after* Glofox did
   the work (booking made, trial bought, account created). Retry 429 for anything
   (Glofox refused before processing). Retry 5xx only for reads. For a write,
   either don't retry, or first do a read that proves it did not land.
4. **A failed read is "unknown", never "empty".** If a credits or bookings read
   fails, do not write "0 credits" / "no bookings" over what you already know.
5. **Ids come spelled two ways.** The same object's id is `_id` on most 2.x GET
   responses and `id` on webhooks and v3 responses. Read both.

### Base URL and auth

```
Base URL: https://gf-api.aws.glofox.com/prod
```

Every request carries three headers (per studio/branch):

| Header | Value |
|---|---|
| `x-glofox-branch-id` | the studio's branch id |
| `x-api-key` | integrator API key |
| `x-glofox-api-token` | integrator API token |

Some v3 member-scoped calls also need:

| Header | Value |
|---|---|
| `x-glofox-impersonated-member-id` | the member's Glofox `_id` (24 hex chars) |

The spec says some of those v3 calls take a "Bearer member JWT". For an integrator
that is wrong: headers alone give 403, a Bearer of the API token gives 401, the
impersonation header gives 200.

Some calls (the analytics report, a few v3 endpoints) also need the studio
**namespace** (a short lowercase studio slug, visible as `Payload.namespace` on
webhooks). Leave it out and the analytics report answers `200` with an empty list.

### Retry/backoff we use

- Up to 3 retries. Backoff `500ms × 2^attempt` (cap 8s) + up to 250ms jitter, or
  `Retry-After` seconds if present (cap 30s).
- 429: retried for every method.
- 5xx: retried for GET/HEAD and for "read-POSTs" (search, report, leads filter,
  payment link). Not retried for real writes unless a dedupe read says "absent".
- Payment-link and overdue-invoice calls are bounded with an 8s total timeout
  (they sit on a user-facing path).

### Timestamps

Most 2.x fields are **Unix seconds** (`created`, `time_start`, `expiry_date`).
Some payloads use ISO strings, and some use `"YYYY-MM-DD HH:MM:SS"` with no zone
(read it as UTC). Code defensively: if a number is below `1e12` it is seconds.

---

## 1. Members

### 1.1 List members — `GET /2.0/members`

```
GET /2.0/members?page=1&limit=100
```

- `page` (1-based) + `limit` (max 100). Uses page, **not** skip.
- Optional `phone=` filter (see 1.3).

**Response**
```json
{
  "object": "list", "page": 1, "limit": 100,
  "has_more": true, "total_count": 8129,
  "data": [ { "_id": "…", "first_name": "…", "last_name": "…", "email": "…",
              "phone": "…", "lead_status": "MEMBER", "active": true,
              "membership": { "type": "time", "membership_name": "…" },
              "created": 1717000000, "modified": 1730000000, "origin": "…", "source": "…" } ]
}
```

**How we read it**
- Returns **every** user at the branch regardless of status (leads, trials,
  members, no-sales) in one list.
- Sorted by `modified` **descending**. A daily delta sync can stop paging as soon
  as it sees `modified` older than its cutoff.
- Stop when `has_more` is not `true`.
- The `membership` object here is **thin** (no plan name, no status). Use the
  single-member GET (1.2) for full membership detail.

### 1.2 Get one member — `GET /2.0/members/{memberId}`

**Response (success)**: the member object, sometimes wrapped as `{ "data": { … } }`.
Fields we use:

| Field | Meaning / how we use it |
|---|---|
| `_id` (or `id`, `member_id`) | member id |
| `first_name`, `last_name` (fallback: split `name`) | name |
| `email` | lowercase + trim before matching |
| `phone` (or `mobile`, `phone_number`) | **raw string as the member typed it**, e.g. `0831234567`; normalise to E.164 yourself |
| `lead_status` | `COLD`, `LEAD`, `TOUR`, `NO_SALE_TOUR`, `TRIAL`, `NO_SALE_TRIAL`, `MEMBER` |
| `active` | boolean; `MEMBER` + `active:false` = lapsed/ex-member |
| `origin` | e.g. `classpass` |
| `source` | e.g. `WEBPORTAL`, `WALK_IN`, `DASHBOARD`, `MEMBER_APP`, `CLASSPASS` |
| `birth` | date of birth (often absent) |
| `joined_at`, fallback `created` | tenure anchor (Unix s) |
| `gender` | case variants, `M`/`F`, and a legacy `P` exist: normalise |
| `emergency_contact` | string; the empty placeholder is `"Contact person: , Phone number: "` → treat as null |
| `image_url`, `answers[]` | photo, sign-up question answers |
| `metadata.gympass.id` | present when the person uses Gympass/Wellhub |
| `metadata.classpass` | present for ClassPass users |
| `membership.membership_plan_name` | clean plan label (single-member GET only) |
| `membership.membership_name` | catalog label, often with a sort prefix like `"3) "`; strip `^\d+\)\s*` |
| `membership.status` | membership state |
| `membership.type` | `time`, `time_classes`, `num_classes`, `payg` |
| `membership.expiry_date` | Unix s |
| `membership.plan_price` | catalog price (major units) |
| `membership.subscription.{price, interval, interval_count, payment_method_type_id}` | billing detail (absent for packs) |
| `membership.user_membership_id` | the per-member membership **instance** id (needed for cancel, 4.4). Different from the catalog membership id |
| `membership.roaming_enabled` | boolean |

**Failure you must handle**: `HTTP 200` with
```json
{ "success": false, "message_code": "…", "message": "Resource not available, empty result cant be processed" }
```
for a deleted or merged account, or for a trainer's id. Read naively it looks like
a member with every field missing. **We judge it as refused**: if
`success === false`, or there is no object with an `_id`/`id`/`member_id`, it is
"no data", and we never write nulls over stored data.

**How we derive a status** (in order):
1. `origin = classpass` and `membership.type = payg` → ClassPass pay-as-you-go
   (Glofox labels these `LEAD`, which hides that they are paying).
2. `lead_status = MEMBER`, `active = true`, and **every** active credit pack belongs
   to a non-trial membership whose plans are all `num_classes` → "credit/pack
   member" (needs 2.1 + 2.2).
3. Else normalise `lead_status` (tolerate case, spaces, `"No Sale (Trial)"`).
4. `MEMBER` + `active:false` → ex-member.
5. Nothing recognisable → lead.

### 1.3 Search a member — `POST /v3.0/namespaces/members/retrieve`

```json
POST /v3.0/namespaces/members/retrieve
{ "email": "person@example.com", "phone": "+353831234567" }
```
Send one or both (Glofox ANDs them). Phone must be E.164; exact match against the
member's normalised number; phone searches return `MEMBER`-type rows only.

**Response**: rows under `data` (or `members`, or a bare array). v3 spells the id
`id`, not `_id`.

**How we read it**
- We re-check each row ourselves: email equal case-insensitively, phone equal
  after normalising. One exact row = found. More than one = ambiguous, send to a
  human. Zero = not found.
- An email match is safe to link to. A **phone-only match is not** (couples and
  families share numbers).
- ⚠️ Since mid-September 2026 this endpoint answers **401 for our integrator in
  every shape** while other v3 endpoints work. Fallbacks we use (both verified):
  - email → `GET /2.1/branches/{branchId}/users?filters[email]=<email>` (exact,
    one row)
  - phone → `GET /2.0/members?phone=<spelling>&limit=20`, which matches the **raw
    stored string**, so try spellings in order: national (`0831234567`), `+353…`,
    `353…`, then digits without the trunk 0. Stop at the first hit.
    `filters[phone]` on 2.1 is ignored (returns everyone).

### 1.4 Register a member — `POST /2.0/register`

```json
POST /2.0/register
Content-Type: application/json
{
  "first_name": "Jane", "last_name": "Doe",
  "email": "jane@example.com",
  "type": "MEMBER",
  "lead_status": "LEAD",
  "password": "<generated; see the password policy under Refusals below>",
  "phone": "+353831234567",          // optional
  "birth": "1990-01-31",              // optional
  "emergency_contact": "…",           // optional
  "consent": { … }                     // optional
}
```

**Response (success)**: `{ "success": true, "user": { "_id": "…", … } }`

**How we judge it**: success = 2xx **and** `success !== false` **and** a member id
in `user._id` (or `data`/top level). Anything else is a refusal; keep Glofox's own
words from `error` / `message` / `message_code` / `errors[]`.

Refusals seen live:
- `200 { success:false, message: "LOGIN_ALREADY_IN_USE,EMAIL_ALREADY_IN_USE", message_code: null }`
  → the email already has an account. Search the email again: exactly one account
  → link it; none or several → human review.
- `200 { success:false, message: "The first name field is required., …" }` → you
  forgot `Content-Type`.
- `PASSWORD_RULE_LOWER_CASE` etc. → password policy. Passwords need at least one
  lowercase, one uppercase, one digit, and a special character (a hyphen works).

**After a 5xx**: search the email before re-sending. Found → it landed, use it.
Not found → safe to re-send. Search failed → stop and flag it.

### 1.5 Update a member — `PUT /2.0/members/{memberId}`

Body = only the fields you want to change. Judge on HTTP status plus the
`success:false` rule. Do not retry after 5xx. (We have this wired but rarely use it.)

---

## 2. Credits and memberships

### 2.1 A member's credit packs — `GET /2.0/credits?user_id={memberId}`

**Response**
```json
{ "data": [ { "membership_id": "…", "active": true,
              "num_sessions": 10, "available": 7, "bookings": ["…", "…", "…"] } ] }
```

**How we read it**
- Balance = sum of `available` over packs with `active: true`. If `available` is
  missing, use `num_sessions - bookings.length`.
- No active packs → balance is **unknown/not applicable** (unlimited members,
  fresh leads), not 0. Show "—".
- A failed read (non-2xx, network) → "unknown". Keep the last known balance.

### 2.2 One catalog membership — `GET /2.0/memberships/{membershipId}`

**Response**: `{ "_id", "name", "trial": bool, "plans": [ { "code", "type", "price", "name" } ] }`

Plan `type`:
| type | meaning |
|---|---|
| `time` | unlimited subscription |
| `time_classes` | subscription with a credit allowance |
| `num_classes` | one-off pack (no subscription) |

**How we read it**: a membership is a "class pack" when `trial !== true` and
**every** plan is `num_classes`. A 4xx (other than 429) is an answer ("no such
membership"), safe to cache for the run; a 429/5xx is a failure, don't cache it.
Many members share one membership, so cache by id within a sync run.

### 2.3 The catalog — `GET /2.0/memberships`

Same objects as 2.2, under `data` (or a bare array). We use it to let staff pick
which membership + plan code is the studio's trial product.

### 2.4 Buy a membership (e.g. grant a €0 trial)

```
POST /2.2/branches/{branchId}/users/{memberId}/memberships/{membershipId}/plans/{planCode}/purchase
Content-Type: application/json
{}
```

The spec (v2.3.0) marks `start_date` as required; Glofox accepts `{}` and starts
the membership immediately. We send `{}`.

**Response**
```json
{ "success": true, "message": "…", "message_code": "…",
  "status": "SUCCESS", "invoice_id": "…" }
```
`status` is `SUCCESS`, `PENDING-INTENT` (sometimes `PENDING_INTENT`) or `ERROR`.

**How we judge it**: granted = 2xx **and** `success !== false` **and** `status`
is neither `ERROR` nor `PENDING-INTENT` (pending means payment still needs action:
not usable credit yet). A clean 2xx with neither field has always been a real
grant for us.

- **Never re-send after a 5xx or no reply.** There is no dedupe on purchases; a
  re-send can stack a second trial. Treat it as "outcome unknown" and check the
  member's credits (2.1) before trying again.
- Audit: a purchase that went through shows up within minutes as an
  `INVOICE_UPDATED` webhook (a €0 `MEMBERSHIPS` invoice) for that member.

---

## 3. Classes and bookings

### 3.1 Timetable — `GET /2.0/branches/{branchId}/events`

```
GET /2.0/branches/{branchId}/events?start=<unix s>&end=<unix s>&limit=100
```
(The bare `/2.0/events` still works but is deprecated. `/2.0/calendar` does not
exist on our tier: it answers `WRONG_URL`.)

**Response**
```json
{ "object": "list", "page": 1, "limit": 100, "has_more": false, "total_count": 42,
  "data": [ { "_id": "…", "name": "HIIT", "description": "…",
              "time_start": 1730000000, "duration": 45,
              "size": 16, "booked": 12, "waiting": 0,
              "trainers": ["<trainer id>"], "active": true, "private": false,
              "booking_status": "…", "program_obj": { … } } ] }
```

**How we read it**: spots left = `size - booked`. `trainers` are ids only (the
embedded trainer object arrives empty), see 3.6.

### 3.2 Book a member into a class — `POST /2.0/bookings`

```json
POST /2.0/bookings
Content-Type: application/json
{ "user_id": "<member id>", "model": "event", "model_id": "<event _id>" }
```
The obvious guess `{ user_id, event_id }` fails validation ("The model field is
required., The model id field is required."). `model` must be the lowercase
`event`; `Event` fails the enum.

**Response (success)**
```json
{ "success": true, "Booking": { "_id": "…", … } }
```
Note the PascalCase `Booking` wrapper. The id inside may be `_id` or `id`.

**Response (refused, but still HTTP 200)**
```json
{ "success": false, "message_code": "YOU_HAVE_NO_CREDITS_LEFT", "message": "…" }
```
Other codes seen: `YOU_HAVE_BOOKED_FOR_THIS_EVENT`, `EVENT_HAS_BEEN_CANCELLED`.

**How we judge it**
- Has a failure signal (`message_code`, or `success:false`) → booked **only if**
  a booking id also came back.
- Clean 2xx with no failure signal → booked, id or not. **Do not require an id**
  to call it a success; we mislabelled a real booking that way.
- `YOU_HAVE_BOOKED_FOR_THIS_EVENT` → "already booked": no new booking, but the
  member is in the class. Most flows should treat it as success.
- Glofox enforces capacity, double-booking and waitlist itself.

**After a 5xx**: read the member's bookings (3.4) for the last 7 days. A
not-cancelled booking on this event created since you sent (allow ~2 min clock
skew) → it landed. An older `BOOKED` one → member is booked. An older
non-`BOOKED` one (e.g. a waitlist entry) → **unknown**, don't tell them they have
a place. Nothing → safe to re-send.

### 3.3 Cancel a booking — `POST /booking/{bookingId}/user/{memberId}/cancel`

No body. Studios can set "no cancellation within X hours"; Glofox puts the rule
violation in the body. Judge on HTTP + `success:false`.

After a 5xx: read the member's bookings; the booking reads `CANCELLED`/`CANCELED`
→ it landed; still live → re-send; not found / read failed → stop.

### 3.4 A member's bookings — `GET /2.0/bookings`

```
GET /2.0/bookings?branchId=<branch>&user_id=<member>&limit=100&page=1
                 &sort_by=-created&time_start=<unix s cutoff>&exclude_cancelled=false
```
- `limit` max 100; paginate with `page`.
- `time_start` filters by **class start time**, not booking creation.
- `exclude_cancelled=false` to see cancellations too.
- For full history we page back ten years and stop at the first short page.

**Response**: `{ "data": [ Booking ] }`. Booking fields we use:

| Field | Use |
|---|---|
| `_id` (`id` on webhooks) | booking id |
| `user_id` | member |
| `model`, `model_id` (older: `event_id`) | what was booked |
| `event_name`, `model_name` | label |
| `time_start` | class start (Unix s) |
| `created` | booking made (Unix s) |
| `status` | `BOOKED`, `CANCELED`/`CANCELLED` (both spellings exist), waitlist states |
| `attended` | boolean |
| `duration` | minutes |

**How we read it**
- Attended = `attended === true`. No-show = `status = BOOKED`, not attended, class
  start in the past.
- Last attended = latest `time_start` where attended. Last booked = latest `created`.
- If **any page** fails, treat the whole history as unknown. A partial
  newest-first history that shows no attendance would wrongly read as "never
  attended".

### 3.5 Lead/member notes ("interactions")

```
GET  /2.1/branches/{branchId}/leads/{memberId}/interactions
POST /2.1/branches/{branchId}/leads/{memberId}/interactions
Content-Type: application/json
{ "user_id": "<member id>", "type": "NOTE", "description": "…" }
```
- Read response: array, or `{ data: [...] }`. Each: `_id, branch_id, user_id,
  description, created (Unix s), type` where type is `NOTE`,
  `CALLED_AND_CONNECTED`, `CALLED_AND_NO_ANSWER`, `MANUAL_EMAIL`.
- Create: only `NOTE` or `MANUAL_EMAIL`; description ≤ 500 chars. **The response
  has no body** and no id. Never retry a 5xx (you'd duplicate the note).

### 3.6 Trainers — `GET /2.0/trainers?limit=100`

Unreliable on our tier. Trainers are users, so their ids also resolve on
`GET /2.0/members/{id}`, but often come back as the `success:false` refusal (1.2).
We ended up keeping a staff-editable "trainer id → name" map instead; no API or
webhook surface reliably gives trainer names.

---

## 4. Money

### 4.1 Payments report — `POST /Analytics/report`

```json
POST /Analytics/report
{
  "branch_id": "<branch>", "namespace": "<studio namespace>",
  "start": "1727740800", "end": "1730419200",
  "model": "TransactionsList",
  "filter": {
    "ReportByMembers": false, "CompareToRanges": false,
    "PaymentMethods": [ {"id":"cash"}, {"id":"credit_card"}, {"id":"bank_transfer"},
                        {"id":"paypal"}, {"id":"direct_debit"}, {"id":"complimentary"},
                        {"id":"wallet"} ]
  }
}
```
Note `start`/`end` are Unix seconds **as strings**.

**Response**: `{ "TransactionsList": { "details": [ { "<EnvelopeType>": { … } } ] } }`
Each row is wrapped in one typed envelope, e.g. `{ "StripeCharge": { … } }`.

**Gotchas**
- Leave out `namespace` → 200 with an empty list.
- Leave out `PaymentMethods` (or send `[]`) → 200 with an empty list. It behaves
  as "match any of these", so send the full list.
- Not every envelope carries a real `amount` (a failed subscription charge had
  `amount: 0` against a much larger invoice). Don't sum arrears from this report;
  we use the invoice webhook (5.2) as the source of truth for money.

### 4.2 Invoice payment link — `POST /v3.0/payment-links/invoices/{invoiceId}`

Headers: the three auth headers **plus** `x-glofox-impersonated-member-id`.
Body `{}`. Nothing is charged, so retrying is safe.

**Response**
```json
{ "is_retriable": true, "invoice_payment_link": "https://…",
  "invoice_amount": 9900, "invoice_currency": "EUR",
  "invoice_summary": "…", "invoice_id": "…" }
```
- `success:false` on a 200 → failure (bad invoice id etc.).
- `is_retriable: false` → this invoice can't be paid by link right now (custom fee,
  or Glofox is mid-retry). Ignore the link/amount then.
- `invoice_amount` is in **cents**. Only accept a link starting `https://`.

### 4.3 Overdue invoices — `GET /v3.0/users/{memberId}/overdue-invoices`

Headers: auth + `x-glofox-impersonated-member-id`.

**Response**: `{ "data": [ { "invoice_id": "…", "due_date_utc": "…" } ] }`
Overdue **subscription** invoices, newest first, **capped at 20**.

- The invoice ids match the ids on `INVOICE_UPDATED` webhooks (verified).
- A page of exactly 20 may be truncated: "invoice X is not in the list" proves
  nothing then.
- `success:false` on a 200 is a failure, never "nothing overdue".

### 4.4 Cancel a membership — `POST /v3.0/memberships/{userMembershipId}/cancel`

Headers: auth + `x-glofox-impersonated-member-id` (required, this is a
member-initiated action) + `Content-Type: application/json`.

```json
{ "when": "ON_DATE", "local_date": "2026-12-31", "reason": "MEMBERSHIP_CANCELLATION_PRICE" }
```
- Only `ON_DATE` works (`NOW` and `END_OF_CYCLE` are "not supported yet").
- `{userMembershipId}` is `membership.user_membership_id` from the single-member
  GET (1.2), **not** the catalog membership id.
- A malformed id gets `WRONG_URL` from the router, which looks exactly like "no
  such endpoint". Validate both ids are 24 hex chars before sending.
- `reason`: `MEMBERSHIP_CANCELLATION_PRICE`, `_MOVED`, `_NO_USAGE`,
  `_CUSTOMER_SERVICE`, `_EVENT_SCHEDULE`, `_CHANGE_MEMBERSHIP`, or `""`.
- Response: `local_planned_end_date` (top level or under `data`), plus
  `message_code`/`message`. Don't retry a 5xx.
- Pause exists but rejects impersonation and has no documented body; we don't
  automate it.

---

## 5. Webhooks (Glofox → you)

### 5.1 Receiving and verifying

- Signature header: `signature` (we also accept `x-glofox-signature`,
  `x-signature`), case-insensitive.
- `signature = hex( HMAC-SHA256( webhook_secret, raw_request_body ) )`. Compare in
  constant time against the **raw** body (before JSON parsing).
- Work out the studio from the payload's branch id (`branch_id`, or
  `Metadata.location_id`, `metadata.location_id`), then verify with **that**
  studio's secret.
- **Always answer 2xx for events you don't recognise or can't match.** Providers
  disable hooks that keep returning errors. Do heavy work off the request thread.

### 5.2 Event types

| Group | Events |
|---|---|
| member | `MEMBER_CREATED`, `MEMBER_UPDATED` |
| membership | `MEMBERSHIP_CREATED`, `MEMBERSHIP_UPDATED`, `MEMBERSHIP_DELETED` |
| booking | `BOOKING_CREATED`, `BOOKING_UPDATED`, `BOOKING_DELETED` |
| course booking | `COURSE_BOOKING_CREATED`, `COURSE_BOOKING_DELETED` |
| invoice | `INVOICE_UPDATED` |
| access | `MEMBER_ACCESS_INFO_CREATED`, `MEMBER_ACCESS_INFO_UPDATED` |
| event (timetable) | `EVENT_CREATED`, `EVENT_UPDATED`, `EVENT_DELETED` |
| e-agreement | `EAGREEMENT_CREATED`, `EAGREEMENT_UPDATED` |
| service | `SERVICE_CREATED`, `SERVICE_UPDATED`, `SERVICE_DELETED` |

### 5.3 Payload shapes

Newer events wrap data as `{ "Type": "...", "Metadata": { … }, "Payload": { … } }`;
`SERVICE_*` use lowercase `metadata` / `payload`; older shapes use `data`.
Where we find things:

| What | Paths tried, in order |
|---|---|
| event type | `event_type`, `eventType`, `type`, `Type`, `event` |
| per-delivery id | `Metadata.trace_id` / `metadata.trace_id` |
| entity id | `Payload.id`, `payload.id`, `data.id`, `data._id` |
| member id | `Payload.user_id`, `Payload.user.id`, `data.user_id`, `Payload.id` (on `MEMBER_*`), `payload.member_ids[0]` (services) |
| email | `Payload.user.email` (invoices), `Payload.email` (members), `data.email`, `data.member.email` |
| branch | `branch_id`, `Metadata.location_id`, `Payload.branch_id`, `metadata.location_id` |

**Booking and membership events usually carry no email**, only the member id.
Match the person by Glofox member id, and fetch the member (1.2) if you need more.

**Dedupe carefully.** `Payload.id` is the **entity** id, not the delivery. A
booking's later `BOOKING_UPDATED` (after the class, with attendance) and
`BOOKING_DELETED` reuse the same `Payload.id`. If you dedupe on it you drop most
later events (for us ~57% of deliveries). Use `Metadata.trace_id` per delivery,
and upsert entity state by entity id.

### 5.4 INVOICE_UPDATED (our source of truth for payments)

`Payload` fields we use: `id`, `user.id`, `user.email`, `status` (`PAID`,
`PAST_DUE`, `PENDING`, `FORGIVEN`), `total` (integer **cents**), `currency`,
`line_items[]` (each with a sub-type such as `SUBSCRIPTION_PAYMENT`),
`payment_method`, `document_type`, `created` / `date` / `modified`.

- The same invoice is sent again on each status change: upsert by `id`, then
  recompute totals from scratch, so out-of-order delivery converges.
- One-off purchases get a **new invoice id per payment attempt** (subscriptions
  reuse one). A fail-then-succeed leaves an orphan failed invoice. "Same amount,
  same day" is not proof of a duplicate.
- A `PENDING_INTENT` invoice can stay frozen. Never compute "amount owed" from
  stored invoices alone; confirm with 4.3.

---

## 6. Quick index

| # | Method + path | Read/Write | Judge success on |
|---|---|---|---|
| 1.1 | `GET /2.0/members?page&limit` | R | 2xx + `data[]`; page until `has_more` false |
| 1.2 | `GET /2.0/members/{id}` | R | 2xx **and** not `success:false` **and** has an id |
| 1.3 | `POST /v3.0/namespaces/members/retrieve` | R | 2xx; re-check exact match yourself (currently 401: use fallbacks) |
| 1.3b | `GET /2.1/branches/{b}/users?filters[email]=` | R | 2xx + exact email match |
| 1.4 | `POST /2.0/register` | W | 2xx **and** not `success:false` **and** `user._id` |
| 1.5 | `PUT /2.0/members/{id}` | W | 2xx and not `success:false` |
| 2.1 | `GET /2.0/credits?user_id=` | R | 2xx; failure = unknown, not zero |
| 2.2 | `GET /2.0/memberships/{id}` | R | 2xx; 4xx = "none" (cacheable) |
| 2.3 | `GET /2.0/memberships` | R | 2xx |
| 2.4 | `POST /2.2/branches/{b}/users/{u}/memberships/{m}/plans/{p}/purchase` | W | 2xx, not `success:false`, `status` not `ERROR`/`PENDING-INTENT`; never retry 5xx |
| 3.1 | `GET /2.0/branches/{b}/events?start&end&limit` | R | 2xx |
| 3.2 | `POST /2.0/bookings` | W | see 3.2 (failure code needs an id; clean 2xx is booked) |
| 3.3 | `POST /booking/{bookingId}/user/{userId}/cancel` | W | 2xx and not `success:false` |
| 3.4 | `GET /2.0/bookings?branchId&user_id&…` | R | 2xx; any failed page = unknown |
| 3.5 | `GET`/`POST /2.1/branches/{b}/leads/{u}/interactions` | R/W | 2xx (POST has no body) |
| 3.6 | `GET /2.0/trainers` | R | unreliable |
| 4.1 | `POST /Analytics/report` | R | 2xx; empty list may mean missing namespace/PaymentMethods |
| 4.2 | `POST /v3.0/payment-links/invoices/{id}` | R (POST) | 2xx, not `success:false`, `is_retriable` true |
| 4.3 | `GET /v3.0/users/{id}/overdue-invoices` | R | 2xx, not `success:false`; 20 rows = maybe truncated |
| 4.4 | `POST /v3.0/memberships/{userMembershipId}/cancel` | W | 2xx; `local_planned_end_date` |
| 5 | Webhooks (inbound) | — | verify HMAC; always 2xx |
