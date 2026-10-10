-- 715 — W1.B1: the SHORT brand an organisation uses in product names.
-- "UN1T Points" must stay "UN1T Points" while the org's brand name is
-- "UN1T Dublin" and a studio's is "UN1T Hatch Street": productName() in
-- shared/brand-name.js reads org_settings.short_name, falling back to the
-- org brand name. Operator-editable at /settings/locations/[id] → Organisation
-- branding (customer-facing copy is never hard-coded). Safe before deploy.
alter table public.org_settings
  add column if not exists short_name text
    check (short_name is null or (length(short_name) between 1 and 40));
comment on column public.org_settings.short_name is
  'W1.B1 (mig 715) — short wordmark for product names ("UN1T" → "UN1T Points"); NULL = use company_name.';
-- Data step (orchestrator, after apply): UN1T Group keeps "UN1T Points".
update public.org_settings set short_name = 'UN1T'
 where organization_id = 'f117b7b8-5f56-4f80-8299-2c698242e4d2' and short_name is null;
