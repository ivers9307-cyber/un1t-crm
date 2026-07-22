import { describe, it, expect } from 'vitest';
import { CHANNELS, CHANNEL_KEYS, channelOf, channelMeta } from './channels';

describe('channels', () => {
  it('exposes wa/ig/em with label + name + token', () => {
    expect(CHANNEL_KEYS).toEqual(['wa', 'ig', 'em']);
    expect(CHANNELS.wa).toMatchObject({ key: 'wa', label: 'WA', name: 'WhatsApp', token: 'channel-wa' });
    expect(CHANNELS.ig).toMatchObject({ key: 'ig', label: 'IG', name: 'Instagram', token: 'channel-ig' });
    expect(CHANNELS.em).toMatchObject({ key: 'em', label: 'EM', name: 'Email', token: 'channel-em' });
  });

  it('channelOf reads the merged-conversation _ch tag', () => {
    expect(channelOf({ _ch: 'ig' })).toBe('ig');
    expect(channelOf({ _ch: 'em' })).toBe('em');
  });

  it('channelOf falls back to wa for unknown/missing', () => {
    expect(channelOf({})).toBe('wa');
    expect(channelOf(null)).toBe('wa');
    expect(channelOf({ _ch: 'sms' })).toBe('wa');
  });

  it('channelMeta returns the full record', () => {
    expect(channelMeta({ _ch: 'ig' }).name).toBe('Instagram');
  });
});
