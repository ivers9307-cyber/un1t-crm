# /50plus — The 50+ Club trial landing page (FIFTYPLUS.1)

**Date:** 2026-10-30
**Owner:** Richard Ivers
**Status:** approved 2026-10-30; shipped as #2256 (plan: docs/superpowers/plans/2026-10-30-50plus-landing-page.md)

## Intent

A Meta ad for the over-50s needs its own landing page at `/50plus` on
un1tdublin.com. The person who taps it should be able to book their first
**THE 50+ CLUB** class at UN1T Stillorgan in under a minute, be signed up to
**The Elites Trial** (the €0 class-pack trial plan already in Glofox at
Stillorgan), and never see the rest of the timetable. The page is built for
an older reader: calm, light, large type, a coach talking to camera.

Why now: the 50+ ad is about to run and the existing `/trial` page sells the
paid 14 Day Reset to the general audience; sending 50+ traffic there is the
wrong product and the wrong class list.

## What we know (verified 2026-10-30 against prod)

- Stillorgan's Glofox timetable has exactly one 50+ class: **THE 50+ CLUB**,
  Mon, Wed and Fri at 11:00 (13 occurrences in the last 30 days, no other
  slot). Name match on `50+` is unambiguous today.
- **The Elites Trial** is a Glofox plan at Stillorgan: price €0, type
  `num_classes`, status `trial`; 16 Stillorgan contacts hold or held it. So
  this is a **free-trial funnel** (the old `/start` class funnel shape: pick a
  class, details, booked, trial granted), not a paid one like `/trial`.
- `locations.settings.glofox.hidden_class_keywords` is empty at Stillorgan,
  so the 50+ class is visible to the existing public class read; the only
  filtering needed is an **allow-list**.
- The Stillorgan landing row (`landing_page_settings.public_path =
  'stillorgan'`) already holds `class_funnel` (the retired 3-free-classes
  funnel, trial override set to the location default `620bdab4…:1644944026897`)
  and `paid_trial` (The 14 Day Reset) blocks, plus `hero`, `reviews`, `stats`
  and `video_testimonials` (three portrait member clips with posters).

## Goals

1. `/50plus` is live on un1tdublin.com, public, `noindex`, Meta pixel + CAPI
   Lead firing to the site dataset (Stillorgan has no studio pixel).
2. The booking card offers **only** THE 50+ CLUB's upcoming slots for the
   next 14 days (the Glofox read's ceiling), as date tiles: Mon 3 · Wed 5 ·
   Fri 7 …, with the time. Six tiles in a normal fortnight.
3. A brand-new person is registered in Glofox with **The Elites Trial**
   attached (the per-funnel trial override), then booked into the chosen
   slot; the usual WhatsApp confirmation follows. A returner goes through the
   existing returner gates (`prior_attendance` and friends) unchanged.
4. Leads carry their own attribution: tag `stillorgan-50plus`, lead source
   `meta_50plus`, so the pipeline and ads report show them apart from every
   other Stillorgan campaign.
5. Every word, the video, the poster, the class filter and the trial plan are
   **operator-editable** at `/settings/landing-page` (Stillorgan row), so the
   copy can change without a deploy and the page can be re-pointed at another
   class or plan.
6. Page look is direction **C1** from the brainstorm: coach video first, the
   three days as the hero of the form, light below the fold, video left and
   booking card right on desktop.

## Non-goals

- No payment step. The Elites Trial is €0 and the CRM takes no money here.
- No Hatch Street variant (Hatch has no 50+ class and no Glofox).
- No age verification, no eligibility rule beyond what the booking processor
  already applies.
- No change to `/trial`, `/start`, `/stillorgan`, or their blocks.
- No new WhatsApp template; the existing class-booking confirmation is enough.

## Anti-goals (a failure even if it works)

- The page lists any class other than THE 50+ CLUB, or lets a 50+ lead book
  one via a forged request.
- A 50+ lead gets the generic 3-free-classes trial instead of The Elites
  Trial, or gets both.
- A 50+ lead lands on the Stillorgan board indistinguishable from `/start`
  leads.
- Dark, cramped, small type. The reader is 55–70 on a phone.
- A hard-coded headline or class name that needs a PR to change.

## Constraints (from CLAUDE.md, all binding)

- Public page lives outside any auth-gated segment and is added to the
  three UN1T lists (`src/proxy.js` publicPaths, `AppShell` PUBLIC_PATHS,
  `brands.js` un1t-marketing allowedPaths). Like `/start` and `/trial` it is
  UN1T-only, so it is deliberately **not** added to the tenant defaults
  (`tenant-domains-edge.js` `DB_BRAND_DEFAULTS.allowedPaths`) and is listed in
  `TENANT_PINNED_OFF` in `src/public-compliance-paths.test.jsx`, which pins
  both directions.
- Public routes stay service-role, rate-limited, location resolved only from
  an existing landing row; display-safe class data only (PUBCAP.1: never a
  capacity figure).
- The booking route re-validates the chosen event against the **same**
  filtered read the picker used, so a hidden or non-50+ class can be neither
  seen nor booked under this campaign.
- Customer-facing copy operator-editable with defaults; every `<button>` in a
  form typed; light-theme chip rules; no new `console.log`.
- Meta: the site pixel (UN1T Web, `1866914428028977`) already loads on every
  path, so `meta-pixel-paths.js` needs no change. The server-side (CAPI) Lead
  goes to the location's `settings.meta_ads.dataset_id`, which at Stillorgan
  IS that same dataset (verified 2026-10-30), with the token resolved from the
  studio's WhatsApp number as today; `eventSourceUrl`
  `https://www.un1tdublin.com/50plus`. A code note says the Stillorgan
  dataset showed no server Lead after a live test on 21 Oct 2026, so go-live
  step 4 checks Events Manager for one.
- No DB migration is needed (the block lives in `landing_page_settings.blocks`
  JSONB; `class_booking_requests` already carries `trial_membership_id` /
  `trial_plan_code`). If the builder finds one is needed, apply it before the
  code deploys and run the security advisors.

## Decisions made in the brainstorm (Richard's)

| Topic | Decision |
|---|---|
| Copy/media location | Editable in settings, a block on the Stillorgan landing row |
| Headline promise | "A free trial of The 50+ Club" (no class count stated) |
| Look | Direction C: coach video first, three days as big tiles, light below the fold |
| Desktop | C1: video left two-thirds with headline over it, booking card right |
| Lead tracking | Own tag `stillorgan-50plus` + lead source `meta_50plus` |
| Glofox plan | Richard confirms The Elites Trial's credits book THE 50+ CLUB (2026-10-30); go-live step 2 re-checks it in Glofox |
| 14 Day Reset later | Keep `/trial`'s rule: a 50+ trialist has had a trial and cannot buy the Reset afterwards. No change to `/trial` |
| Video sound | Autoplay **muted** (browsers refuse sound without a gesture; iOS always); a large, obvious "Tap for sound" control unmutes in one tap. Richard asked for sound on load; it cannot be done reliably, so the clip should carry burned-in captions. |

## Builder-check answers (2026-10-30)

A reviewer read this as a builder and asked five things. Answered:

- **Can The Elites Trial's credits book THE 50+ CLUB?** Not provable from the
  CRM: the 16 holders are a 12 May 2026 import with no booking rows, and the
  class's recent attendees hold Elite Membership, 3 Month Elites, a 20 Class
  Pack or the generic trials (so the class itself accepts trial credits).
  Whether the plan is restricted to a programme is a Glofox setting: go-live
  step 2 confirms it in Glofox before the ad runs. If it cannot, the fallback
  is the existing `needs_credit_grant` card, never a silent generic trial.
- **Which Meta dataset?** Stillorgan's dataset is the site dataset; see
  Constraints. No block field, no fallback change.
- **Automated messages after booking?** Only one sequence is live at
  Stillorgan (`Trial Done – Membership / Class Pack`, on the `trial_done`
  stage), nothing on the `stillorgan-start` tag, so the new tag loses
  nothing. 50+ trialists will get that generic Trial Done sequence; a 50+
  version on the `stillorgan-50plus` tag is a later content step, not code
  (my call).
- **Telling an existing contact apart on the board?** By the tag,
  `last_lead_source` and the `50plus` funnel events; no badge on the deal
  card (my call: the board filters by tag already, and the ads report reads
  attribution, not `lead_source`).
- **Paid 14 Day Reset after an Elites Trial?** `/trial` refuses any
  Stillorgan buyer with trial history, so a 50+ trialist could not buy the
  Reset later. Richard: keep it that way (decisions table).

## Design

### The block: `campaign_funnel` (new block type, editor-only on the landing page)

One block on the Stillorgan row, like `paid_trial`: it renders in the editor as
an editable stub and **never** on `/stillorgan` itself. Its page is
`/50plus`. Fields (all operator-editable, every string with a default):

- `campaign`: `'50plus'` (fixed by the page; shown read-only in the editor).
- Hero: `eyebrow` ("The 50+ Club · Stillorgan"), `heading` ("A free trial of
  The 50+ Club"), `subhead`, `video_url`, `poster_url` (uploaded through the
  existing hero video uploader: signed upload, same bucket/limits as the hero
  block), `sound_label` ("Tap for sound").
- Booking card: `pick_title` ("Pick your first morning"), `pick_body`, `cta_label`
  ("Book {day} {time}"), `reassurance` ("Free · no card needed · 60 minutes"),
  `consent_label` (default via `classFunnelConsentDefault(brand)`),
  `done_title`, `done_body`, `no_classes_text` ("No 50+ Club classes are
  open to book in the next two weeks. Message us and we'll sort you out.").
- Class filter: `class_keywords` — allow-list, one keyword per line, default
  `50+`. A class is offered only when its name contains **any** keyword
  (case-insensitive), after the location's deny-list has already been applied.
  Empty list ⇒ the page offers nothing and says so (never the whole
  timetable).
- Trial: `trial_membership_id` + `trial_plan_code` via the existing Glofox
  trial picker (`buildTrialOptions`). Both required for the page to take a
  booking; a half-set pair refuses with `not_configured` (never a silent
  fallback to the location default, which is the generic trial: anti-goal 2).
- Attribution: `tag` (default `stillorgan-50plus`), `lead_source` (default
  `meta_50plus`), `event_source_url` (default the page URL).
- Below the fold: `expect_eyebrow`, `expect_heading`, `expect_cards` (3 ×
  `{ title, body }`, defaults written for an over-50 reader), and
  `show_sections: ['stats', 'video_testimonials', 'reviews']` — which of the
  row's existing blocks to render after it, in a light variant.

Builder's call: field names, and whether `expect_cards` reuses the `pillars`
block's item shape. Keep `CLIENT_BLOCK_FIELDS`-style narrowing so only the
words the browser needs travel to it; never the Glofox ids.

### The page: `src/app/50plus/page.js`

Code-defined, `force-dynamic`, `noindex`, modelled on `src/app/trial/page.js`.
Reads the Stillorgan row once; if the row or block is unreadable the hero and
card still render (card shows the unreadable/not-configured message, never a
404 for paid traffic). Layout:

- Light chrome (`bg-[#fff]` / warm off-white panels, black text), type one
  step up from `/trial`; the existing `SiteHeader`/`SiteFooter` with a light
  tone prop (builder's call whether to add the prop or compose a light header).
- Hero: on phones the video is the top ~55svh with the eyebrow and heading
  over its lower edge and a white gradient into the card; on `lg+` a
  two-column grid, video left (`1.6fr`) with the headline over it, card right
  on the off-white panel. Video `autoplay muted loop playsinline`, `poster`
  set; the unmute control is a large pill, top-right of the video, toggling
  `muted` (one tap; keep the loop).
- Booking card (`CampaignFunnel`, new client component): steps `pick` →
  `details` → `done`. `pick` shows date tiles (weekday, date number, time;
  two rows of three on desktop, three across on phones with "more dates"
  revealing the second week), the CTA naming the chosen slot. `details` keeps
  the chosen slot on screen with Change (as `ClassFunnel` does), first/last
  name, email, phone, consent. `done` shows `done_title`/`done_body`. Errors
  from the booking route (`class_full`, `timetable_unavailable`,
  `not_configured`) are shown in the card in the operator's words where the
  block has them.
- Below the fold: the "what to expect" strip (three cards), then the chosen
  existing blocks in a light variant, then the footer. Every CTA on the page
  scrolls to `#book`.

Reuses from `ClassFunnel`: the funnel-step tracking (`trackFunnelStep` /
`/api/public/funnel-event` with `funnel: '50plus'`), attribution capture from
the landing URL (UTM, `meta_ad_id`, `fbclid`, `_fbp`), `VisitOriginCapture`,
`fireBrowserLead` sharing the server's `lead_event_id`. The builder may lift
these into a shared hook rather than copy them.

### The reads and writes

- `GET /api/public/classes?path=stillorgan&campaign=50plus`: the existing
  route gains an optional `campaign`. When present it finds the row's
  `campaign_funnel` block with that key and applies its allow-list through a
  new option on `readPublicClasses(db, locationId, days, { onlyKeywords })`;
  `days` = 14 for a campaign. Unknown campaign ⇒ empty list. Rate-limit key
  stays per path.
- `POST /api/public/class-booking` with `campaign: '50plus'`: resolves the
  same block; takes `tag`, `lead_source`, `event_source_url`,
  `trial_membership_id`/`trial_plan_code` from **it** (not from `class_funnel`),
  refuses `not_configured` when the trial pair is missing, and re-validates
  `event_id` against the allow-listed read. `price_cents` is always 0 here.
  Everything downstream (contact create/match, deal, tag, queue row, processor,
  WhatsApp) is unchanged: the processor already honours the trial override at
  registration (`findOrCreateGlofoxMember({ attachTrial: true, trialOverride })`)
  and on `needs_credit_grant` approval.
- `funnel_events`: `funnel: '50plus'` so drop-off reads apart from `start`.

### Editor

`LandingPageSettingsForm`: a `CampaignFunnelEdit` panel (sibling of
`PaidTrialEdit`): text fields, the video/poster uploader (reuse
`HeroMediaTools`), the keyword textarea, the trial picker, the section ticks.
The block is addable from the block menu once per campaign key; the editor
refuses a second with the same key.

### Tests (what must be pinned)

- `public-compliance-paths.test.jsx`: `/50plus` on all four allowlists and
  pinned off tenant hosts.
- `readPublicClasses` allow-list: keyword match, case-insensitive, empty list
  offers nothing, deny-list still applied first.
- Classes route: `campaign` resolves the block; unknown campaign ⇒ `[]`.
- Booking route: a campaign request takes tag/source/trial from the
  `campaign_funnel` block, refuses `not_configured` without the trial pair,
  refuses an `event_id` outside the allow-list even if it is a real Stillorgan
  class.
- `CampaignFunnel` component: tiles render from the class list grouped by
  day, CTA names the chosen slot, details keeps the slot visible, Change goes
  back, done copy shown; every in-form button typed.
- Block defaults: every customer-facing string has a non-empty default;
  `blocksOrDefault` round-trips the block.
- Existing suites stay green (`ClassFunnel`, `/trial`, landing editor).

### Go-live steps (not code)

1. Richard adds the block on the Stillorgan row at `/settings/landing-page`,
   picks **The Elites Trial** in the trial picker, uploads the coach video
   (with burned-in captions) and poster, and checks the words.
2. Confirm `class_keywords` = `50+` still matches THE 50+ CLUB and nothing
   else (the classes route in a browser).
3. Point the ad at `https://www.un1tdublin.com/50plus?utm_campaign=…`.
4. First real booking: check the Glofox member got The Elites Trial, not the
   generic trial, and the lead carries `stillorgan-50plus`.

## Left to the builder

- Exact Tailwind classes, spacing and the off-white hex (the mockups used
  `#f6f3ec`); the date-tile markup; how "more dates" reveals the second week.
- Whether `SiteHeader`/`SiteFooter` take a tone prop or the page composes its
  own light header.
- Whether the light variants of `stats`, `video_testimonials` and `reviews`
  are a `tone` prop on the existing renderers (preferred) or page-local
  components.
- How the funnel-step/attribution plumbing is shared with `ClassFunnel`.
- Where the campaign-aware block lookup lives (`public-landing.js` is the
  natural home, beside `classFunnelConfigFromBlocks`).
- Changelog entry file and the usual CI mirror.
