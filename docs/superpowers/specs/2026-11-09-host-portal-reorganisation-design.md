# Host portal reorganisation — design

**Date:** 2026-11-09. **Asked by:** Richard ("is there another way that this page could be designed more cohesively with the additional features and be generally organised better?"). **Scope:** the signed-in host portal at `/host` (everything under `src/app/host/(portal)/`). It regroups what exists into six places and gives each event a tabbed page. It adds four small additions that write nothing new. It changes no API behaviour and needs no migration.

Decisions marked **(my call)** are mine, made because the conversation left them open; Richard can override any of them. Everything else is what he chose, or what the codebase already fixes.

Related: `docs/superpowers/specs/2026-11-08-host-event-features-design.md` (the six host features, all shipped as #2321 to #2327 with hotfix #2330), `docs/events.md`.

The mockup Richard approved ("looks good", 9 Nov 2026) is a local file, `.superpowers/brainstorm/18260-1794216179/content/structure-v3.html` in the primary checkout. It is not committed, so this document describes every screen in words and does not depend on it.

---

## 0. What exists today (the ground)

Read from `origin/main` at `ae91a429b` (#2330).

**Shell.** `src/app/host/(portal)/layout.js` gates on `getCurrentHost()`, renders the brand short name, `HostNav` (Dashboard · Contacts · Emails), a `+ Create event` link to `/host/events/new`, the host's name, `HostSignOut` and the impersonation banner. Dark theme (`bg-black text-white`), main column `max-w-4xl`. `HostNav` exports `isNavActive(pathname, { href, exact })`, which `HostNav.test.jsx` pins.

**Dashboard** (`src/app/host/(portal)/page.js`), one scroll, in this order:
1. Welcome line.
2. Stripe warning when `payment_provider === 'stripe_connect'` and `!charges_enabled`.
3. "Grow your list": `HostSignupPageCard` (public page link with Copy link, Open, QR code, Customise; the join-form link with Open, QR code). Customise opens `HostListPageEditor` in place.
4. "Revenue" tiles from `getHostRevenue`. A Stripe host sees Gross collected, booking fees, Net to you, Refunded. Any other host sees Gross collected and Refunded only, because the fee and net columns are NULL for them and would read as €0.
5. `HostPayouts` (Available, On the way, the payout list). Self-fetches; renders nothing for a non-Stripe host.
6. `HostStatements` (monthly CSV links). Self-fetches; renders nothing until a month has activity.
7. `HostSeriesList` (each series with Page copy and View page).
8. "Your events": up to 200 events, newest date first, each row with a status chip and up to four links (Submit, Edit, Attendees, View). **Edit is hidden when the event is published.**

**Event page** (`src/app/host/(portal)/events/[id]/page.js`), one stack: header (name, date, counts; Export CSV, `DuplicateEventButton`, `HostEventActions` = Take off sale and Delete), `EventSignupsCard`, `HostSeriesActions`, `HostAttendeeTable`, `EventWaitlistPanel`, `HostPromoCodes`, `HostEventRatings`.

**Edit page** (`events/[id]/edit/page.js`): a separate page that shows the reviewer's note (`race_events.rejected_reason`) on a rejected event, then `HostEventForm`. The form's sections are Basics, Schedule (date, duration, series, sessions), Tickets & teams (standard price, team sizes, pricing tiers), Questions at signup, Presentation, and a collapsed "Email copy" (confirmation, reminder, rating request).

**Three facts that shape this design.**
- A published event **can** be edited: `computeEditTransition` (`src/lib/host-events.js`) keeps it published for cosmetic edits and sends it back to `pending_review` when the standard price, the date, a pricing tier or an **existing** session's start time changes. But no link in the portal reaches the edit page for a published event. Only a typed URL does. **A re-review takes the event off sale**: the public event API filters on `status = 'published'`, and registration and the calendar file refuse anything `eventIsPublic` rejects, so the public page 404s and bookings stop until staff approve it again. Nothing in the form says so today.
- Status labels are `HOST_EVENT_STATUS_LABEL`: Draft, In review, Published, Needs changes.
- Calendar links are not a host control. Attendees get them automatically (emails, confirmed page, event page). The host only sets `duration_minutes`.

**Why change it.** The dashboard puts events, the thing a host comes for, at the bottom under three money sections. Events and series have no home in the nav. The event page is seven stacked sections with setup on a separate page. Money is three widgets. The public page editor is a drawer inside a card.

---

## 1. Intent

A host should find any of their four jobs in one click from the nav, and everything about one event in one place. Richard confirmed all four jobs matter: check bookings, set up events, check earnings, grow the list.

## 2. Goals

- Six nav places: **Overview · Events · Contacts · Emails · Earnings · Your page**.
- Overview is short: what needs the host, the next event, the last 30 days, what is coming.
- Events has its own page, grouped by where each event is in its life.
- One event page with five tabs: **Overview · Attendees · Set up · Promote · Insights**. The edit form becomes the Set up tab, reachable for every status.
- Earnings is one page for revenue, payouts and statements.
- Your page is one page for the public page's content and links.
- Four small additions that only read stored data: the 30-day roll-up, session fill bars, the "price right now" line, and a warning with a confirm step on Set up for the edits that take a published event off sale.

## 3. Non-goals

- Contacts and Emails pages: unchanged.
- Login, set-password, `/host-connect`, the public pages (`/h/<slug>`, `/event/*`): unchanged.
- The create page `/host/events/new`: unchanged, except where it lands after create (§ 6.3).
- API routes under `/api/host/`: no behaviour change. No migration.
- The staff side of events.
- Release 2 items (§ 9). They are listed so the layout leaves room, and are not built here.

## 4. Anti-goals

These would make it a failure even if every screen matched:

- A host loses something they can do today. § 8 is the checklist.
- A host takes a live event off sale without having been told, in words, that this is what the save does.
- Unsaved Set up edits vanish without warning when the host clicks another tab.
- A figure shows 0 when its read failed. Today's components say "unavailable"; keep that.
- A non-Stripe host sees a €0 net, fee, balance or payout.
- An event id that belongs to another host answers anything but 404.
- A page that renders in tests and crashes in production because a Server Component passed a function to a Client Component (#2330). `tests/server-to-client-function-props.test.js` guards it; new pages must stay inside what it scans.

## 5. Constraints

- Every page is server-rendered and scoped: `getCurrentHost()`, then `host_id === session.host.id`, `notFound()` otherwise. **A layout is not a gate.** Layouts do not re-run on client navigation between sibling routes, so every tab page repeats the check itself. A shared loader in `src/lib/` is the way to avoid copying it (builder's call on its shape).
- `check:location-scoping` scans server pages that call `createServerClient()`. New pages must pass it the way the current host pages do.
- Dark surface: the host portal is exempt from the light-theme chip rules. Reuse the existing `STATUS_CHIP` recipe.
- `/host` is already in all four public-path allowlists by prefix, so new routes under it need no allowlist edit. Confirm rather than assume.
- Selects name their columns. Any 30-day read that can exceed 1,000 rows is a count (`head: true`) or is paged.
- "Today" and "last 30 days" are on the host's anchor studio clock: `getLocationZone` on `event_hosts.anchor_location_id`, then `todayIsoIn(zone)`. The dashboard page does this lookup today and passes `today` into `listHostSeries`; the shared loader has to own it now.
- Hosts use this on phones. Every screen must hold at 375px wide.

---

## 6. The design

### 6.0 Two words used throughout

- **Sold** means paid bookings, `paidCount` from `getHostRevenue`, exactly as the dashboard rows show today **(my call)**. A team of four is 1 sold. An event with no payments (a free event) shows no sold figure rather than "0 sold".
- **Booked**, on a session bar or against capacity, is the count the booking gate uses: confirmed entries plus unpaid entries still holding a place (`src/app/api/public/events/[slug]/register/route.js`, `src/lib/registration-move.js`) **(my call)**. That way "full" on the host's screen means a new booking would be refused. The public widget's `is_full` counts confirmed entries only and can differ for up to 48 hours; the host's screen follows the gate. The session bars and the Next up tile use the same count so they cannot disagree.

### 6.1 Routes

| Route | What | Today |
|---|---|---|
| `/host` | Overview | the dashboard |
| `/host/events` | Events list | new |
| `/host/events/new` | Create | unchanged |
| `/host/events/[id]` | Event · Overview tab | the event page |
| `/host/events/[id]/attendees` | Event · Attendees tab | new |
| `/host/events/[id]/setup` | Event · Set up tab | `/edit` |
| `/host/events/[id]/promote` | Event · Promote tab | new |
| `/host/events/[id]/insights` | Event · Insights tab | new |
| `/host/events/[id]/edit` | redirects to `/setup` | the edit page |
| `/host/earnings` | Earnings | new |
| `/host/page` | Your page | new |
| `/host/contacts`, `/host/emails`, `/host/emails/[id]` | unchanged | |

Tabs are route segments, not a `?tab=` parameter **(my call)**: each tab is a small server page that loads only what it shows, and every tab has a link a host can share or bookmark. `/edit` stays as a redirect because `DuplicateEventButton` is given `editHref="/host/events/{id}/edit"` and old links exist; the button's `editHref` moves to `/setup`.

### 6.2 Nav

`HostNav` links, in order: Overview (`/host`, exact), Events (`/host/events`), Contacts, Emails, Earnings (`/host/earnings`), Your page (`/host/page`). `+ Create event` stays as the header button. At narrow widths the six links become one horizontally scrolling strip under the brand row **(my call)**, not a menu button: a host should see all six.

### 6.3 Overview (`/host`)

Top to bottom:

1. **Welcome line** and today's date.
2. **Needs your attention.** Only renders when there is something:
   - the Stripe warning, as today;
   - one line per event with status `rejected`: the event name, the reviewer's note (`rejected_reason`) in full, and a link to that event's Set up tab. Today the note only shows on the edit page.
3. **Next up.** One card for the nearest event dated today or later with status `published`. Name, chip, date, session times, venue. Two buttons: Attendees, Event page (the public page, new tab). Four tiles:
   - Booked: booked people (§ 6.0) over total capacity across sessions, with a line naming any full session;
   - Waitlist: the waiting count;
   - Page views, with the conversion beneath;
   - Net so far (Stripe) or Gross so far (other), with the sold count.
   If there is no upcoming published event, the card is replaced by one line with a link to create one.
4. **Last 30 days** (new roll-up). Four tiles: Bookings (confirmed registrations created in the window, across the host's events), Net earned or Gross collected (payments in the window), Event page views (rows in `event_page_views` for the host's events in the window), List signups (`host_contacts` with `source = 'mailing_list'` created in the window, with the total contact count beneath).
5. **Coming up.** The next three events dated today or later, any status, each a row with chip, date, sold count, and one link that opens the event. Then "All events →".

Everything else leaves this page: revenue tiles, payouts, statements, the signup card, the series list, the full event list.

A failed read on any block renders that block's "unavailable" line and the rest of the page still renders, as the dashboard does today.

### 6.4 Events (`/host/events`)

Heading with the event and series counts. Four groups, each a list; a group with nothing in it is not rendered.

- **Needs action**: status `draft` or `rejected`, dated today or later. A draft row carries the existing `HostSubmitButton`. A needs-changes row does not; the host opens it and reads the note first.
- **Upcoming**: status `published` or `pending_review`, dated today or later, soonest first. Row detail: date, sold count, net or gross.
- **Series**: `HostSeriesList` as it is today, with Page copy and View page.
- **Past**: everything dated before today, newest first, whatever its status. Row detail: date, sold count, and the public rating average and count when the event has any public rating. Shows the newest 20 with a "Show all" control **(my call)**.

Every row opens the event: a draft or needs-changes event opens on **Set up**, every other event on its **Overview** tab. The four per-row links of today (Submit, Edit, Attendees, View) are gone apart from Submit on a draft. An empty portal keeps today's "create your first one" line.

### 6.5 The event page

**Shared header**, on every tab: a "← Events" link; the event name with its status chip; one line with date, session times, venue, and "part of series X" linking to the series page when it has one; three actions:

- **View event page**: the public page in a new tab.
- **Duplicate**: `DuplicateEventButton`, unchanged apart from where it lands.
- **⋯**: a menu holding Take off sale and Delete, which are `HostEventActions`' two actions with their current rules and confirmations. They leave the header row so they are not one mis-tap from Export.

Then the tab strip. The Attendees tab shows the attendee count. The strip scrolls horizontally on a phone.

**Tab 1 · Overview** (read-only):
- Four tiles: Bookings (with confirmed and attendee counts beneath, the three numbers the header line shows today), Waitlist (waiting, with offered beneath), Page views (with conversion), Net to you with gross beneath (Stripe) or Gross (other).
- **Sessions** (new): one bar per session, "10:00 · Morning", filled to booked over capacity, labelled "30 / 30 · full" or "8 / 30". Booked is the gate count of § 6.0. Reuse the existing counting code; do not write a second definition.
- **Price right now** (new): one line, for example "Early bird €25 · 6 of 20 left · then standard €35 · 3 or more people €28 each", with a link to Set up. An event with no tiers shows the standard price; a €0 event shows "Free". It is built on `src/lib/pricing-tiers.js` but needs its own small formatter: `publicPricing` must be given `loadSoldByTier`'s result (without it a sold-out tier still reads as current), the "N of M left" count comes from that result and the tier's capacity (`publicPricing` only exposes `limited: true`, because the public page must not show the count; the host may see it), `tierPriceLabel` names the next tier and never "then standard", and it prints "€0.00 per person" for a €0 event. One extra read, display only.

**Tab 2 · Attendees**: the counts line, Export CSV, `HostAttendeeTable` (with Move and the signup answers, unchanged), then `EventWaitlistPanel` (with Offer now, unchanged). The existing `page.waitlist.test.js` moves with the panel.

**Tab 3 · Set up**: today's edit page.
- The reviewer's note on a rejected event, at the top, as today.
- **Warn and confirm** (Richard's decision, 9 Nov 2026). This tab makes a live event's settings one tap away, and four of them take it off sale (§ 0), so:
  - On a published event, a standing notice at the top says: changing the date, the standard price, a pricing tier or an existing session's start time takes the event **off sale** until {brand} approves it again (the public page goes offline and new bookings stop; existing bookings are kept). Text, images, questions, emails, and adding or removing a session save straight away.
  - A save that **would** trigger it asks first. The dialog names which of the four changed, repeats the consequence, and offers "Save and send for review" or "Keep editing". Nothing is sent until the host confirms. A save that would not trigger it goes straight through, with no dialog.
  - The browser's prediction and the server's decision must be the same rule: `computeEditTransition` (or a pure function it is built from), run against the values the form loaded. The server stays the authority. If it answers `reReview: true` when the browser predicted none (the event changed underneath the host), the save stands and the after-save line below explains it.
  - Tests pin all three together: the notice's list, the dialog's trigger and `computeEditTransition`. A fifth trigger added to the function without the other two fails.
  - A draft, in-review or needs-changes event shows neither the notice nor the dialog: it is not on sale.
- `HostEventForm`, same fields and order, with a jump bar above it: Basics · Schedule & sessions · Tickets & pricing · Questions at signup · Page look · Emails. The jump bar scrolls to sections of one form with one Save **(my call)**. Splitting the form into six separately saved forms would change the save contract (one `PUT /api/host/events/[id]` with the whole event) and is not wanted. "Emails" is today's collapsed "Email copy"; jumping to it opens it.
- `HostSubmitButton` beside Save, on a draft or rejected event only.
- **Unsaved changes**: when the form has unsaved edits, clicking another tab, the back link or a nav link asks before leaving, and a browser close or reload triggers the browser's own prompt.
- After a save that sends a published event back for review, the host stays on Set up, the chip changes to In review and a line says it is off sale until it is approved. The PUT already returns `reReview` and the new status, so this needs no API change.
- Create (`/host/events/new`) lands on the new event's Set up tab.

**Tab 4 · Promote**:
- **Share**: the public event URL with a Copy link button. (An event QR and source-tagged links are Release 2.)
- **Promo codes**: `HostPromoCodes`, unchanged.
- **Series**: `HostSeriesActions`, unchanged: "Part of series X" with a link, or "Make this a series".

**Tab 5 · Insights**: `EventSignupsCard` (views, visitors, booked, conversion, where they came from, the waitlist line) then `HostEventRatings` (average, list, Hide and Show). Both unchanged, side by side on a wide screen and stacked on a phone.

### 6.6 Earnings (`/host/earnings`)

- Heading, then the line the dashboard shows today: paid bookings and the amount collected after refunds, with the Stripe dashboard link for a connected Stripe host.
- **Balance**: `HostPayouts`' Available and On the way.
- **All time**: the revenue tiles, with exactly today's Stripe and non-Stripe split.
- **By event**: one row per event from `getHostRevenue().perEvent`: date, name, sold count, net or gross. Each row links to that event.
- **Payouts**: `HostPayouts`' list.
- **Statements**: `HostStatements`.

A non-Stripe host sees All time (two tiles), By event (gross) and Statements. No Balance and no Payouts. `HostPayouts` and `HostStatements` already render nothing when they have nothing; the page must not leave an empty heading behind when they do.

### 6.7 Your page (`/host/page`)

- Heading with Open, Copy link and QR code for the public page; beneath it the URL and the list-signup count.
- **The editor**, laid out as sections in the order a visitor meets them, replacing the Customise drawer. The fields are exactly `HostListPageEditor`'s, regrouped:
  1. Top of page: headline, intro text, hero image URL, accent colour.
  2. About you (up to 2,000 characters).
  3. Upcoming events: events headline, events intro.
  4. Photos (up to 12, with captions).
  5. What people say: testimonials (up to 6) and the Show ratings switch.
  6. Past events: the Show past events switch.
  7. Join the list: button label, success message.
  One Save for the whole page, as today.
- **Signup form only**: the `/join` link with Copy link, Open and QR code, and the line that says it is for bios and stories.

Series page copy stays on the Events page with the series it belongs to. The live preview beside the editor is Release 2; the page is a single column until then.

---

## 7. The four additions, and where their numbers come from

| Addition | Where | Source |
|---|---|---|
| 30-day roll-up | Overview | `race_registrations` (confirmed, by created time), `race_payments` (the rows `getHostRevenue` already reads, with a window added as an option, not a second reader), `event_page_views` (count), `host_contacts` (count) |
| Session fill bars | event Overview, and "Next up" | `race_waves` capacity and the existing per-session booked count |
| Price right now | event Overview | `src/lib/pricing-tiers.js` (`publicPricing` fed by `loadSoldByTier`) plus a host-side formatter |
| Re-review notice and confirm | Set up | copy plus `computeEditTransition` run in the browser, pinned together by a test |

None of them writes anything new. If the builder finds that one needs a migration or a new write, stop and say so; that would mean this document is wrong about it.

---

## 8. Nothing lost: where each thing goes

| Today | After |
|---|---|
| Stripe warning | Overview, Needs your attention |
| Signup page card (links, QR) | Your page heading and Signup form only |
| Customise drawer | Your page editor |
| Revenue tiles, Stripe dashboard link | Earnings |
| Payouts | Earnings |
| Statements | Earnings |
| Series list, Page copy | Events, Series group |
| Event list rows | Events; three on Overview |
| Row: Submit | Events row (draft) and Set up |
| Row: Edit | open the event, Set up tab (now for published too) |
| Row: Attendees | open the event, Attendees tab |
| Row: View | event header, View event page |
| Event header counts | event Overview tile and Attendees counts line |
| Export CSV | Attendees |
| Duplicate | event header |
| Take off sale, Delete | event header ⋯ menu |
| Signups card | Insights; headline figures on event Overview |
| Series actions | Promote |
| Attendee table, Move | Attendees |
| Waitlist, Offer now | Attendees |
| Promo codes | Promote |
| Ratings, Hide/Show | Insights |
| Edit page, reviewer's note | Set up |

---

## 9. Release 2 (not built here)

Richard chose to split these off (9 Nov 2026). Each is a small feature of its own:

1. A QR code for an event's public page (Promote).
2. Source-tagged share links, so Insights can tell Instagram from WhatsApp without a hand-written `utm_source` (Promote).
3. "Email your list about this event": a shortcut from Promote into Emails with the event pre-filled.
4. A live preview beside the Your page editor.

One more appeared in the mockup and is not in Richard's list of eight: a "3 new ratings on …" line under Needs your attention. It needs a per-host "seen" marker, which is a write, so it belongs with Release 2 **(my call)**.

---

## 10. Left to the builder

- How many PRs. One sensible cut: (a) nav, Events, Earnings, Your page and the slimmed Overview; (b) the event tabs with the Set up fold and the `/edit` redirect; (c) the four additions. Each must leave the portal whole: no PR may remove something from one place before it exists in the other.
- The shape of the shared event loader and header.
- Whether the ⋯ menu is a new small component or a restyle of `HostEventActions`.
- How the unsaved-changes prompt is built.
- Component and file names.
- Tests: the route checks (another host's event is 404 on every tab), `isNavActive` for the new links, the redirect, the Stripe and non-Stripe Earnings shapes, the notice-versus-`computeEditTransition` pin, and the degraded states.

## 11. Known issue outside this work

The edit page does not pass `rating_email_subject` / `rating_email_intro` into the form, so a later save blanks saved rating copy. It is being fixed separately (RATINGCOPY.1, PR #2331, open on 9 Nov 2026). If that has merged, Set up inherits the fix; if not, the builder must carry both fields across when moving the page.
