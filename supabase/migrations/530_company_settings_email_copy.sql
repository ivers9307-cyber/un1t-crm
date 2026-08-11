-- 530 — K7: make the hosted-copy email strings operator-editable.
--
-- ⚠️ NOT APPLIED. Written and reviewed only — apply via Supabase MCP against
--    project iyvtbjjxdggiadzwwvdj, then run get_advisors (security).
--
-- THE INVARIANT
-- Customer-facing copy is operator-editable (a settings field with a default
-- fallback), never hard-coded. WEBVIEW.1 shipped two strings that a recipient
-- reads — the "view in browser" link label at the top of every broadcast, and
-- the note at the foot of the hosted copy explaining why there is no personal
-- unsubscribe link on it — as constants in src/lib/campaign-web-view.js. They
-- were deliberately collected in one export so this wiring would be small.
--
-- WHY NULLABLE WITH NO DEFAULT
-- NULL means "use the code-side default". The alternative — a column DEFAULT
-- carrying the English string — would copy the wording into the schema, where
-- it would silently go stale against src/lib/campaign-web-view.js the first
-- time someone edited one and not the other, and would leave every existing
-- row needing a backfill to say what it already means. With NULL there is no
-- backfill, no second copy of the wording, and a location that never opens the
-- settings card renders exactly what it renders today.
--
-- resolveEmailCopy() falls back per FIELD and treats a whitespace-only value
-- as unset, so clearing the box in the UI restores the default rather than
-- shipping an empty, unclickable link label.
--
-- Length caps are generous but real: these sit in a 7pt one-line footer, and
-- an unbounded text column on a string that goes into every recipient's inbox
-- is an invitation to paste an essay into it.
--
-- Follows mig 514 (send_quiet_hours_*), the established shape for a
-- per-location operator-editable setting on this table.

alter table company_settings
  add column if not exists view_in_browser_label text,
  add column if not exists hosted_copy_note      text;

alter table company_settings
  add constraint company_settings_view_in_browser_label_len
  check (view_in_browser_label is null or char_length(view_in_browser_label) <= 120);

alter table company_settings
  add constraint company_settings_hosted_copy_note_len
  check (hosted_copy_note is null or char_length(hosted_copy_note) <= 400);

comment on column company_settings.view_in_browser_label is
  'K7 (mig 530). Operator-editable label for the "view in browser" link prepended to every broadcast email (WEBVIEW.1). NULL = use DEFAULT_VIEW_IN_BROWSER_LABEL from src/lib/campaign-web-view.js; the default deliberately lives in code, not in a column DEFAULT, so there is only one copy of the wording. Resolved by resolveEmailCopy(); HTML-escaped at render.';

comment on column company_settings.hosted_copy_note is
  'K7 (mig 530). Operator-editable note at the foot of the hosted (web) copy of a campaign, explaining that it carries no personal unsubscribe link. NULL = use DEFAULT_HOSTED_COPY_NOTE from src/lib/campaign-web-view.js. Resolved by resolveEmailCopy(); HTML-escaped at render.';
