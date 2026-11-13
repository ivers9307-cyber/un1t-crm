# Email campaigns from an agent, round two (MCPEMAIL.2) — design

Branched off `origin/main` at `50bbcec67`. Builds on
[`2026-11-12-mcp-email-campaigns-design.md`](2026-11-12-mcp-email-campaigns-design.md)
(MCPEMAIL.1, PR #2356, live since 12 Nov 2026). Everything that design fixes
still holds unless this one says otherwise. Above all: **no tool sends or
schedules**; the signed-in press on the approve page is the only release.

## Why

MCPEMAIL.1 shipped and passed two live sends (12 and 13 Nov 2026). Richard
then asked what Claude still could not do that the CRM can, and chose five
things for this round (13 Nov 2026): duplicate a past campaign, resend to
non-openers, show a sample of the audience, create and edit segments, and
start from a saved template.

## Decisions Richard made (13 Nov 2026)

| Question | Decision |
|---|---|
| Which features this round | Duplicate, resend to non-openers, audience sample, create/edit segments, start from a saved template |
| Subject A/B test | Not this round |
| How a resend is set up | **Approved with the first send.** Claude sets the resend on the draft; the test email and approve page show it; one press approves both sends |

## Calls made in the conversation (Claude's, stated to Richard, not objected to)

- A duplicate of a Claude-written campaign stays body-editable from Claude; a
  duplicate of a CRM-built one is editable from Claude only in subject,
  audience, options and timing (the existing "edited in the CRM" rule).
- The audience sample is masked, at most 50 rows, using the CRM's own
  audience-preview masking.
- Starting from a template copies its design; the body is then editable in
  the CRM only.
- Claude may create segments, and edit a segment only when no sequence starts
  from it. Editing one a sequence uses would change who that sequence emails
  with nobody approving it; Claude refuses and points to the CRM.

## Goals

- Five new abilities through the same MCP door and the same `email`
  permission gate as MCPEMAIL.1.
- Every send these tools set up, a resend included, is covered by the one
  signed-in approval, and the approval binds what will go out.
- **Close a gap found while designing this:** the resend settings
  (`resend_enabled`, `resend_wait_hours`, `resend_subject`) are not in the
  approval content key today, so a resend switched on in the CRM after an
  approval would still go out. They join the key.

## Non-goals

Subject A/B tests; image uploads; editing a CRM-built body from Claude;
creating or editing email templates; deleting segments; resending a resend;
the in-app assistant (still not bridged).

## Anti-goals

- A second send reaching members that the person did not see on the approve
  page.
- A segment change from Claude that alters a live sequence's audience.
- Showing full email addresses or phone numbers to the agent.

## The tools

Same rules as MCPEMAIL.1: `defineTool`, optional `studio_id`, gate
`hasPermissionForLocation(user, studio.id, 'email')`, studio and person from
`ctx`, the same `not_found` for another studio's id and a random uuid,
named columns, writes awaited and judged. Names are the builder's to adjust.

### 1. `duplicate_email_campaign` `{ campaign_id, name? }`

Copies a campaign at the studio as a new `draft`, using the CRM's own
`buildCampaignDuplicate` (`src/app/api/campaigns/[id]/duplicate/route.js`),
then stamps `created_via: 'mcp'`. Name defaults to the CRM's "Copy of …".

- Copies `agent_blocks` as it was, so a Claude-written original stays
  body-editable (its html hash still matches). A CRM-built original has
  `agent_blocks` null, so `update_email_draft` already refuses a body edit.
- Never copies `parent_campaign_id`, A/B fields, `scheduled_at`, results or
  the resend settings. A duplicate starts with no resend.
- Any source status is allowed (duplicating last month's sent campaign is
  the point).
- **A source that is not on the marketing stream is refused** ("this is a
  service email; duplicate it in the CRM"). Forcing it onto the marketing
  stream would move it from one consent family to the other, which is a
  consent decision no tool should make; copying it as-is would give a draft
  Claude can never send. (Claude's call; see the list at the end.)
- A source's own `from_email` is copied as the CRM's duplicate does. The
  tools still never set one, but a copied one is shown as "sends as" in the
  result, the test email and the approve page, and is bound by the approval.
  (Claude's call.)
- The result says whether the body can be edited from Claude.

### 2. Resend on the draft (extends `create_email_draft` / `update_email_draft`)

New optional input `resend: { after_hours, subject? } | null` (null switches
it off). `after_hours` is 1 to 168, as the CRM's CHECK. Writes
`resend_enabled`, `resend_wait_hours`, `resend_subject`. The subject is
validated like a campaign subject (exact merge tags, at most 200
characters).

- `resend_enabled`, `resend_wait_hours` and `resend_subject` join
  `APPROVAL_CONTENT_FIELDS` and both column lists. The guard test that pins
  the lists keeps them in step.
- The test email banner and the approve page show the resend:
  "Then resends to people who did not open it, N hours after it sends,
  with the subject …". The approve button label says so too.
- Nothing else changes about how the resend runs: the existing cron
  (`spawnDueResends`) creates the child and sends it, re-checking consent and
  suppression at the last moment. The approval covered it.
- Allowed only on the marketing stream (it always is from Claude) and only on
  a campaign that is not itself a resend.
- `get_email_campaign` reports the resend settings, and once the child
  exists, its id and results.
- `cancel_email_campaign` on a sent parent with a pending resend switches
  the resend off, mirroring the CRM's `DELETE …/resend`. If the child has
  started, it says to cancel the child instead.

### 3. `sample_email_audience` `{ segment_id? | filter? | campaign_id? }`

Up to 50 masked rows of the eligible audience (who would actually receive
it), through the CRM's audience-preview code (`src/lib/audience-preview.js`:
`maskEmail`, `toPreviewRow`, `PREVIEW_MAX_PAGE_SIZE`). Each row: first name,
masked email, pipeline stage. No phone, no contact id. The same "filter with
no rows is refused" rule. Returns the head count beside the sample and says
it is a sample.

### 4. Segments: `create_email_segment` and `update_email_segment`

- Create `{ name, description?, filter }`: validated exactly as the CRM's
  segment route does (`audienceFilterRefusal`), gated also on
  `canWriteSegmentsAt`, stamped with the studio and the person.
- Update `{ segment_id, name?, description?, filter? }`: refused with a
  sentence pointing to the CRM when `countSequencesUsingSegment` is above
  zero, and refused (never "zero") when that count cannot be read.
- No delete.
- A campaign still copies a segment's filter when it is chosen (MCPEMAIL.1),
  so editing a segment never changes a campaign already drafted from it.

### 5. Templates: `list_email_templates` and `create_email_draft_from_template`

- List: the studio's marketing templates: `id, name, subject, category,
  description`. Templates have no organisation column, so there are no
  organisation-wide ones. **Left out:** category `transactional` or
  `reminder`, and any template a booking or event points at as its
  confirmation or reminder email (`confirmation_email_template_id`,
  `reminder_email_template_id`, migs 044, 077, 385). Those carry
  booking- or event-specific merge tags a campaign cannot fill in.
  (Claude's call.)
- Create from template `{ template_id, name, subject?, preview_text?,
  from_name?, reply_to?, segment_id? | filter?, resend? }`: copies the
  template's `html_content` and `design_json` into a new `draft` with
  `agent_blocks: null`, `created_via: 'mcp'`. Subject defaults to the
  template's.
- The body is then editable in the CRM only, which the existing rule already
  enforces and `get_email_campaign` already reports.
- **The copied body's merge tags are checked** against the tags a campaign
  fills in (`OFFERED_MERGE_TAGS`, exact `{{name}}`), and the template is
  refused with the unknown tags named if any is found, so members never
  receive raw placeholders. Same check on create-from-template and on the
  same template's subject. (Claude's call.)
- The same stream rule as duplicate does not arise: a template has no
  stream, and the draft is always on the marketing stream.

`email_templates` and `email_sequences` match the tool guard's forbidden
`email_*` pattern. Reads of them go through lib helpers outside
`src/lib/agent-tools/`, and the guard gets an explicit, reasoned allow entry
for those helpers rather than silence.

## The approval, extended

- Content key: 13 fields become 16 (`resend_enabled`, `resend_wait_hours`,
  `resend_subject`). A key computed before this change no longer matches, so
  any approval waiting at deploy time is refused with "ask for a new test".
  That is acceptable; say so in the PR.
- The release preflight is unchanged. The resend child is not a separate
  release; it is the cron acting on what was approved.
- The approve page's growth check covers the first send only; the resend's
  audience is the non-openers of the first, by construction smaller.

## Constraints

- Two-doors invariant; none of the new tools bridged to the assistant.
- No new migration expected (every column exists). If one turns out to be
  needed, the house rules for migrations apply.
- The guard test that no tool releases a campaign keeps passing; the new
  write tools write `status: 'draft'` only.

## Known limits

- A resend's subject is approved, but its audience size is not known at
  approval time (it depends on who opens).
- Duplicating a CRM-built campaign gives Claude a draft whose body it cannot
  change.

## Calls Claude made after the reviewer read the design

1. Duplicate refuses a source that is not on the marketing stream.
2. Duplicate copies a source's own from address, shown and approved.
3. The template list leaves out transactional and reminder templates and
   any template used as a booking or event confirmation or reminder.
4. A template whose body or subject carries a merge tag a campaign cannot
   fill is refused, with the tags named.
5. Controller rulings made during the build: duplicate's
   `buildCampaignDuplicate` moved to `src/lib/campaign-duplicate.js`, imported
   by the route and the tool.
6. The release button label appends ", then resend" to the existing label.
7. `resendSummary` is null when the wait hours are missing.
8. A resend child is found on any sent root campaign whatever the parent's
   flag, and cancel refuses once it exists.
9. Templates used by sequence steps stay listable.

## Left to the builder

Tool names; output shapes beyond what is listed; the exact banner and
approve-page wording for the resend (plain, one sentence); whether the
template list includes organisation-wide templates (follow what the CRM's
own template picker shows).

## Rollout

No migration expected. After deploy: duplicate the 13 Nov test campaign,
add a resend after 1 hour, send it for approval to Richard only, approve,
and confirm the child is created and sent only if the first was not opened.
Then the real send to the names Richard gives.
