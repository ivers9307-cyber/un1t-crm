import { describe, it, expect } from 'vitest';
import { CHANNELS, CHANNEL_KEYS, channelOf, channelMeta } from './channels';

describe('channels', () => {
  it('exposes wa/ig with label + name + token', () => {
    expect(CHANNEL_KEYS).toEqual(['wa', 'ig']);
    expect(CHANNELS.wa).toMatchObject({ key: 'wa', label: 'WA', name: 'WhatsApp', token: 'channel-wa' });
    expect(CHANNELS.ig).toMatchObject({ key: 'ig', label: 'IG', name: 'Instagram', token: 'channel-ig' });
  });

  // INBOX-SPLIT.1 — email is NOT an inbox channel. It has its own ticketed
  // surface at /communications/tickets; keeping it here too would let the
  // same message be worked from two places under two state models.
  it('has no email channel', () => {
    expect(CHANNELS.em).toBeUndefined();
    expect(CHANNEL_KEYS).not.toContain('em');
  });

  it('channelOf reads the merged-conversation _ch tag', () => {
    expect(channelOf({ _ch: 'ig' })).toBe('ig');
    expect(channelOf({ _ch: 'wa' })).toBe('wa');
  });

  it('channelOf falls back to wa for unknown/missing', () => {
    expect(channelOf({})).toBe('wa');
    expect(channelOf(null)).toBe('wa');
    expect(channelOf({ _ch: 'sms' })).toBe('wa');
    // A stale 'em' tag from a cached payload degrades to wa rather than
    // exploding in ChannelGlyph/ChannelAvatar (they do CHANNELS[key].name).
    expect(channelOf({ _ch: 'em' })).toBe('wa');
  });

  it('channelMeta returns the full record', () => {
    expect(channelMeta({ _ch: 'ig' }).name).toBe('Instagram');
  });
});
