# Landing pages: every public page its own record (PAGES.1) — design

**Date:** 2026-10-30
**Owner:** Richard Ivers
**Status:** builder-checked, awaiting Richard's approval

## Intent

Every public marketing page on un1tdublin.com becomes its own stored,
editable thing: the two studio pages and every campaign page (`/trial`,
`/50plus`, `/corp`, the next one). Richard, or a studio manager, opens
Settings → Landing pages, sees them all in one list, edits the words, swaps
the video, changes what the page sells, and switches it live. A new campaign
page is created from that list with a path typed in, no PR, no allowlist
edit, no deploy.

Why now. The campaign pages are code routes that each borrow one block off a
studio's landing row, because `landing_page_settings` is one row per studio.
That shape has produced, in a month: `/start`, `/free-class`, `/trial`,
`/50plus` and `/corp`, each a new route plus four allowlists plus a block type
rendered as a stub in an editor that cannot preview the page it drives. The
50+ page's own header comment says "the page is code because landing rows are
one per studio". Richard's words on 2026-10-30: every page should be
configurable individually, not linked to a landing page, with the option to
tie it to one studio or all studios in the organisation, and the booking tied
to the membership in that studio.

## Goals

1. **One list, every page.** Settings → Landing pages lists every public page
   of the organisation, studio pages and campaigns alike, with path, studios,
   offer, status and last edit. "New page" creates one.
2. **Own content.** A page holds its own ordered blocks, media, chrome and
   publish state. Nothing on a campaign page is read off a studio page. (A
   "start from" helper copies another page's blocks at creation; after that
   they are independent.)
3. **Scope: one studio or all studios.** A page is tied to one studio of the
   organisation or to all of them. On an all-studios page each studio is
   switched on or off individually; the visitor picks a studio on the page, or
   the ad link preselects it (`?studio=<public_path>`) and the choice is
   skipped.
4. **One offer per page, configured per studio.** A page carries exactly one
   **primary offer** (the thing its hero card sells: a paid trial, a class
   funnel, a one-class campaign, promo credits). The offer's studio-specific
   part (which Glofox plan or un1t.online product, which class, the price, the
   attribution tag) is set per studio from that studio's real catalogue, and
   every booking, purchase or grant goes to that studio's own platform. The
   light capture blocks (`lead_form`, `booking`, `event`) are not offers: they
   stay ordinary content blocks a page may carry alongside the offer, as the
   studio pages do today (builder check Q1, my call: Richard's "one per page"
   was about two sellable products side by side, and Goal 6 forbids stripping
   the live studio pages' waitlist and consult forms).
5. **No deploy for a new page.** The four public-path gates (proxy, AppShell,
   un1t-marketing brand, tenant defaults) learn page paths from the database.
6. **Existing pages migrate across** with their content, their offer settings
   and their URLs. Nothing a visitor can reach today breaks.
7. **Editor shape stays.** Controls left, the live page right with click-to-
   edit, as today; the offer is the first block in the content list with one
   row per studio inside it; a "Previewing: <studio>" switch in the preview
   bar shows the page as a visitor who arrived with the studio preselected
   (Richard's choice, option B plus the switch, 2026-10-30).

## Non-goals

- The front page chooser (`/welcome`, `chooser_settings`) stays what it is: an
  organisation front page with its own small editor. It is reachable from the
  Pages list ("Front page" button) but is not a page row. A later piece could
  fold it in.
- `/offers` is a storefront driven by `sale_offers` (timed sales and gift
  cards), not a landing page. Out of scope; it keeps its route.
- No change to the public booking flows' behaviour: the free class funnel, the
  paid trial, the one-class campaign funnel and the promo claim keep their
  rules (returner gates, trial eligibility, Glofox write judging, un1t.online
  write budget). They change where they read their configuration from.
- No new offer type. The set is what exists today (see "Offer types").
- No per-page custom domain. Pages live on the organisation's marketing host.
- No A/B variants, scheduling or analytics dashboards in this piece.
- No change to champ-app or mobile.

## Anti-goals (a failure even if it works)

- A campaign page silently changes because someone edited the studio page (the
  coupling this removes).
- A page scoped to one studio books, charges or grants against another.
- A visitor on an all-studios page is offered a studio that is switched off or
  has no offer configured there.
- A new page's path shadows an app route (`/settings`, `/api/...`, `/login`)
  or an existing page.
- Operator-typed content reaches the browser with anything secret: Glofox ids,
  plan codes, keyword lists, tokens, dataset ids stay server-side, as the
  campaign funnel does today (`CAMPAIGN_FUNNEL_CLIENT_FIELDS`).
- A studio manager edits an organisation-wide page or another studio's row.
- Migration leaves a live URL 404ing or renders a page on its defaults because
  a row did not carry over.

## Current state (read 2026-10-30)

- `landing_page_settings` (migs 126-130, 227, 247): PK `location_id`, one row
  per studio, `public_path`, `blocks` JSONB (ordered typed blocks), logo
  columns, `publish_state` (`live | coming_soon | hidden`), chooser tile
  columns. Edited at `/settings/landing-page` by `LandingPageSettingsForm`
  (1,863 lines): block list left, `/welcome/<path>?edit=1` iframe right,
  `EditModeOverlay` postMessage contract for click-to-select, inline text
  editing, move/duplicate/delete/add.
- Block registry: `src/lib/landing-page-blocks.js` `BLOCK_TYPES`, 16 types.
  Content blocks: `hero`, `pillars`, `gallery`, `embed`, `stats`,
  `testimonial`, `reviews`, `video_testimonials`. Offer blocks: `booking`,
  `event`, `lead_form`, `class_funnel`, `paid_trial`, `corp_promo`,
  `campaign_funnel`, `offer`. `BlocksArraySchema` caps at 40.
- Campaign routes: `/trial` (reads both studios' `paid_trial` blocks via
  `loadTrialStudios`, studio picker, `?studio=` preselect, un1t.online return
  at `?purchase=`), `/50plus` (merged as #2256 on 2026-10-30; reads
  Stillorgan's `campaign_funnel` block, campaign `'50plus'`, edited by
  `CampaignFunnelEdit` in `LandingPageSettingsForm`, one block per campaign
  key per row), `/corp` (reads Hatch's `corp_promo` block),
  `/start` and `/start/[path]` and `/free-class` (redirect to `/trial`,
  retired 24 and 28 Oct 2026). Each is on `src/proxy.js` `publicPaths`,
  `AppShell` `PUBLIC_PATHS`, `brands.js` un1t-marketing `allowedPaths`, and
  either on or pinned off `tenant-domains-edge.js` `DB_BRAND_DEFAULTS`
  (`src/public-compliance-paths.test.jsx` pins both directions).
- Public API: `/api/public/classes`, `/api/public/class-booking`,
  `/api/public/trial-purchases`, `/api/public/leads`, `/api/public/corp-claims`,
  `/api/public/funnel-event`, `/api/public/start-prefill`. They resolve the
  studio from `public_path` and read the offer block off that studio's row;
  the client cannot inject attribution (`LEAD_CAMPAIGNS` in `src/lib/leads.js`).
- Media: `/api/landing-page-settings/{hero-image,hero-video,gallery-photo,
  pillar-photo,media}` write the public `branding` bucket (limits in
  `src/lib/branding-media.js`; video via signed upload). Logo per studio row
  (`src/lib/landing-logo.js`).
- Permission: `landing_page` (web) at the studio; the chooser needs an org
  admin (`isActiveOrgAdmin`).
- Meta: site pixel on every marketing path; per-studio dataset from
  `locations.settings.meta_ads.dataset_id`; `meta-pixel-paths.js` maps paths
  to extra pixels.

## The design

### 1. Two tables

**`landing_pages`**: one row per public page.

| column | meaning |
|---|---|
| `id` uuid PK | |
| `organization_id` uuid → organizations | the owning organisation |
| `slug` text | the path after `/`, lowercase, `[a-z0-9-]`, 2..40 chars; unique per organisation; never a reserved word (§5) |
| `title` text | internal name shown in the list ("The 50+ Club") |
| `kind` text | `studio` or `campaign`. A `studio` page is the studio's main page (one per studio, enforced by a partial unique index on `(primary_location_id) WHERE kind='studio'`), and is what the chooser tiles and `/<public_path>` pretty paths point at |
| `scope` text | `one` or `all` |
| `primary_location_id` uuid → locations, nullable | required when `scope='one'`; the studio whose brand, logo, reviews and pixel the page uses. NULL when `scope='all'` (chrome is the organisation's, as `/trial` does today) |
| `offer_type` text | the primary offer: one of the offer types (§3), or `none` for a page with no sellable offer |
| `blocks` jsonb | ordered content blocks, same shape and schema as today; the offer block is a block of type `offer_type` at most once; `lead_form`, `booking` and `event` blocks may appear as content and post against the resolved studio (§2 step 2) |
| `chrome` jsonb | logo url/alt/width, tone (`light`/`dark`), noindex flag, meta title/description |
| `publish_state` text | `draft`, `live`, `coming_soon`, `retired`. `retired` + `redirect_to` keeps a dead campaign URL answering |
| `redirect_to` text nullable | a path on the same host; only read when `retired` |
| `created_by`, `updated_by` uuid → profiles, `created_at`, `updated_at` | |

**`landing_page_studios`**: one row per (page, studio).

| column | meaning |
|---|---|
| `page_id` uuid → landing_pages ON DELETE CASCADE | |
| `location_id` uuid → locations | must belong to the page's organisation (trigger, as `location_whatsapp_numbers` does) |
| `enabled` boolean | switched on for this studio |
| `offer` jsonb | the studio-specific part of the offer (§3): plan or product ids, class allow-list, price, consent text override |
| `attribution` jsonb | `tag`, `lead_source`; default `<public_path>-<slug>` and `meta_<slug>`; never client-writable |
| `sort_order` int | picker order |
| PK `(page_id, location_id)` | |

A `scope='one'` page has exactly one studio row (its primary); the API
enforces it. A `scope='all'` page has one row per active studio of the
organisation, created on first save with `enabled=false`; a studio added to
the organisation later gets its row when the page is next saved (the editor
shows it as "not yet set up").

Both tables: RLS on, **no client grant, no policy** (mig 677 default; service
role only). Everything is read and written through routes. `audit_mutation`
attached to both; `offer` and `attribution` hold no secrets by construction
(ids and codes, no tokens), but a key named `*_token`/`*_secret` would be
masked anyway.

**`landing_page_settings` is deprecated, not dropped**, per the repo rule:
a migration creates the two tables, backfills them (§6), comments the old
table `DEPRECATED (mig N)`, and code stops reading it. A later migration drops
it once the chooser and every reader have moved. The chooser tile columns
(`chooser_label`, `chooser_cta_text`, `chooser_image_url`) move onto the
`studio` page's `chrome` so the chooser reads `landing_pages` too.

### 2. One public route

`src/app/(public)/[slug]/[[...rest]]/page.js` renders every page row:

1. **Organisation.** The brand/host resolves the organisation as today
   (`un1t-marketing` → UN1T Group; a `tenant_domains` host → its org). On the
   CRM host, which has no brand, an anonymous hit resolves to
   `UN1T_GROUP_ORG_ID` (so today's ad links that point at the CRM host keep
   answering), and an `?edit=1` hit resolves to the signed-in editor's
   organisation, which is what makes the same-origin preview iframe work for
   any org (builder check Q2, my call; slugs stay unique per organisation).
   Read the page by `(organization_id, slug)`. No row or `draft` → the
   current 404 behaviour. `retired` → `redirect(redirect_to)` with the query
   string kept (the `/free-class` pattern), for the slug and anything under
   it (`/start/hatch-street` included). `coming_soon` → 404 (today's rule
   for studio pages).
   **Sub-paths** (`rest`) are interpreted by the page: a `studio` page serves
   `events` and `status` (today's `/welcome/[location]/events` and `/status`,
   moved under the slug: `/stillorgan/events`); a `promo_credits` page takes
   one segment naming the promo key (`/corp/hatch-3-free` keeps answering);
   anything else under a slug is 404. The gates (§5) therefore admit a slug
   **and anything under it** (builder check Q5).
2. Studio resolution: `scope='one'` → the primary. `scope='all'` →
   `?studio=<public_path>` if it names an enabled row, else no studio yet and
   the offer renders its picker over the enabled rows (`sort_order`). A studio
   that is enabled but whose offer is not `configured` (§3) is listed as "not
   available online" the way `/trial` does today, never dropped silently.
3. Layout is chosen by `offer_type` (§4), then the content blocks render in
   order through `BlockRenderer` as today, then the footer.
4. Chrome: logo and tone from `chrome`; company name, footer, legal from the
   organisation (`resolveOrgChrome`) or the primary studio
   (`resolveLocationBrand`) as the existing pages do. Reviews, Instagram and
   stats sections take the resolved studio; on an all-studios page with no
   studio chosen yet they take the first enabled studio (builder may prefer
   hiding them until a studio is chosen; say which).
5. `?edit=1` mounts `EditModeOverlay` as today, plus the preview-studio message
   (§7).

The pretty studio paths keep working: `/stillorgan` is the `studio` page whose
slug is `stillorgan`, so the `next.config` rewrites to `/welcome/<path>` go,
and `/welcome/[location]` (with `/events` and `/status` under it) becomes a
redirect to `/<slug>`, `/<slug>/events`, `/<slug>/status` for old links.
`/trial`, `/50plus`, `/corp` delete their route files once their rows exist;
`/start`, `/start/[path]`, `/free-class` become `retired` rows with
`redirect_to`. Next resolves a static segment before `[slug]`, so the existing
app routes win; §5 stops a page claiming one of their names.

### 3. Offer types

One per page, chosen at creation (changeable while `draft`, locked once a
page has ever been `live`: a live page's leads and purchases reference its
offer shape). Each type names three things: the **page-level fields** (words
and media the block holds), the **studio-level fields** (what `offer` on the
studio row must carry), and the **readiness rule** (`configured` when the
studio row can take a real booking).

| `offer_type` | today's block | page-level | per studio | configured when |
|---|---|---|---|---|
| `paid_trial` | `paid_trial` | headline, price panel copy, buyer form copy, terms text | platform (`glofox` or `un1t_online`, derived from the studio's `membership_source`), plan id or product id, price, duration | plan/product set and the price agrees with the catalogue read |
| `class_funnel` | `class_funnel` | copy, consult upsell switch, consent text | trial plan id/code (Glofox) or product (un1t.online), class allow/deny keywords, typed timetable for a studio with no platform | plan set, or the typed timetable non-empty |
| `one_class` | `campaign_funnel` | eyebrow/heading/subhead, video + poster, expect cards, done copy, sections shown | class keyword allow-list, trial plan id + code | both set and the allow-list non-empty |
| `promo_credits` | `corp_promo` | the words of the offer, consent | promo key only (`src/lib/corp-promos.js`) | promo key resolves to a promo at this studio |
| `none` | | | | n/a (a content-only page, or one whose only capture is a `lead_form`, `booking` or `event` content block) |

`lead_form`, `booking` and `event` are content blocks, not offer types (Goal 4):
they post against the resolved studio and carry their own `tag`/`lead_source`
fields as today.

**Promo credits and expiry stay in the registry**, never on a row an editor
writes: `grantPromoCredits` keeps taking them from `corp-promos.js`
(Richard's decision 28 Oct 2026, pinned by the un1t.online write guards; the
studio row only names which promo the page sells; builder check Q4).

**Readers that hold only a `location_id`.** Several non-page readers today
treat the studio's landing row as "the studio's public settings": the
un1t.online terms-tick wording (`un1t-online-funnel-copy.js`, on the live
purchase path), the WhatsApp flow's and Mia's confirmation copy
(`whatsapp-flow/handler.js`, `agent/membership-requests`,
`un1t-online-booking-processor.js`), the typed timetable
(`public-classes.js` `readNoGlofoxClasses`), and `public_path` as the studio's
public identity (`host-brand.js`, the legal and status pages). The rule
(builder check Q3, my call): a request that came from a page records the
page (`class_booking_requests.page_id`, `trial_purchases.page_id`, leads'
`page_id`; new nullable columns) and its copy is read from **that page's
studio row**; a reader with only a studio reads the studio's `kind='studio'`
page's studio row **when that page's offer is of the type asked about**, else
the type's copy defaults. The studio's public identity is a helper,
`studioPublicPath(locationId)` = the slug of its `studio` page (one per
studio by index). This keeps everything on the two tables; the list of
readers above is the PR1 checklist, and `tests/` pins that none of them
still selects from `landing_page_settings`.

The block factories, Zod schemas and copy defaults already exist for each
(`landing-page-blocks.js`, `campaign-funnel.js`, `paid-trial.js`,
`corp-promos.js`). The change is to **split each existing offer block into
its page half and its studio half**: the page half stays in `blocks`, the
studio half moves to `landing_page_studios.offer` with a Zod schema per type
in one new module (`src/lib/landing-page-offers.js`: `OFFER_TYPES`, the two
schemas per type, `configured(type, offer)`, `clientFields(type)`). The
`offer` block in `blocks` carries only `{ id, type }` plus page-level fields;
the renderer receives the merged view for the resolved studio, filtered to
client fields.

The public API routes stop taking `public_path` + `campaign` and take
`page=<slug>` + `studio=<public_path>` (optional on a one-studio page). Each
resolves the page row, then the studio row, refuses `not_configured` when the
readiness rule fails, and reads attribution and platform ids from the row,
never from the request. `LEAD_CAMPAIGNS` in `src/lib/leads.js` is replaced by
the row's `attribution`. The booking route re-validates a chosen class against
the same filtered read the picker used (the 50+ rule, kept).

### 4. Layouts

Layout follows `offer_type`, with `chrome.tone` as the one switch:

- `paid_trial`, `class_funnel`, `promo_credits`, `booking`, `event`: the hero
  photo with the offer card as a frosted panel, blocks below, CTAs scroll to
  the card (today's `/trial`, `/start`, `/corp` shape).
- `one_class`: coach video left two-thirds with the headline over it, date
  tiles right, the expect strip, then blocks (today's `/50plus`, direction
  C1).
- `lead_form`, `none`: hero block first, then blocks (today's studio page
  shape; TRIALFIRST's "card in the hero" when the page has a `paid_trial`
  offer and is a `studio` page).

A `studio` page is a page like any other: kind `studio`, usually offer
`paid_trial` (TRIALFIRST). No separate renderer.

### 5. Public paths from the database

One module, `src/lib/public-pages-edge.js`, edge-safe (same style as
`tenant-domains-edge.js`): `listPublicPageSlugs(organizationId)` returns the
slugs of pages that are `live`, `coming_soon` or `retired` (a retired page
must still be reachable to redirect), cached for 60 s in the edge runtime
with the in-code list as the fallback when the read fails. The four gates
consult it:

- `src/proxy.js`: a hit on a page slug, or anything under it, is public; the
  proxy also sets a request header (`x-public-page: 1`) on that hit.
- `AppShell`: reads that header through the root layout (a page cannot pass
  props to the root layout), so the client list needs no change for pages.
- `brands.js` un1t-marketing `allowedPaths` and `tenant-domains-edge.js`
  `DB_BRAND_DEFAULTS.allowedPaths`: the resolver appends the organisation's
  page slugs.

In-code entries for `/trial`, `/50plus`, `/corp`, `/start`, `/free-class`
come out once their rows exist. `src/public-compliance-paths.test.jsx` gains
the rule "a page slug is public on the organisation's hosts and nowhere
else".

**Reserved slugs.** `RESERVED_PAGE_SLUGS` in the offers module: every
top-level route segment under `src/app`, **walking into route groups** (so
`(sales)/contacts` reserves `contacts`), generated at test time from the
file tree and pinned, so a new route fails the test until the list is
updated, plus `api`, `_next`, `welcome`, `login`, `settings`, `admin`,
`offers`, `embed`, `tv`, `present`, `host`, `h`, `book`, `event`, `race`,
`deposit`, `legal`, `privacy`, `terms`. The route and the editor refuse them;
a unique index refuses a duplicate within the organisation.

### 6. Migration (one migration, then code)

Backfill, in SQL, from `landing_page_settings`:

- Each row → a `landing_pages` row: `kind='studio'`, `scope='one'`,
  `slug=public_path`, `primary_location_id=location_id`, `blocks` = the row's
  blocks with every offer block's studio half stripped out, `offer_type` =
  the type of the offer block TRIALFIRST made primary (`paid_trial` on both
  live rows; `none` if there is none), `publish_state` mapped (`hidden` →
  `draft`), `chrome` from the logo and chooser columns. One studio row per
  page from the stripped halves, `enabled=true`.
- `/trial` → one `campaign` page, `scope='all'`, `offer_type='paid_trial'`,
  two studio rows from the two `paid_trial` blocks, `enabled=true` where the
  block is sellable today. Its content blocks: a copy of Stillorgan's
  content blocks (what the route renders today). The `trial-purchases` return
  URL keeps `/trial?purchase=&studio=`.
- `/50plus` → `campaign`, `scope='one'`, Stillorgan, `offer_type='one_class'`
  from the `campaign_funnel` block; content blocks: the sections the block's
  `show_sections` chose, copied from Stillorgan's row.
- `/corp` → `campaign`, `scope='one'`, Hatch, `offer_type='promo_credits'`
  from the `corp_promo` block; content copied from Hatch's row.
- `/start`, `/free-class` → `retired`, `redirect_to='/trial?studio=stillorgan'`
  (keeping the query, as the routes do today). `/start/<path>` is served by
  the retired `start` row, which redirects anything under its slug (§2); the
  sub-path is dropped (acceptable; the campaigns are over).
- `?studio=hatch` (the live `/trial` key and the un1t.online checkout's
  success URL) is accepted as an alias of `hatch-street`;
  `TRIAL_RETURN_PATHS` is validated against page slugs.

The backfill is idempotent (`ON CONFLICT DO NOTHING` on slug) and copies the
current block JSON by value. The old table's offer blocks are left in place
(deprecated, unread). Apply the migration before the code deploys; run the
security advisors after.

Verification the migration owes: for each of the five live URLs, the words,
media and offer rendered before and after match (a script that fetches each
page in both builds and diffs the visible text and the `src`/`poster` urls).

### 7. The editor

`/settings/landing-page` becomes the **Pages list** (the mockup, 2026-10-30):
one table, columns Page (title + kind), Path, Studios (chip: the studio, or
"All studios · n of m on"), Offer (type · the plan name where one studio, "per
studio" where all), Status chip, Updated, Edit. "Front page" button opens the
chooser editor as today. "+ New page" opens a small form: title, path (live
availability check against reserved and existing), scope, studio (when one),
offer type, "start from" (blank, or copy another page's content blocks). It
creates a `draft` row and opens the editor.

The editor (`/settings/landing-page/<id>`) keeps `LandingPageSettingsForm`'s
shape: left column, right iframe at `/<slug>?edit=1&studio=<path>`. Changes:

- A **page header card** at the top of the left column: title, path (editable
  while draft; renaming a live page writes a `retired` + `redirect_to` row for
  the old slug, so old ad links keep working), status with Publish / Unpublish
  / Retire, scope read-only after creation.
- The **offer block is first** in the content list and pinned (not
  reorderable, not deletable; `none` pages have no such block). Opening it
  shows the page-level fields, then **one row per studio**: switch, the
  studio-level fields for the type with pickers against the studio's live
  catalogue (the existing Glofox plan picker, the un1t.online product read,
  the class-keyword field), a readiness chip (Ready / Needs a plan / Studio
  has no platform), and the attribution tag and lead source (editable,
  defaulted).
  **The merged 50+ block editor (`CampaignFunnelEdit`, #2256) is the model
  for every offer editor**, split in two rather than rewritten. Page half,
  unchanged: coach video, poster, eyebrow/heading/sub-copy, every step's
  words, consent text, the three expect cards, the three fallback messages.
  Studio half, moved into the studio row: the Glofox trial plan picker and
  the class keywords. Three of its fields go: the read-only "Page" (campaign
  key), replaced by the page's slug in the header card; "Sections shown"
  (`show_sections`), replaced by the page's own content blocks; and the
  duplicate-campaign-key warning, replaced by slug uniqueness. The same
  split applies to `paid_trial` (plan/product and price to the row),
  `class_funnel` (plan, keywords and typed timetable to the row) and
  `corp_promo` (promo key to the row).
- **The preview shows the offer layout, not a stub.** Today the campaign
  block renders as an editor stub with no preview of `/50plus`. With the
  preview iframe at `/<slug>?edit=1`, `EditModeOverlay` must wrap the offer
  layout (the hero card, the 50+ video-and-tiles hero, the expect strip) the
  way it wraps `BlockRenderer` blocks: clicking the hero selects the pinned
  offer block, and its headline, sub-copy and step words are inline-editable
  there. The booking card itself stays live (not intercepted), as the
  booking widget is today, so the operator can run a test booking from the
  editor.
- Content blocks below behave as today: add, reorder, duplicate, delete,
  inline edit in the preview. Media uploads go to the `branding` bucket under
  `pages/<page_id>/`, through the same routes with `page_id` in place of
  `location_id`; `check:location-scoping` is taught the page tables (the
  scope is the organisation and the page row).
- The **preview bar** gains "Previewing: Stillorgan ▾ / Hatch Street / Choose
  on page" for all-studios pages; it reloads the iframe with `&studio=`.
  `EditModeOverlay` gains nothing new beyond honouring the query.
- Saving stays the explicit Save button (`handleSave`, PUT) as today; this
  design does not add autosave.

### 8. Who may do what

- Pages list: anyone with `landing_page` at any studio sees the pages of
  their studios (scope one) and every all-studios page of the organisation.
- A `scope='one'` page: edit with `landing_page` at that studio (create,
  edit, publish, retire). Studio managers can make their own campaign pages.
- A `scope='all'` page: edit, publish, retire and every studio row require an
  **organisation admin** (`isActiveOrgAdmin`, the chooser's rule). Studio
  managers see it read-only. (My call: one owner per org-wide page is simpler
  and safer than letting each studio edit its row on a page whose words it
  does not own.)
- Routes: `getCurrentUser()` → the rule above → `validateBody` →
  `createServerClient()`. Detail routes 404 on a page outside the caller's
  organisation. `assertRowInOrg` for the page; `assertLocationAccess` for a
  one-studio page.
- The `landing_page` web permission keeps its name and mobile parity entry
  (web-only, as today).

### 9. Meta, SEO, attribution

- `noindex` is a `chrome` flag, default on for `campaign`, off for `studio`.
- The site pixel loads on every page as today. The per-studio dataset for
  server events comes from the resolved studio; `meta-pixel-paths.js` reads
  the page's primary studio for the extra browser pixel, so the Hatch page
  keeps its Hatch pixel.
- Attribution per studio row (`tag`, `lead_source`) replaces `LEAD_CAMPAIGNS`
  and the `campaign` query. The pipeline, ads report and Mia see the same
  values they see today for the migrated pages (the backfill copies them
  verbatim: `stillorgan-50plus` / `meta_50plus`, and the rest from
  `LEAD_CAMPAIGNS`).
- `VisitOriginCapture`, `funnel-event` and the WhatsApp confirmation keep
  working unchanged; they receive the slug in place of the campaign key.

## Constraints (CLAUDE.md, binding)

- New tables closed to clients (mig 677); every read and write is a
  service-role route; `check:location-scoping` must know the page tables and
  the helper that scopes them.
- Public routes stay rate-limited; never a capacity figure (PUBCAP.1); only
  `clientFields` reach the browser; the booking route re-validates the class
  against the picker's read.
- Glofox and un1t.online write rules unchanged (`interpretBookingResult`,
  `grantTrialBeforeBooking`, `un1t-online-write-ops.js` sole callers, the
  write guards). The new reader of per-studio offer config is the only change
  in those paths.
- Customer-facing copy operator-editable with defaults (every string the page
  shows is a block field with a default).
- Every `<button>` in a form typed; light-theme chip rules; `un1t-*` tokens;
  no `console.log`; `check:select-columns` will read the new tables once the
  migration is in `supabase/migrations`.
- Media: `compressImageForUpload` + `parseUploadResponse`; video via signed
  upload; `branding` bucket limits unchanged (`tests/branding-bucket-guard`
  must learn the new writer).
- Public-path gates: all four, with the compliance test extended; the in-code
  list stays as the edge fallback.
- Migration forward-only, applied before deploy, advisors run after; the old
  table deprecated, dropped later.
- A `studio` page's slug stays what the chooser, `next.config` pretty paths
  and `trial-studios.js` expect (`stillorgan`, `hatch-street`).

## Verification the builder owes

- Unit: `landing-page-offers` schemas and `configured()` per type; slug
  validation and the reserved list (pinned to `src/app` directories); the
  backfill SQL against a fixture of today's two live rows plus the three
  campaign blocks (run through the migration replay used by
  `check:select-columns`).
- Route tests: page resolution for each `publish_state`; `?studio=` on an
  all-studios page naming a disabled studio falls back to the picker; a one-
  studio page refuses a booking naming another studio; attribution never
  taken from the body; `not_configured` when the readiness rule fails.
- Editor tests: pages list filters by the caller's studios and org role; a
  studio manager cannot save an all-studios page; renaming a live slug leaves
  a retired redirect row; the preview iframe URL carries the chosen studio.
- Gates: `src/public-compliance-paths.test.jsx` for page slugs on and off
  tenant hosts; `check:location-scoping` green with the page tables;
  `check:route-guards`; the CI mirror.
- Before/after diff of the five live URLs (§6).
- Manual: one real booking through the migrated `/50plus` and one real
  purchase intent through `/trial` at each studio, in a quiet hour.

## Left to the builder

- Exact Zod shapes for each `offer` half, derived from today's block schemas.
- Edge cache mechanics for `public-pages-edge.js` and how the fallback list
  is kept honest.
- Whether reviews/stats on an all-studios page with no studio chosen show the
  first enabled studio or hide until chosen.
- The pages list's empty state and the "start from" copy helper's handling of
  media urls (copy the url, not the file, is fine: the bucket is public).
- Phasing of the PRs. A reasonable split: (1) tables + backfill + offers
  module + `[slug]` route rendering campaign pages from rows, old routes
  deleted, gates reading the DB; (2) the Pages list + editor changes; (3)
  studio pages and the chooser reading `landing_pages`, `/welcome/[location]`
  redirecting, old table deprecated. Each PR ships green with the live site
  unchanged for visitors.
