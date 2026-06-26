-- 314 — Atomic counter RPCs (P1-4, estate-audit theme #5).
--
-- Replaces non-atomic read-modify-write counter updates (read col → +1 in JS
-- → write back), which lose increments under concurrent writers. Extends the
-- existing increment_* family (see 065_sms_delivery_tracking.sql). Each
-- function is a minimal atomic UPDATE; dedup/idempotency stays in the callers
-- (e.g. the WhatsApp status webhook already guards on status transitions).
--
-- COALESCE on every counter (whatsapp_broadcasts.total_* are nullable, so a
-- bare `col + 1` on a NULL would silently lose the increment — matches the old
-- JS `(x || 0) + 1`). search_path pinned to '' (functions schema-qualify every
-- object) to satisfy the function_search_path_mutable linter. SECURITY INVOKER
-- (default): all callers use the service-role client.

-- 1. WhatsApp broadcast metrics. CASE-whitelisted; unknown metric raises.
create or replace function increment_whatsapp_broadcast_metric(p_broadcast_id uuid, p_metric text, p_delta int default 1)
returns void language plpgsql set search_path = '' as $$
begin
  if p_metric not in ('total_sent','total_delivered','total_read','total_failed') then
    raise exception 'increment_whatsapp_broadcast_metric: unknown metric %', p_metric;
  end if;
  update public.whatsapp_broadcasts set
    total_sent      = coalesce(total_sent,0)      + (case when p_metric='total_sent'      then p_delta else 0 end),
    total_delivered = coalesce(total_delivered,0) + (case when p_metric='total_delivered' then p_delta else 0 end),
    total_read      = coalesce(total_read,0)      + (case when p_metric='total_read'      then p_delta else 0 end),
    total_failed    = coalesce(total_failed,0)    + (case when p_metric='total_failed'    then p_delta else 0 end)
  where id = p_broadcast_id;
end $$;

-- 2. WhatsApp template send counter.
create or replace function increment_whatsapp_template_sent(p_template_id uuid, p_delta int default 1)
returns void language sql set search_path = '' as $$
  update public.whatsapp_templates set total_sent = coalesce(total_sent,0) + p_delta where id = p_template_id;
$$;

-- 3 + 4. Conversation unread counters.
create or replace function increment_whatsapp_conversation_unread(p_conversation_id uuid)
returns void language sql set search_path = '' as $$
  update public.whatsapp_conversations set unread_count = coalesce(unread_count,0) + 1 where id = p_conversation_id;
$$;
create or replace function increment_instagram_conversation_unread(p_conversation_id uuid)
returns void language sql set search_path = '' as $$
  update public.instagram_conversations set unread_count = coalesce(unread_count,0) + 1 where id = p_conversation_id;
$$;

-- 5. BCA engagement events: count + first_*_at (COALESCE) + last_*_at, one fn for all 4.
create or replace function record_bca_event(p_submission_id uuid, p_event text, p_at timestamptz default now())
returns void language plpgsql set search_path = '' as $$
begin
  if p_event not in ('view','open','click','download_merged') then
    raise exception 'record_bca_event: unknown event %', p_event;
  end if;
  update public.car_bca_submissions set
    view_count               = coalesce(view_count,0) + (case when p_event='view' then 1 else 0 end),
    first_viewed_at          = coalesce(first_viewed_at, case when p_event='view' then p_at end),
    last_viewed_at           = case when p_event='view' then p_at else last_viewed_at end,
    open_count               = coalesce(open_count,0) + (case when p_event='open' then 1 else 0 end),
    first_opened_at          = coalesce(first_opened_at, case when p_event='open' then p_at end),
    last_opened_at           = case when p_event='open' then p_at else last_opened_at end,
    click_count              = coalesce(click_count,0) + (case when p_event='click' then 1 else 0 end),
    first_clicked_at         = coalesce(first_clicked_at, case when p_event='click' then p_at end),
    last_clicked_at          = case when p_event='click' then p_at else last_clicked_at end,
    merged_download_count    = coalesce(merged_download_count,0) + (case when p_event='download_merged' then 1 else 0 end),
    first_merged_download_at = coalesce(first_merged_download_at, case when p_event='download_merged' then p_at end),
    last_merged_download_at  = case when p_event='download_merged' then p_at else last_merged_download_at end
  where id = p_submission_id;
end $$;

-- 6. Supplier default: atomic upsert; on conflict bump use_count in SQL.
create or replace function upsert_supplier_default(
  p_location_id uuid, p_xero_contact_id text, p_supplier_name text,
  p_account_code text, p_xero_account_id text, p_category text
) returns void language sql set search_path = '' as $$
  insert into public.xero_supplier_defaults
    (location_id, xero_contact_id, supplier_name, default_account_code, default_xero_account_id, default_category, use_count, last_used_at)
  values
    (p_location_id, p_xero_contact_id, p_supplier_name, p_account_code, p_xero_account_id, p_category, 1, now())
  on conflict (location_id, xero_contact_id) do update set
    use_count               = public.xero_supplier_defaults.use_count + 1,
    last_used_at            = now(),
    supplier_name           = coalesce(excluded.supplier_name, public.xero_supplier_defaults.supplier_name),
    default_account_code    = coalesce(excluded.default_account_code, public.xero_supplier_defaults.default_account_code),
    default_xero_account_id = excluded.default_xero_account_id,
    default_category        = coalesce(excluded.default_category, public.xero_supplier_defaults.default_category);
$$;

-- 7. Car Xero-invoice issue counter.
create or replace function increment_car_xero_issue_count(p_car_id uuid)
returns void language sql set search_path = '' as $$
  update public.cars set xero_invoice_issue_count = coalesce(xero_invoice_issue_count,0) + 1 where id = p_car_id;
$$;

-- 8. Presentation version bump (sync token). p_current_index serves `advance`.
create or replace function bump_presentation_version(p_presentation_id uuid, p_current_index int default null)
returns table(current_index int, version int) language sql set search_path = '' as $$
  update public.presentations set
    version       = coalesce(version,0) + 1,
    current_index = coalesce(p_current_index, current_index),
    updated_at    = now()
  where id = p_presentation_id
  returning current_index, version;
$$;
