-- 332 — increment_sms_broadcast_metric: generic delta counter
--
-- COMMS-AUDIT batch 5. The Twilio status webhook flips a recipient
-- sent→failed but had no way to correct the broadcast's total_sent /
-- total_failed: the single-purpose increment_sms_broadcast_delivered /
-- _undelivered RPCs have no delta and don't touch total_sent, and the send
-- loop's snapshot doesn't see async Twilio failures. So a message handed to
-- Twilio (counted as sent) that later fails stayed counted as sent forever.
--
-- This mirrors increment_whatsapp_broadcast_metric (mig 314): a whitelisted
-- delta function so the webhook can move a now-failed message OUT of
-- total_sent and INTO total_failed atomically.

create or replace function increment_sms_broadcast_metric(p_broadcast_id uuid, p_metric text, p_delta int default 1)
returns void language plpgsql set search_path = '' as $$
begin
  if p_metric not in ('total_sent','total_delivered','total_undelivered','total_failed') then
    raise exception 'increment_sms_broadcast_metric: unknown metric %', p_metric;
  end if;
  update public.sms_broadcasts set
    total_sent        = coalesce(total_sent,0)        + (case when p_metric='total_sent'        then p_delta else 0 end),
    total_delivered   = coalesce(total_delivered,0)   + (case when p_metric='total_delivered'   then p_delta else 0 end),
    total_undelivered = coalesce(total_undelivered,0) + (case when p_metric='total_undelivered' then p_delta else 0 end),
    total_failed      = coalesce(total_failed,0)      + (case when p_metric='total_failed'      then p_delta else 0 end)
  where id = p_broadcast_id;
end $$;

revoke all on function increment_sms_broadcast_metric(uuid, text, int) from public;
grant execute on function increment_sms_broadcast_metric(uuid, text, int) to service_role;
