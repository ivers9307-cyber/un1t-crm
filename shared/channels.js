// Channel identity metadata for THE UNIFIED INBOX. PURE DATA ONLY — no
// JSX/SVG, so this file is safe to import from mobile (RN). SVG logos +
// components live in the web-only src/components/inbox/ChannelBits.jsx.
// (INBOX-REDESIGN 2026-07)
//
// INBOX-SPLIT.1 (Richard, 2026-08-07) — the `em` descriptor is GONE. Email is
// no longer an inbox channel: it has its own ticketed surface at
// /communications/tickets, and being in both places meant one message was
// workable under two state models. Safe to remove because nothing under
// mobile/ imports this module — mobile's Messages tab carries its own
// CHANNEL_GLYPHS map keyed 'whatsapp'|'instagram'|'email' in
// mobile/app/(tabs)/whatsapp.jsx (verified 2026-08-07; note that tab still
// merges email, which is a separate decision to the web split). The
// `channel-em` Tailwind colour token stays — the tickets UI renders it.

export const CHANNELS = {
  wa: { key: 'wa', label: 'WA', name: 'WhatsApp', token: 'channel-wa' },
  ig: { key: 'ig', label: 'IG', name: 'Instagram', token: 'channel-ig' },
};

export const CHANNEL_KEYS = ['wa', 'ig'];

// UnifiedInbox tags each merged conversation with `_ch` ('wa' | 'ig').
// A stale 'em' tag falls back to 'wa' via the CHANNELS lookup below.
export function channelOf(conversation) {
  const ch = conversation && conversation._ch;
  return CHANNELS[ch] ? ch : 'wa';
}

export function channelMeta(conversation) {
  return CHANNELS[channelOf(conversation)];
}
