// src/components/inbox/ChannelBits.jsx
'use client';
import { CHANNELS, channelOf } from '../../../shared/channels';

// INBOX-SPLIT.1 — the `em` variant is gone with EmailInbox.jsx: email is not
// an inbox channel any more (its surface is /communications/mail, which
// draws its own lucide Mail icon). Leaving the maps keyed for a channel
// CHANNELS no longer describes would be a trap — `CHANNELS['em'].name` below
// would throw. The `channel-em` Tailwind colour token itself stays; the
// tickets UI uses it.

// --- static class maps (literal strings for the Tailwind JIT) ---
const TEXT = { wa: 'text-channel-wa', ig: 'text-channel-ig' };
const RING = { wa: 'ring-channel-wa', ig: 'ring-channel-ig' };

// --- brand-recognisable logos, drawn to currentColor ---
function Logo({ channel, className }) {
  if (channel === 'ig') {
    return (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" className={className} aria-hidden="true">
        <rect x="3.2" y="3.2" width="17.6" height="17.6" rx="5.2" />
        <circle cx="12" cy="12" r="4.1" />
        <circle cx="17.3" cy="6.7" r="1.15" fill="currentColor" stroke="none" />
      </svg>
    );
  }
  // WhatsApp (default)
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden="true">
      <path d="M12 2.2A9.8 9.8 0 0 0 3.4 17L2.2 21.4l4.5-1.2A9.8 9.8 0 1 0 12 2.2zm0 1.8a8 8 0 0 1 6.9 12A8 8 0 0 1 7.9 18.7l-.3-.2-2.7.7.7-2.6-.2-.3A8 8 0 0 1 12 4zm-3.1 3.9c-.15 0-.4 0-.6.35-.2.35-.8.78-.8 1.9 0 1.13.82 2.22.94 2.38.11.15 1.6 2.55 3.96 3.48 1.96.77 2.36.62 2.79.58.43-.04 1.38-.56 1.57-1.1.2-.55.2-1.01.14-1.11-.06-.1-.21-.16-.45-.28-.24-.12-1.38-.68-1.6-.76-.21-.08-.37-.12-.52.12-.15.24-.6.76-.73.91-.13.15-.27.17-.5.06-.24-.12-1-.37-1.9-1.18-.7-.63-1.18-1.4-1.31-1.64-.13-.24-.01-.37.1-.48.11-.11.24-.28.36-.42a1.6 1.6 0 0 0 .24-.4.44.44 0 0 0-.02-.42c-.06-.12-.52-1.27-.72-1.74-.18-.44-.37-.38-.52-.39z" />
    </svg>
  );
}

// Leading channel logo for a conversation row.
export function ChannelGlyph({ conversation, channel }) {
  const key = channel || channelOf(conversation);
  const m = CHANNELS[key];
  return (
    <span className={`grid h-6 w-6 flex-none place-items-center ${TEXT[key]}`} title={m.name}>
      <Logo channel={key} className="h-[21px] w-[21px]" />
      <span className="sr-only">{m.name}</span>
    </span>
  );
}

// Initials tile with a channel-colour ring and an optional corner logo badge.
export function ChannelAvatar({ conversation, channel, initials, badge = false, className = '' }) {
  const key = channel || channelOf(conversation);
  const m = CHANNELS[key];
  return (
    <div
      className={`relative grid h-9 w-9 flex-none place-items-center rounded-[11px] border border-un1t-border bg-un1t-surface text-[13px] font-semibold text-un1t-text ring-2 ${RING[key]} ${className}`}
    >
      {initials}
      {badge && (
        <span
          className={`absolute -bottom-1 -right-1 grid h-[18px] w-[18px] place-items-center rounded-md border border-un1t-border bg-un1t-bg ${TEXT[key]}`}
          title={m.name}
        >
          <Logo channel={key} className="h-3 w-3" />
        </span>
      )}
    </div>
  );
}
