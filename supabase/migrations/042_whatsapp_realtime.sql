-- Add the WhatsApp tables to the supabase_realtime publication so the
-- inbox UI can subscribe to row events instead of polling every 10s.
--
-- The previous WAInbox.jsx ran a 10-second setInterval on every open
-- session — at 50 active users that's ~432k requests/day, drains
-- mobile battery, and adds noticeable load on Supabase. Switching to
-- Realtime cuts that to ~zero in steady-state and surfaces new
-- messages instantly instead of after up-to-10s of staleness.
--
-- Realtime respects RLS — both tables already have it enabled (mig 007
-- + 020), so users only get events for rows their policies let them
-- read. No new policy work needed; the existing per-location policies
-- gate both the SELECT and the realtime broadcast.
--
-- Idempotent — `ADD TABLE` errors if the table is already a member,
-- so wrap in a DO block that catches the duplicate-object error and
-- moves on.

DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE whatsapp_conversations;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE whatsapp_messages;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
