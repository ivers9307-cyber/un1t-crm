-- 808 VOICENOTE.1 — WhatsApp voice notes transcribed for Mia and staff.
--
-- WHY (Richard, 4 Nov 2026). Mia sends every WhatsApp voice note to staff
-- because there was no transcription vendor (OpenAI is ruled out everywhere).
-- ElevenLabs Scribe is that vendor now: the webhook transcribes an inbound voice
-- note of up to 3 minutes before Mia's turn, Mia answers a clear one like a
-- text, and staff see every transcript under the player. Design:
-- docs/superpowers/specs/2026-11-04-wa-voice-note-transcription-design.md.
--
-- whatsapp_messages gains the transcript and its status. The status list is
-- shared/voice-note.js TRANSCRIPT_STATUSES (change both together;
-- tests/voice-note-migration.test.js). `pending` is written AT INSERT on every
-- inbound audio row so a concurrent turn can tell "being transcribed" from old
-- audio; NULL is every non-audio row and every voice note from before launch.
--
-- org_settings gains the per-organisation switch (off by default) and an
-- optional monthly cap in minutes, metered as usage_events meter
-- 'elevenlabs_stt_seconds' (separate from Mia's AI cap, which sums only
-- 'anthropic_tokens').
--
-- APPLY BEFORE the VOICENOTE.1 code deploys: the agent's WhatsApp history read
-- names transcript/transcript_status, and PostgREST fails a select naming a
-- missing column whole. Before the code ships the columns are simply NULL.
--
-- IDEMPOTENT: ADD COLUMN IF NOT EXISTS; each CHECK is dropped and re-added.
--
-- column-grant: whatsapp_messages keeps table-level SELECT for authenticated
-- (read-only, no client write since mig 656), so the phone and the inbox
-- realtime listener read the new columns with no grant change and no client
-- can write a transcript Mia would read as the customer's words.
-- org_settings has no client privilege (mig 730); written only through
-- /api/settings/org-usage.
-- grant: none (no new relation)

BEGIN;

ALTER TABLE public.whatsapp_messages
  ADD COLUMN IF NOT EXISTS transcript text,
  ADD COLUMN IF NOT EXISTS transcript_status text,
  ADD COLUMN IF NOT EXISTS transcript_language text,
  ADD COLUMN IF NOT EXISTS transcribed_at timestamptz;

ALTER TABLE public.whatsapp_messages
  DROP CONSTRAINT IF EXISTS whatsapp_messages_transcript_status_check;
ALTER TABLE public.whatsapp_messages
  ADD CONSTRAINT whatsapp_messages_transcript_status_check
  CHECK (transcript_status IS NULL OR transcript_status IN ('pending', 'ok', 'unclear', 'too_long', 'capped', 'disabled', 'not_configured', 'failed'));

COMMENT ON COLUMN public.whatsapp_messages.transcript IS
  'VOICENOTE.1 (mig 808): ElevenLabs Scribe text of an inbound voice note, trimmed. Set only when transcript_status is ok or unclear.';
COMMENT ON COLUMN public.whatsapp_messages.transcript_status IS
  'VOICENOTE.1 (mig 808): pending (at insert) | ok | unclear | too_long | capped | disabled | not_configured | failed. NULL on non-audio rows and pre-launch audio. List = shared/voice-note.js TRANSCRIPT_STATUSES.';
COMMENT ON COLUMN public.whatsapp_messages.transcript_language IS
  'VOICENOTE.1 (mig 808): ElevenLabs language_code of the transcript.';
COMMENT ON COLUMN public.whatsapp_messages.transcribed_at IS
  'VOICENOTE.1 (mig 808): when transcript_status was last written by the transcription step.';

ALTER TABLE public.org_settings
  ADD COLUMN IF NOT EXISTS voice_transcription_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS voice_transcription_monthly_cap_minutes integer;

ALTER TABLE public.org_settings
  DROP CONSTRAINT IF EXISTS org_settings_voice_transcription_cap_check;
ALTER TABLE public.org_settings
  ADD CONSTRAINT org_settings_voice_transcription_cap_check
  CHECK (voice_transcription_monthly_cap_minutes IS NULL OR voice_transcription_monthly_cap_minutes > 0);

COMMENT ON COLUMN public.org_settings.voice_transcription_enabled IS
  'VOICENOTE.1 (mig 808): transcribe inbound WhatsApp voice notes with ElevenLabs for this organisation. Off by default.';
COMMENT ON COLUMN public.org_settings.voice_transcription_monthly_cap_minutes IS
  'VOICENOTE.1 (mig 808): monthly transcription cap in minutes (PLATFORM_TZ month, usage_events meter elevenlabs_stt_seconds). NULL = no cap.';

COMMIT;
