-- 809 VOICEREPLY.1 — Mia answers a WhatsApp voice note with a voice note.
--
-- WHY (Richard, 4 Nov 2026). VOICENOTE.1 (mig 808) lets Mia understand a voice
-- note; she still answered in text. Now, when the message she answers is a
-- voice note, her reply goes out as a voice note made by ElevenLabs
-- text-to-speech, in a voice the studio's managers chose for the kind of reply
-- (leads and trials, bookings, member questions, the hand-off message, a
-- default). Design: docs/superpowers/specs/2026-11-04-wa-voice-replies-design.md.
--
-- org_settings: the rollout switch is ONE column with three values (off, test,
-- on), never an enabled flag plus a test flag (the "enabled + test_mode = live
-- for everyone" lesson). In `test` only voice_reply_test_phones get voice.
-- voice_reply_monthly_cap counts voice replies per platform month
-- (usage_events meter elevenlabs_tts_replies); null = no cap.
--
-- whatsapp_messages: voice_kind marks one of Mia's voice replies (the list is
-- shared/voice-note.js VOICE_KINDS: change both together;
-- tests/voice-reply-migration.test.js). voice_fallback_sent_at is the claim
-- that a voice reply WhatsApp failed to deliver was resent as text, once.
--
-- APPLY BEFORE the VOICEREPLY.1 code deploys: the agent writes voice_kind on
-- its audio rows and the status webhook selects it. Before the code ships the
-- columns are simply unused.
--
-- IDEMPOTENT: ADD COLUMN IF NOT EXISTS; each CHECK is dropped and re-added.
--
-- column-grant: whatsapp_messages keeps table-level SELECT for authenticated
-- (read-only, no client write since mig 656), so the inbox and the phone read
-- voice_kind with no grant change. org_settings has no client privilege
-- (mig 730); written only through /api/settings/org-usage.
-- grant: none (no new relation)

BEGIN;

ALTER TABLE public.org_settings
  ADD COLUMN IF NOT EXISTS voice_reply_mode text NOT NULL DEFAULT 'off',
  ADD COLUMN IF NOT EXISTS voice_reply_test_phones text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS voice_reply_monthly_cap integer;

ALTER TABLE public.org_settings DROP CONSTRAINT IF EXISTS org_settings_voice_reply_mode_check;
ALTER TABLE public.org_settings ADD CONSTRAINT org_settings_voice_reply_mode_check
  CHECK (voice_reply_mode IN ('off', 'test', 'on'));
ALTER TABLE public.org_settings DROP CONSTRAINT IF EXISTS org_settings_voice_reply_cap_check;
ALTER TABLE public.org_settings ADD CONSTRAINT org_settings_voice_reply_cap_check
  CHECK (voice_reply_monthly_cap IS NULL OR voice_reply_monthly_cap > 0);

COMMENT ON COLUMN public.org_settings.voice_reply_mode IS
  'VOICEREPLY.1 (mig 809): off | test (only voice_reply_test_phones) | on. Mia replies to a WhatsApp voice note with an ElevenLabs voice note.';
COMMENT ON COLUMN public.org_settings.voice_reply_test_phones IS
  'VOICEREPLY.1 (mig 809): the numbers that get voice replies while voice_reply_mode is test.';
COMMENT ON COLUMN public.org_settings.voice_reply_monthly_cap IS
  'VOICEREPLY.1 (mig 809): voice replies per platform month (usage_events meter elevenlabs_tts_replies). NULL = no cap.';

ALTER TABLE public.whatsapp_messages
  ADD COLUMN IF NOT EXISTS voice_kind text,
  ADD COLUMN IF NOT EXISTS voice_fallback_sent_at timestamptz;

ALTER TABLE public.whatsapp_messages DROP CONSTRAINT IF EXISTS whatsapp_messages_voice_kind_check;
ALTER TABLE public.whatsapp_messages ADD CONSTRAINT whatsapp_messages_voice_kind_check
  CHECK (voice_kind IS NULL OR voice_kind IN ('lead', 'booking', 'member', 'handoff', 'default'));

COMMENT ON COLUMN public.whatsapp_messages.voice_kind IS
  'VOICEREPLY.1 (mig 809): set only on one of Mia''s voice replies: lead | booking | member | handoff | default (shared/voice-note.js VOICE_KINDS).';
COMMENT ON COLUMN public.whatsapp_messages.voice_fallback_sent_at IS
  'VOICEREPLY.1 (mig 809): when a voice reply WhatsApp failed to deliver was resent as text (the once-only claim).';

COMMIT;
