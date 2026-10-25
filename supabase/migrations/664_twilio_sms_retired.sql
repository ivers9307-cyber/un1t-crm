-- 664_twilio_sms_retired.sql — TWILIO-RETIRE.1
--
-- Twilio was the CRM's only SMS provider, and SMS is retired with it: SMS
-- broadcasts, sequence SMS steps, event/booking/race confirmation texts, car
-- deposit link + receipt texts, ad-hoc contact texts and the delivery-status
-- webhook are all gone from the code in the same PR.
--
-- DATA STAYS. Richard's call: SMS history is kept, only its use stops. So this
-- migration drops NO table or column — sms_broadcasts, sms_broadcast_recipients,
-- locations.twilio_alpha_sender_id, *_sms_body, confirmation_sms_*,
-- car_deposit_receipt_sms_enabled and the consent columns (sms_marketing,
-- sms_administrative, sms_status) all remain as history. A later migration can
-- drop them once nothing is expected to want them back.
--
-- What it does change is the two pieces of RUNNING config that would otherwise
-- lie about a channel that no longer exists.

-- ── 1. drop the SMS broadcast cron's heartbeat row ──────────────────────────
-- CLAUDE.md invariant: a cron with a cron_heartbeats row that never runs goes
-- "stale" and alerts forever. /api/cron/run-sms-broadcasts and its vercel.json
-- entry are deleted in this PR, so the row goes with them (mig 537 precedent).
-- Apply AFTER the deploy: until then the old cron still runs, and stamping a
-- missing row is a logged no-op, so either order is safe — after is just quieter.
delete from public.cron_heartbeats where name = 'run-sms-broadcasts';

-- ── 2. deactivate the twilio_sender registry rows ──────────────────────────
-- Nothing reads platform 'twilio_sender' any more (connection-registry.js
-- DUAL_READ_PLATFORMS, integrations-hub.js REGISTRY_PLATFORMS). Left active they
-- would still count as a live, 'connected' integration in the tenant-health
-- rollup and the connection-health cron. Deactivated, not deleted: the row
-- keeps its config (the alpha sender) as history, same as the location column.
update public.channel_connections
   set is_active = false
 where platform = 'twilio_sender'
   and is_active;
