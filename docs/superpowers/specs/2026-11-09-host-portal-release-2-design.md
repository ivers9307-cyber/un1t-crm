# Host portal release 2 — design

**Date:** 2026-11-09. **Asked by:** Richard ("proceed with the next phase", after the reorganisation shipped as #2332 and #2333). **Scope:** the five extras he saw in the approved mockup and held back from the first release (`docs/superpowers/specs/2026-11-09-host-portal-reorganisation-design.md` § 9), plus one guard test the first release's review asked for. One PR. No migration.

He approved these as mockup items and said to proceed without a round of questions, so every detail below is **my call** unless it quotes the earlier spec. He can override any of it.

## 0. Ground (read from main at `3e7b744f1`)

- The event Promote tab (`src/app/host/(portal)/events/[id]/promote/page.js`) has a Share block (public URL + `CopyLinkButton` + Open), promo codes and series.
- Sources on the Insights tab come from `src/lib/event-attribution.js`: a `utm_source` that is a plain token (`/^[a-z0-9][a-z0-9_.-]{0,39}$/`, not `host_email` / `direct` / `unknown`) becomes the source word; `attributionSourceLabel` has labels for instagram, facebook, google, whatsapp, strava, linkedin, tiktok, x, youtube.
- `GET /api/host/signup-qr` makes an 800×800 PNG of the host's public page URL (QRCode, margin 2, ECC M, black on white, origin-only URL from `resolveCustomerBaseUrl`).
- Host emails: `host_campaigns` rows; `POST /api/host/emails/[id]/reminder-draft` is the prior art for a server-made draft; a draft with no `design_json` opens in the composer's Plain text mode with `body_html` as its text; `src/lib/host-campaign-links.js` tags every `<a href>` to `/event/…` on the tenant host with `hc=<campaign id>` at send time, which Insights reports as "Host email". The composer (`src/components/host/HostEmails.jsx`) already reads `?notice=reminder`.
- `/host/page` is a single-column editor (`HostYourPage` + `HostListPageEditor layout="sections"`). `X-Frame-Options: SAMEORIGIN` ships globally, and `/h/<slug>` is served on the portal's own origin, so a same-origin iframe of it is allowed.
- Ratings live in `event_ratings` (`race_event_id`, `rating`, `comment`, `is_public`, `created_at`). The Overview's "Needs your attention" block lists the Stripe warning and needs-changes events.

## 1. Tagged share links and an event QR (Promote tab)

**Intent.** A host posts the same link everywhere and Insights cannot tell Instagram from WhatsApp, because in-app browsers drop the referrer. Give them one-tap links that carry the source, and a QR for posters.

- The Share block keeps the plain URL with Copy link and Open. Under it, a row "Copy a link for": **Instagram · WhatsApp · Facebook · TikTok · X · LinkedIn**. Each button copies the event URL with `utm_source=<token>` (tokens `instagram`, `whatsapp`, `facebook`, `tiktok`, `x`, `linkedin`, the words Insights already labels) and shows "Copied".
- A **QR code** button downloads a PNG. The QR encodes the event URL with `utm_source=qr`, and `attributionSourceLabel` gains `qr: 'QR code'`, so poster scans show up as their own source.
- New route `GET /api/host/events/[id]/qr`: host session, the event must be the host's (404 otherwise), needs a slug (404 "This event has no public link yet." otherwise), same PNG geometry and origin-only URL build as `signup-qr`, `Content-Disposition: attachment; filename="<slug>-qr.png"`.
- When the event is not on sale (`!eventIsPublic(event)`), one line under the block: "This event is not on sale yet, so these links will not open for the public."
- One line of help: "Bookings from each link show up by source on the Insights tab."

**Non-goals.** Custom source names; short links; a QR for a series page.

## 2. "Write an email about this event" (Promote tab)

**Intent.** The host's own list is their best source of bookings, and today they start from a blank email.

- A new block "Email your list" on Promote, between Share and Promo codes: the host's contact count and a button **Write an email about this event**.
- The button POSTs `POST /api/host/events/[id]/announce-draft`, which creates a `host_campaigns` draft for this host and returns its row. Then the browser goes to `/host/emails?open=<draft id>&notice=event`.
- The draft: subject = the event name; `audience_kind: 'all'`; `email_type: 'marketing'`; no `design_json` (so it opens in Plain text mode and the host can switch to the designer); body = a short, editable text built from the event: its name, its date written out, its session times, its venue, and a line with a link to the public event URL reading "Book your place". The body must render correctly through the existing send and preview pipeline, and its event link must be one `host-campaign-links` tags with `hc`. The builder confirms the exact body format against `host-campaign-email.js` and the preview route.
- Only for an event that is on sale: otherwise the route answers 409 "Publish this event before emailing your list about it." and the button is replaced by that sentence.
- The composer learns one thing: `?open=<id>` opens that draft once the list has loaded (the same code path as clicking the draft's Edit), and `?notice=event` shows "Draft created from your event. Edit it, send yourself a test, then send or schedule."
- Nothing is sent by this feature. Every send gate stays where it is.

**Non-goals.** A designed (Unlayer) template; choosing the audience on the Promote tab; scheduling.

## 3. A preview beside the Your page editor

**Intent.** The editor is a form; the host cannot see what the fields do without opening another tab.

- On `/host/page`, from `lg` up, two columns: the editor on the left, a preview on the right that stays in view while the editor scrolls (sticky). The preview is an `<iframe>` of the host's own public page, loaded from the portal's origin as the relative path `/h/<slug>`, titled "Preview of your public page".
- It shows the **saved** page. After each successful save it reloads. A caption says "This shows your saved page. Save to update it."
- Below `lg` the preview sits under the editor behind a "Show preview" button (closed by default), so a phone is not handed a second page to scroll past.
- If the URL is unavailable the preview is not rendered.

**Non-goals.** A live preview of unsaved edits; device-size switching.

## 4. New ratings on the Overview

**Intent.** Ratings arrive the morning after an event and the host has no reason to look.

- In "Needs your attention" on `/host`, after the existing lines: one neutral (not amber) line per event that received a rating in the last 7 days: "3 new ratings on **<event name>** this week. Read them →", linking to that event's Insights tab. Singular: "1 new rating".
- Counted from `event_ratings.created_at`, hidden and public alike, for the events the Overview already loads. At most three lines, newest event first; no "seen" marker, so a line simply ages out after 7 days. This replaces the earlier idea of a per-host "seen" marker, which needed a write.
- A failed read shows no line and logs a warning. It is a notice, not a figure, so there is no "unavailable" text.

## 5. Guard: event column lists

`loadHostEvent(db, hostId, eventId, columns)` takes its column list as an argument, which `check:select-columns` cannot read. A column that does not exist makes the read fail, the helper return null, and that tab 404 for every host, with green tests. Add a test under `tests/` that finds every `loadHostEvent(` call in `src/`, reads its column list, and proves each top-level column exists on `race_events` in the schema replayed from `supabase/migrations` (reuse the replay the `check:select-columns` script uses; embeds such as `series:event_series ( … )` and `race_waves ( … )` are checked against their own tables if the replay makes that cheap, otherwise their inner columns are skipped by name in the test's header comment).

## 6. Constraints (unchanged from the first release)

Every server page and route gates on `getCurrentHost()` and scopes to that host; another host's event is a 404. A Server Component never passes a function to a Client Component. A failed read never renders a 0 that looks like an answer. Every screen holds at 375px. New routes are registered in `src/lib/openapi.js` and pass `check:route-guards`. No customer or host names in tests or the PR.
