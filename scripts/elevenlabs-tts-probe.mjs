#!/usr/bin/env node
// VOICEREPLY.1 — one-off live check of the two facts ElevenLabs' docs leave
// open (docs/superpowers/specs/2026-11-04-wa-voice-replies-design.md §2):
//   1. does output_format=opus_48000_64 come back in an Ogg container
//      (first bytes "OggS"), which WhatsApp needs for a voice note?
//   2. does the text-to-speech endpoint accept eleven_v4_turbo?
//
// Richard runs this once with the key:
//   ELEVENLABS_API_KEY=… node scripts/elevenlabs-tts-probe.mjs
// It prints what it found and writes nothing.
// - eleven_v4_turbo refused → set ELEVENLABS_TTS_MODEL to 'eleven_flash_v2_5'
//   in src/lib/elevenlabs.js.
// - neither model returns OggS → stop and ask Richard. Until then the runtime
//   is safe: a non-Ogg reply goes as text with reason not_ogg.

const key = process.env.ELEVENLABS_API_KEY
if (!key) {
  console.error('Set ELEVENLABS_API_KEY first.')
  process.exit(1)
}

const voicesRes = await fetch('https://api.elevenlabs.io/v2/voices?page_size=10', { headers: { 'xi-api-key': key } })
const voicesBody = await voicesRes.json().catch(() => ({}))
const voice = (voicesBody.voices || [])[0]
if (!voice) {
  console.error(`No voice to test with (HTTP ${voicesRes.status}).`)
  process.exit(1)
}
console.log(`Voice: ${voice.name} (${voice.voice_id})`)

for (const model of ['eleven_v4_turbo', 'eleven_flash_v2_5']) {
  const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voice.voice_id}?output_format=opus_48000_64`, {
    method: 'POST',
    headers: { 'xi-api-key': key, 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: 'Hi, it is Mia from UN1T. Your class is booked for seven tomorrow morning.', model_id: model }),
  })
  const bytes = new Uint8Array(await res.arrayBuffer())
  const head = String.fromCharCode(...bytes.slice(0, 4))
  const ogg = head === 'OggS'
  console.log(`${model}: HTTP ${res.status}, ${bytes.length} bytes, starts ${JSON.stringify(head)} → ${res.ok ? (ogg ? 'Ogg OK' : 'NOT Ogg') : 'refused'}`)
}
