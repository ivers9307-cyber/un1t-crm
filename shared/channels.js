// Channel identity metadata. PURE DATA ONLY — no JSX/SVG, so this file is
// safe to import from mobile (RN). SVG logos + components live in the web-only
// src/components/inbox/ChannelBits.jsx. (INBOX-REDESIGN 2026-07)

export const CHANNELS = {
  wa: { key: 'wa', label: 'WA', name: 'WhatsApp', token: 'channel-wa' },
  ig: { key: 'ig', label: 'IG', name: 'Instagram', token: 'channel-ig' },
  em: { key: 'em', label: 'EM', name: 'Email', token: 'channel-em' },
};

export const CHANNEL_KEYS = ['wa', 'ig', 'em'];

// UnifiedInbox tags each merged conversation with `_ch` ('wa' | 'ig' | 'em').
export function channelOf(conversation) {
  const ch = conversation && conversation._ch;
  return CHANNELS[ch] ? ch : 'wa';
}

export function channelMeta(conversation) {
  return CHANNELS[channelOf(conversation)];
}
