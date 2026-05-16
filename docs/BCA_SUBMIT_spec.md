# BCA Submit — feature spec

**Status:** draft (2026-05-16)
**Owner:** Richard
**Feature flag:** `locations.features.bca_submit.enabled` (per-location, OFF by default; on for CCFA only)
**Identifier prefix:** `BCA.x` in CLAUDE.md Done log

## Problem

CCF Autos imports UK vehicles for Irish resale. After each car is sold and invoiced, CCFA submits a 10-document pack to **BCA** to claim the UK VAT refund ("the UK VAT bag"). Today the pack is assembled ad-hoc in Gmail / Drive and emailed manually; there's no checklist, no audit trail of what was actually sent, and a car can be marked `completed` in the CRM before the claim is filed — which has happened, costing real money in deferred refunds.

This feature codifies the submission inside each car's profile, gates the `completed` transition on it, and produces an audit trail.

## Out of scope

- Tracking the BCA *response* (acceptance / rejection / queries). `cars.uk_vat_refund_received` already exists for the "money received" milestone — that stays a separate manual flip until we have BCA-side automation.
- OCR / auto-extraction of fields from uploaded docs.
- Generating the docs themselves. Operator uploads them.
- Multi-vehicle batch submissions. One car, one submission.

## User stories

1. As a CCFA operator, when I open a car's detail page I see a **BCA Submit** tab with 10 named upload slots. I drag each doc into its slot.
2. When all 10 are uploaded I press **Submit to BCA**. The system emails BCA with all 10 attached, records the submission, and shows me the timestamp + recipient + a "Resubmit" option for future revisions.
3. When I try to mark the car `completed`, the button is disabled with a tooltip pointing me at the BCA tab if no submission exists. After submission, the button is enabled.
4. As a master/owner at CCFA, I can edit the document slot **labels** and the **send-from / send-to email addresses** in the location's settings page without a deploy.
5. As an operator at any other location (UN1T Stillorgan / etc.), I never see this tab or these settings.

## Feature flag

Per-location flag in the existing `locations.features` JSONB column (same pattern as `car_processing`). New shape:

```json
{
  "bca_submit": {
    "enabled": true,
    "documents": [
      { "slug": "doc_01", "label": "Document 1 (placeholder)" },
      { "slug": "doc_02", "label": "Document 2 (placeholder)" },
      ...10 entries total
    ],
    "send_from": "vat-claims@ccfautos.com",
    "send_to": "vatclaims@bca.example",
    "subject_template": "BCA VAT claim — {{uk_reg}} ({{vin}})",
    "body_template": "Please find attached the 10-document pack for VAT claim on {{uk_reg}}, {{make}} {{model}} {{vehicle_year}}.\n\nThanks,\nCCF Autos"
  }
}
```

- `documents` is an **ordered array of exactly 10 entries**; UI enforces "must have all 10" before enabling Submit. Slugs are stable identifiers (`doc_01..doc_10`) so changing a label doesn't invalidate existing storage paths. Operators edit `label` only; slug is hidden.
- `send_from` validated as a Postmark-approved sender at the active server (Postmark refuses sends from un-approved addresses with a 422; we surface that error clearly).
- `send_to` is a plain email; we don't whitelist it — operator's responsibility.
- `subject_template` / `body_template` support merge vars: `{{uk_reg}}`, `{{irish_reg}}`, `{{vin}}`, `{{make}}`, `{{model}}`, `{{vehicle_year}}`, `{{buyer_name}}`, `{{xero_invoice_number}}`. Operator-editable.

Helper `getBcaConfig(location)` in `src/lib/bca.js` returns the config or `null` when the flag is off — every UI / API code path reads through this so the flag is a single point of control.

## Data model

New table `car_bca_submissions`:

```sql
CREATE TABLE car_bca_submissions (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  car_id               UUID NOT NULL REFERENCES cars(id) ON DELETE CASCADE,
  location_id          UUID NOT NULL REFERENCES locations(id) ON DELETE RESTRICT,

  -- snapshot of the email actually sent (audit; don't read from live config)
  email_from           TEXT NOT NULL,
  email_to             TEXT NOT NULL,
  email_subject        TEXT NOT NULL,
  email_body           TEXT NOT NULL,

  -- snapshot of which documents went out (slug -> source path + filename + size)
  -- plus the merged PDF that was actually emailed
  documents            JSONB NOT NULL,    -- [{slug, label, storage_path, filename, size_bytes, content_type}]
  merged_pdf_path      TEXT NOT NULL,     -- storage path of the merged+compressed PDF actually sent
  merged_pdf_size      INTEGER NOT NULL,  -- bytes; sanity-checked against Postmark's 10 MB cap before send

  submitted_by         UUID NOT NULL REFERENCES profiles(id) ON DELETE SET NULL,
  submitted_at         TIMESTAMPTZ NOT NULL DEFAULT now(),

  postmark_message_id  TEXT,              -- set on successful send
  postmark_error_code  INT,               -- non-null on failure
  postmark_error_msg   TEXT,

  superseded_by        UUID REFERENCES car_bca_submissions(id) ON DELETE SET NULL,
  superseded_at        TIMESTAMPTZ
);

CREATE INDEX idx_car_bca_submissions_car_active
  ON car_bca_submissions (car_id)
  WHERE superseded_at IS NULL;
```

**Resubmission model:** every submit creates a new row. The latest non-superseded row is "the active submission". When a new submission is created, the previous row's `superseded_at` + `superseded_by` are stamped in the same transaction. The completion gate checks for *any* successful (non-error) submission; resubmits don't lock the car back out.

**RLS:** location-scoped read for staff at that location (`profile_locations.profile_id = (SELECT auth.uid())`), write via service-role only (all writes go through the API route).

**Storage bucket:** `bca-documents` (private). Path: `{location_id}/{car_id}/{submission_id}/{slug}.{ext}`. Submission-ID-keyed so resubmits don't overwrite old docs (audit). RLS: location-scoped read, write via service-role.

**Upload-staging vs. submission:** uploads can happen before submit (operator stages docs). Staged uploads live at `{location_id}/{car_id}/_staging/{slug}.{ext}` and are referenced by a transient `car_bca_staged_uploads` table or just-in-time discovery via storage listing. On submit, the route copies staged files into the submission-id prefix, writes the submission row, and clears staging. (Decision: storage listing — no extra table — keeps it simple.)

## API

All routes are at `/api/cars/[id]/bca/*` and 404 when the car's location has `bca_submit.enabled = false`.

| Method | Route | Auth | Purpose |
|---|---|---|---|
| GET | `/api/cars/[id]/bca` | manager+ at location | Returns `{ config, staged: { slug -> {filename, size, signed_url} }, submissions: [{...}] }` |
| POST | `/api/cars/[id]/bca/uploads/[slug]` | manager+ at location | Multipart upload, writes to staging path, returns signed URL. Validates slug is in config. |
| DELETE | `/api/cars/[id]/bca/uploads/[slug]` | manager+ at location | Removes from staging. |
| POST | `/api/cars/[id]/bca/submit` | manager+ at location | Validates all 10 slugs have staged files, copies to submission prefix, sends Postmark email with attachments, writes submission row, supersedes previous. Returns submission record. |

Plus location-settings endpoints (master/owner only):

| Method | Route | Purpose |
|---|---|---|
| GET | `/api/locations/[id]/bca-config` | Returns current bca_submit config or default. |
| PUT | `/api/locations/[id]/bca-config` | Validates payload, writes `locations.features.bca_submit`. |

Settings UI lives at `/settings/locations/[id]/bca` (new page) — sits next to existing per-location sections like `BrandingSettings`.

## UI

### Car detail page

When `bca_submit.enabled` for the car's location, a new **BCA Submit** tab on the car detail page renders:

- Status banner at top: "Not submitted" (red) / "Submitted MM/DD — pending refund" (amber) / "VAT refunded" (green; reads from existing `cars.uk_vat_refund_received`).
- Below: 10 upload slots in a 2-column grid. Each slot shows the label, an upload control (drag-drop + click-to-browse), and — when staged — the filename, size, a preview icon, and a remove button.
- Submit button: enabled only when all 10 slots are filled. Click triggers a confirmation modal (recipient + send-from + 10-doc summary), then a spinner during the API call, then either success state (recipient + sent-at + message-id) or the Postmark error.
- "Submission history" accordion below the slot grid, listing prior submissions (collapsed by default).

### Settings page

`/settings/locations/[id]/bca`:

- Toggle: **Enable BCA Submit for this location**.
- Send-from email input (with hint "must be a Postmark-approved sender").
- Send-to email input.
- Subject template input with available-vars chip list.
- Body template textarea.
- Document slot labels: 10 inputs (label only; slug shown as a small badge). "Reset to default" button per slot.
- Save button. Validates everything client-side first, then PUTs.

### Car completion gate

When `bca_submit.enabled` at the car's location AND no active (non-superseded, non-error) submission exists, the "Mark as completed" button on car detail is disabled. Tooltip: "Submit the BCA pack first." Server-side validation on the status-change API does the same check — defence in depth.

## Email shape (Postmark) — single merged PDF attachment

Rather than sending 10 separate attachments and risking Postmark's 10 MB per-email cap, we **merge the 10 docs into one PDF, compress it, and send that as a single attachment**. Bonuses: BCA receives one tidy named file (`BCA_<uk_reg>_<submission_id>.pdf`) rather than a stack of `doc_03_v5c_photo.jpg` etc., and the audit trail is one canonical artefact.

### Merge pipeline

Server-side at submit time:

1. **Pull staged files** from Supabase Storage (10 of them, in slot order).
2. **Compress images** with `sharp` before embedding — resize to max 2000 px on the longest side, JPEG quality 80, strip EXIF. A 5 MB phone photo typically lands at 300–600 KB after this. PDFs pass through untouched (compression of PDFs without ghostscript is not reliable; their source is usually already reasonable).
3. **Merge with `pdf-lib`** — for each slot in order:
   - If the source is a PDF, copy all its pages into the merged doc.
   - If the source is a JPG/PNG (post-compression), embed it as a single page sized to A4 with the image centred + a small slot-label header.
4. **Save the merged PDF** to Supabase Storage at `{location_id}/{car_id}/{submission_id}/merged.pdf`.
5. **Attach to Postmark** as a single base64-encoded attachment named `BCA_<uk_reg or VIN>_<short_submission_id>.pdf`.

### Dependencies

Two new npm packages in `un1t-crm/package.json`:

- `pdf-lib` (^1.17.x) — pure JS, works on Vercel's serverless Node runtime without native binaries.
- `sharp` (^0.33.x) — Vercel ships a precompiled binary for the Node runtime; no buildpack work needed.

### Postmark call (reference shape, matches existing `xero/bills-email.js` pattern)

```js
await fetch('https://api.postmarkapp.com/email', {
  method: 'POST',
  headers: {
    'X-Postmark-Server-Token': process.env.POSTMARK_TRANSACTIONAL_TOKEN,
    'Content-Type': 'application/json',
    Accept: 'application/json',
  },
  body: JSON.stringify({
    From: config.send_from,
    To: config.send_to,
    Subject: renderTemplate(config.subject_template, car),
    TextBody: renderTemplate(config.body_template, car),
    Attachments: [{
      Name: `BCA_${car.uk_reg || car.vin}_${submissionShortId}.pdf`,
      Content: mergedPdfBuffer.toString('base64'),
      ContentType: 'application/pdf',
    }],
    MessageStream: 'outbound',
    TrackOpens: false,
    TrackLinks: 'None',
    Tag: 'bca-submit',
  }),
})
```

### Size guard

Post-merge size still validated against Postmark's 10 MB attachment cap. Realistic expected size after compression: 1.5–4 MB. If somehow over: reject the submit with a clear error showing the size, and suggest the operator manually compress the biggest source doc before retrying. We log per-slot input size + final merged size on the submission row so we can spot pathological cases.

### Sender approval

Sender must be on Postmark's approved-senders list for the active server. Operators editing `send_from` need to add it to Postmark first — settings page links out to Postmark's signature management with a hint.

## Phase plan

### Phase 1 — Schema + storage + settings (no submit, no gate)

- Migration 163: `car_bca_submissions` table, `bca-documents` storage bucket, RLS, default `bca_submit` config seeded into `ccf_autos` location's `features` JSONB.
- `src/lib/bca.js` with `getBcaConfig(location)` + the default 10-slot placeholder list.
- `/settings/locations/[id]/bca` settings page (operator can edit labels + email config).
- BCA Submit tab on car detail — renders the 10 upload slots, accepts uploads to staging, persists across reloads. **No submit button yet** (or a disabled "Coming soon" button).

Ships **immediately useful** — operators can stage docs against each car as they arrive, no more hunting through Drive when it's time to file.

### Phase 2 — Submit + merge + email + tracking

- Add deps: `pdf-lib`, `sharp`. Verify deploy on Vercel.
- New `src/lib/bca-merge.js` with `mergeAndCompressBcaPack(files)` → `Buffer`. Image-aware: PDFs pass through unchanged, JPG/PNG compressed via sharp then embedded as A4 pages.
- `/api/cars/[id]/bca/submit` route: validate all 10 staged → copy sources to submission prefix → merge + compress → save merged PDF to submission prefix → size-check → Postmark sendEmail with the merged PDF as the single attachment → write submission row → supersede previous.
- Submit button live on the BCA tab.
- Submission history accordion: per-submission row shows recipient, sent-at, merged-PDF size, message-ID, and a download link for the merged PDF.
- Postmark webhook tap: subscribe to Bounce + SpamComplaint events tagged `bca-submit` so a hard-bounce on the send-to address surfaces in the CRM (not just in Postmark's UI). Same shape as the campaign webhook handler.

Ships when phase 1 is stable.

### Phase 3 — Hard gate on car completion

- Server: car status-change route (`PUT /api/cars/[id]` or wherever) checks `bca_submit.enabled && !activeSubmission` → 422 with `code: bca_not_submitted`.
- Client: "Mark as completed" button disabled with tooltip.
- Tests cover: gate active when flag on + no submission; gate inactive when flag off; gate inactive when active submission exists; gate inactive when there are submissions all with `postmark_error_code` set (i.e. all failed — operator probably wants to be allowed to mark complete and fix the BCA send separately).

Ships when phase 2 is stable.

## Risks + edge cases

- **Postmark sender not approved.** Surface the 422 prominently on the settings page with a link to Postmark's signature page. Don't let an unapproved sender be saved without a warning.
- **Merged PDF still > 10 MB after compression.** Should be rare with sharp's defaults (2000 px / Q80) but possible if multiple source PDFs are themselves huge. Reject the submit with a per-slot size readout so the operator can manually compress the biggest one before retrying. Future enhancement: auto-rasterise oversize PDFs through `pdf-lib` + `sharp` as a fallback.
- **Source PDF is encrypted / password-protected.** `pdf-lib` throws on the copy step. Surface "Doc N is password-protected — please re-export without a password" rather than a generic error.
- **Sharp serverless cold start.** First-call after a deploy can add ~500 ms while the binary loads. Acceptable for a manual operator action; no caching needed.
- **Operator changes a slot label between staging + submit.** Staging is keyed by slug not label, so renames don't break anything. Submission row stores both slug + label snapshot, so the audit shows what the labels were *at the time of send*.
- **Operator removes a slot from the 10 in settings.** Not supported in MVP — always exactly 10. Settings UI validates the array length.
- **Resubmit while a previous submit is in-flight.** Submit endpoint takes an advisory lock on `car_id` to serialize. Concurrent calls return 409.
- **CCFA decides BCA wants 11 docs.** Future migration changes the config schema; settings UI keeps array-length validation in sync. Storage paths use slugs so renaming/reordering doesn't orphan files; adding a new slug just adds a new slot to the grid.

## Tests

Unit:
- `getBcaConfig(location)` returns null when flag off, defaults when flag on with no config, merged values when partial config.
- `renderTemplate(tmpl, car)` substitutes the documented merge vars and tolerates missing values (renders `{{vin}}` as empty string when null).
- `buildBcaEmail(submission, docs)` produces the right Postmark payload shape.

Integration:
- Submit with all 10 staged (mix of PDFs + JPGs) → row written, supersedes previous, email sent (Postmark mocked), merged PDF written to storage, page count = sum of source PDF pages + image slots.
- Submit with 9 staged → 422 with clear error.
- Submit where one source is a 5 MB phone JPG → merged PDF still under 10 MB after sharp compression.
- Submit with merged size > 10 MB → 422 with per-slot size breakdown.
- Submit with an encrypted source PDF → 422 with "doc N is password-protected".
- Submit when flag off → 404.
- Mark completed with flag on + no submission → 422.
- Mark completed with flag on + active submission → 200.
- Mark completed with flag off → 200 (gate inactive).

E2E (later):
- Operator uploads 10 docs, submits, sees success modal, BCA tab shows submission record, car completed button now enables.

## CLAUDE.md updates on ship

Done entry: `BCA.1 — CCFA BCA submit workflow (10-doc upload + Postmark email + completion gate)` with the mig 163 SQL summary + the per-location config shape + the storage path convention + the resubmission semantics.

Lessons learned candidates (only the ones that bite us during build):
- Postmark attachment 10 MB cap pattern + merged-PDF-via-pdf-lib-and-sharp workaround.
- Per-location JSONB config + helper-function gating pattern (worth documenting if it's the third feature to use it after `car_processing` and `branding`).
- Storage-path-keyed-by-submission-id pattern for audit-trail uploads (vs overwriting on resubmit).
- `sharp` on Vercel Node runtime — ships precompiled, no extra build config; cold-start adds ~500 ms.

---

**Next step:** kick off Phase 1 — author migration 163 + the settings page + the BCA tab on car detail with staging-only uploads. Estimated effort: half a day. Ship gates phase 2 + 3.
