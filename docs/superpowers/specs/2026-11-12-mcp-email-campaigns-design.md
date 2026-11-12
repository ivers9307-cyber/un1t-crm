# Email campaigns from an agent (MCPEMAIL.1) — design

Branched off `origin/main` at `245f02254`. Builds on
[`2026-11-01-mcp-server-design.md`](2026-11-01-mcp-server-design.md) and
[`2026-11-10-mcp-access-decouple-design.md`](2026-11-10-mcp-access-decouple-design.md).
It reverses one MCP.1 constraint on purpose: MCP.1 said no tool touches email.
This adds a fenced set of tools that do.

## Why

The staff MCP server went live on 12 Nov 2026 (first calls from Claude Code and
Claude Desktop, logged against the right studios). Today it reads the roster,
contacts, pipeline and classes and makes three small writes. Richard wants the
people who already send marketing email from the CRM to be able to do the whole
job from Claude: write the email, pick who gets it, choose the send options,
then schedule or send it.

## What it does, in the person's words

1. "Draft an email to Stillorgan members who haven't booked in 30 days about
   the Christmas timetable." Claude writes a subject and body, picks or builds
   the audience, and saves a **draft campaign** in the CRM.
2. Claude reports the head count: how many match, and how many will actually
   receive it after consent, bounces and suppressions.
3. The person says when it should go (now, or a date and time on the studio's
   clock). Claude sends a **test** to the person's own login email. The test
   shows the email as a member will see it, and above it a banner with the
   audience size, the timing, and an **approve link**.
4. The person reads the test and follows the link to a confirm page in the
   CRM, signed in as themselves, and presses **Send to 412 people** (or
   **Schedule for …**). Claude cannot press it.
5. Later, Claude can list campaigns, show results, cancel a scheduled one,
   move its time (which needs a fresh test and approval), or edit a draft.

## Decisions Richard made (12 Nov 2026)

| Question | Decision |
|---|---|
| What must happen before an email goes out | Preview, then a separate confirm step |
| How firm the confirm is | First choice was a code in the test email. Changed the same day to an **approve link to a confirm page in the CRM**, because Claude could read a code from a connected mailbox |
| Who can do it | The same people who can send campaigns at that studio in the CRM, with Connect an Agent |
| How the body is built | Claude writes subject and body; the CRM wraps it in the studio's branded layout, footer and unsubscribe link |
| Audience | A saved segment, or new filters from the CRM's audience builder |
| Send options in v1 | Send now or schedule; from name and reply-to; preview text |
| Body content | Text, buttons, and images already in the CRM library. No uploads from Claude |
| Afterwards | See results; list and find campaigns; cancel or reschedule; edit a draft later |

Subject A/B testing was offered and **not** chosen for v1.

## Goals

- A campaign made from Claude is an ordinary `campaigns` row. It shows in the
  CRM's campaign list, runs through the same queue (`run-campaigns` cron,
  `tickCampaignSend`), and obeys the same monthly cap, wallet check, frequency
  cap, consent rules and unsubscribe footer as one made in the CRM.
- **No tool can send or schedule a campaign.** The only way out of `draft` for
  an agent-prepared send is the person's own press on the CRM confirm page,
  for **exactly the content, audience and timing that were tested**.
- Every tool passes through the existing MCP door (`runTool`: rate limit,
  `resolveStudio` on `mcp_access`, the org switch, one `mcp_tool_calls` row).

## Non-goals (v1)

- Subject A/B tests, the `outbound` stream, sequences, WhatsApp, SMS, host
  campaigns, email templates, saved-segment creation or editing.
- Uploading images, or any image URL that is not in the studio's library.
- Free-form HTML from the agent.
- Exposing these tools to the in-app assistant (the second door). They are not
  added to `BRIDGED_TOOL_NAMES`.
- Recipient-level data. No tool returns who received, opened or clicked, and no
  tool reads `email_sends` (the guard's `FORBIDDEN_TABLE` stays as it is).

## Anti-goals

- An email reaching members that was released by a tool call, by an approval
  for different content, or by an approval issued to another person.
- A marketing email without the unsubscribe footer, or sent on the
  transactional stream.
- A second copy of the send rules that can drift from the CRM's.
- A failed or partial release that reports success.

## The tools

All live in `src/lib/agent-tools/`, use `defineTool`, take the optional
`studio_id`, and share one gate: **`hasPermissionForLocation(user, studio.id,
'email')`** (the key the CRM's send route checks). All nine are listed in
`index.js`. Names are the builder's to adjust if a clash appears.

| Tool | Input | Does |
|---|---|---|
| `list_email_segments` | — | Saved segments at the studio: `id, name, description`. Read through `canReadSegmentsAt`. |
| `count_email_audience` | `segment_id` **or** `filter` | Counts only: matched, eligible, not opted in, bounced or complained, suppressed. Uses `validateAudienceFilter` and `buildEligibleAudienceQuery` (channel `email`). The description lists the filter fields and operators from `AUDIENCE_FIELDS`. |
| `list_email_images` | — | Images in the CRM library **at this studio**: `url, name`. From `listLandingMediaForUser`, kind `image`, filtered to `location_id = studio`. |
| `create_email_draft` | `name, subject, preview_text?, from_name?, reply_to?, blocks, segment_id? \| filter?` | Inserts a `draft` campaign. |
| `update_email_draft` | `campaign_id` + any of the above | Edits a campaign in `draft` or `scheduled`. Any change voids an unused approval, and an edit to a `scheduled` campaign puts it back to `draft` (see below). |
| `get_email_campaign` | `campaign_id` | Fields, status, schedule, the blocks if agent-written, the live audience counts, and results once sending has started. |
| `list_email_campaigns` | `status?` | Up to 50 at the studio, newest first: `id, name, subject, status, scheduled_at, created_via`, headline results. |
| `send_email_for_approval` | `campaign_id, send_at?` | Sends the test to the caller's own login email with the approve link for that timing. Returns the masked address, the audience counts, the timing and the address it will send as. Never returns the link or its token. Also the way to **reschedule** a scheduled campaign. |
| `cancel_email_campaign` | `campaign_id` | Scheduled → back to draft. Queued or sending → requests a stop. No approval needed. |

A campaign id from another studio, another tenant, or a random uuid answers the
same `not_found`.

### Body: blocks, rendered by the server

The agent never supplies HTML. `blocks` is an ordered list (cap 60) of:

- `heading` — text, level 1 or 2
- `paragraph` — text with a small inline set: bold, italic, link
- `list` — items, bulleted or numbered
- `button` — label and URL
- `image` — a URL that **must** be one `list_email_images` returns for this
  studio, plus alt text
- `divider`

Rules, checked at save: every URL is `https`; merge tags must be in
`OFFERED_MERGE_TAGS` (`src/lib/merge-tags.js`), an unknown `{{tag}}` is
`invalid_input`; text is escaped by the renderer; subject ≤ 200 characters.

A new server module (suggested `src/lib/agent-email-render.js`) turns blocks
into email HTML inside a plain branded shell: the studio's logo and company
name from `getLocationBranding`, a single 600px column, neutral colours. It
writes `campaigns.html_content`. The unsubscribe footer, view-in-browser link
and preheader are **not** added here; the sender already adds them at send time.

The blocks are also stored on the campaign (new column `agent_blocks jsonb`) so
a draft can be edited later from Claude. `design_json` stays null, so the web
editor opens such a campaign in its code view; that is accepted for v1.

If someone edits the campaign in the CRM afterwards, `html_content` no longer
matches the blocks. `update_email_draft` detects that (render the stored blocks
and compare) and refuses a **body** edit with a plain message to edit it in the
CRM. Subject, audience and options can still be changed.

### Audience

`segment_id` copies that segment's filter into `audience_filter` at save, which
is how the CRM does it (a campaign stores no segment id). `filter` is the
existing `audienceFilterSchema` shape, validated with `validateAudienceFilter`.
Exactly one of the two is required before a test can be sent. A draft may be
saved without an audience.

Counts are always the **eligible** figure next to the matched figure, so the
person sees how many are dropped for consent or bounces. The frequency cap is
applied by the sender per recipient and is not in the count; the tool says so.

### Send options

- `from_name` — free text ≤ 100.
- `reply_to` — must be on the studio's verified sending domain
  (`describeFromAddress` in `src/lib/from-address.js` gives the domain).
- `from_email` is **not** settable from an agent. The studio default applies.
- `preview_text` ≤ 500.
- `postmark_stream` is always `broadcast`.
- `send_at` is a wall-clock time in the studio's zone (`YYYY-MM-DDTHH:mm`),
  converted with `zonedWallClockToInstant`. It must be in the future and no
  more than 90 days out. Omitted means send as soon as it is approved. It is
  an input of `send_email_for_approval`, so the person approves the timing
  along with the content.

## The approval

Nothing in `/api/mcp` can move a campaign out of `draft`. Release is a normal
signed-in CRM action that the agent can only set up.

New table, service-role only (RLS on, no policy, `REVOKE ALL … FROM anon,
authenticated`), suggested name `campaign_release_approvals`:

`id, campaign_id (FK, cascade), profile_id, token_hash, content_key,
audience_eligible, send_at (null = now), expires_at, used_at, created_at`.

- **Issued by** `send_email_for_approval`: a 32-byte random token, stored only
  as a sha256 hash, valid 24 hours. Issuing a new one voids earlier unused
  approvals for that campaign. At most 5 per campaign per hour.
- **Bound to content.** `content_key` is a hash over `location_id, subject,
  preview_text, from_name, reply_to, html_content, audience_filter`, the
  pattern `signedContentKey` uses in `src/lib/whatsapp-blast-signoff.js`. On
  the confirm page the key is recomputed from the row; a mismatch means the
  campaign changed since the test, and the page says to ask for a new test.
- **Bound to the person.** Only the profile it was issued to can use it. For
  anyone else the page is the ordinary not-found.
- **Bound to the timing.** `send_at` is stored on the approval and shown on
  the page; the page cannot change it. A `send_at` that has passed by the time
  the person presses is refused with "ask for a new test".
- **Single use.**
- **Delivered only by email**, to the caller's own login address (never an
  address passed in). The link sits in a banner above the email body with: the
  studio, the eligible head count, the address it sends as, and the timing.
  The subject is prefixed `[TEST]`.
- The test renders the body through the **same four steps the real send uses**
  (`applyMergeTags`, `appendUnsubscribeFooter`, `prependViewInBrowserLink`,
  `injectPreheader`), so what is tested is what is sent. The existing
  `/api/campaigns/[id]/send-test` route skips three of those steps; that route
  is left alone.

### The confirm page

A page inside the signed-in app (suggested `/communications/campaigns/approve/[token]`),
**not** on any public allowlist: a signed-out visitor goes through `/login` and
comes back. It shows the campaign name, subject, studio, the address it sends
as, the timing, the head count from the test and the head count now, and one
button: **Send to N people now** or **Schedule for <date and time>**. A link to
open the campaign in the CRM sits beside it.

The button posts to a new session route (cookie auth; the proxy already refuses
an OAuth-issued token on every `/api` path but `/api/mcp`, and this route must
not be made proxy-public). The route checks, in order: the approval (person,
expiry, unused, content key, timing); the `email` permission at the campaign's
studio; status is `draft` or `scheduled`; subject and body present; an audience
is set and its eligible count is above zero; the audience has not grown past
what was tested (below); `getEmailCapStatus`; `checkSpend`. Then one
compare-and-set update on status to `queued` or `scheduled`, judged on the rows
it touched; zero rows is a conflict. The approval is marked used only after
that write succeeds.

`get_email_campaign` reports whether an approval is waiting, so Claude can tell
the person "the test is in your inbox, waiting for you".

### Calls made while writing this up (Claude's, not Richard's)

- **Editing a scheduled campaign from Claude un-schedules it.** The approval
  is already spent by then and the cron promotes `scheduled` to `queued`
  with no approval check, so an edit would otherwise send untested content.
  `update_email_draft` on a `scheduled` campaign writes the change and the
  status back to `draft` in one compare-and-set update, and says so in its
  result. Sending it needs a new test and approval. An edit made by a person in the
  CRM's own editor is outside this fence: that is the existing, logged-in path
  and is unchanged.
- **The head count is part of what is approved, loosely.** The approval row
  stores the eligible count shown in the test banner. The confirm route refuses when the
  fresh eligible count is more than 10% **and** more than 25 people above it,
  with "the audience has grown from N to M; send a new test". A smaller or
  equal audience passes. Nothing re-checks at the scheduled send time; the
  result of a scheduled release says the final count is taken when it sends.
- **Test links are placeholders.** The test email's unsubscribe, preferences
  and view-in-browser links never act on a real contact, even when the caller
  has a contact row at the studio. The four send-time steps still run, fed
  placeholder URLs, so the footer and preheader appear as they will for a
  member. Merge tags use the caller's name and email.
- **`failed` campaigns are out of v1.** A failed campaign may be part-sent.
  The tools can show it and its error, but cannot edit or release it; the
  message points to the CRM.

- **An agent cannot email a whole studio with an empty filter.** A filter with
  no rows matches everyone at the studio; from an agent it is refused, at save
  and at test. The person names at least one filter or uses a saved segment.
- **Approvals record being voided separately from being used** (`voided_at`
  beside `used_at`), so the confirm page can say which happened.

### One set of send rules

The status, subject/body, cap and wallet checks live inline in
`src/app/api/campaigns/[id]/send/route.js` and the schedule route today, and
the send route's update has no status compare-and-set. They move into one lib
module (suggested `src/lib/campaign-release.js`) that the confirm route and
both existing routes call, so there is one copy and the route gains the compare-and-set. Route
behaviour and messages otherwise stay the same.

## Data changes (one migration, next free number after 826)

- `campaign_release_approvals` as above.
- `campaigns.agent_blocks jsonb` (nullable).
- `campaigns.created_via text NOT NULL DEFAULT 'web'`, set to `'mcp'` by
  `create_email_draft`, shown as a small "Made in Claude" marker in the CRM's
  campaign list.

`created_by` is the person, as for any campaign. Each tool call already leaves
a `mcp_tool_calls` row (no arguments, no results).

## Constraints the builder must hold

- The two-doors invariant in CLAUDE.md: a tool body takes studio and person
  from `ctx`, never asks the door's question.
- `tests/agent-tools-guard.test.js` must pass unchanged in spirit: every
  `.from()` in a tool file carries a studio filter; `email_*` tables stay
  forbidden. Results come from the campaign row's counters and
  `loadCampaignRecipientStats` called **only with ids already scoped to the
  studio** (its RPC has no tenant filter).
- Service-role writes: `await`, destructure `error`, and judge rows touched
  where the row must exist.
- Customer-facing copy in the shell and the test banner follows the
  operator-editable rule where a setting already exists (company name, logo);
  new fixed copy is limited to the test banner, which only staff see.
- CLAUDE.md's MCP invariant bullet and `INTEGRATIONS.md` § Staff MCP server are
  updated to say email is now in scope and how it is fenced.

## Known limits, stated plainly

- **The approval proves a signed-in CRM session pressed the button.** An
  agent that drives the person's own logged-in browser could press it too.
  That is the same reach as the CRM's own Send button and is out of scope.
- The CRM's own test-send route needs an admin role while the real send needs
  only the `email` permission. This design uses `email` for both, matching the
  real send. The route's mismatch is not fixed here.
- The `run-campaigns` cron does not re-check the wallet when it promotes a
  scheduled campaign. Unchanged here.
- An agent-written campaign opens in the web editor's code view.

## Left to the builder

File and function names, the shell's exact HTML, the inline-formatting syntax
for paragraphs, test layout, the confirm page's layout, how the "Made in Claude" marker looks, and whether
the count breakdown reuses the audience-count route's code or a shared helper.

## Rollout

Migration before deploy. Ships switched on for anyone holding `email` and
`mcp_access` at a studio whose organisation has MCP on; today that is Richard
and Garrett. First real use: one small audience at Test Studio, then one at
Stillorgan.
