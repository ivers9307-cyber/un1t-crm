-- 256 — UIX-POLISH.3: publish the Instagram messaging tables to
-- Realtime so the unified inbox gets push updates for BOTH channels.
--
-- The WhatsApp tables have been published since mig 042 (which is why
-- WA threads update instantly), but mig 231 created the Instagram
-- tables without publication — IG surfaces only refreshed on polls.
-- RLS still gates what each authenticated subscriber can see
-- (instagram_messages SELECT via parent; conversations are
-- ig_conv_deny_writes but readable in-location).

ALTER PUBLICATION supabase_realtime ADD TABLE instagram_conversations;
ALTER PUBLICATION supabase_realtime ADD TABLE instagram_messages;
