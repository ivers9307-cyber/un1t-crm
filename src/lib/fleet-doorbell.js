// FLEET-CMD.1 — the doorbell.
//
// Realtime is used here as a WAKE-UP SIGNAL, not as a data channel. The
// broadcast carries no command, no payload, and nothing secret: it says only
// "device X, you have work". The agent then makes one authenticated request to
// /api/fleet/commands/next with its own bearer token to find out what.
//
// WHY IT IS SHAPED THIS WAY
// The obvious design has the agent subscribe to postgres_changes on
// fleet_commands. That needs a credential able to READ that table, which meant
// either minting custom JWTs or creating a Supabase auth user per Pi. The
// latter is a live trap in this project: public.handle_new_user() is an
// INVERTED allowlist, so an auth user created without an `invited_for` marker
// is auto-granted a staff profile with pipeline and contacts access. Every
// Raspberry Pi would have quietly become a staff account.
//
// Treating the channel as a doorbell removes the whole problem. The anon key
// is public by design (it already ships in the champ-app bundle) and that is
// fine, because eavesdropping reveals only that some device was poked, and a
// forged ping makes the agent perform an authenticated fetch that returns
// nothing. The security boundary stays exactly where it already was: an
// authenticated CRM endpoint.
//
// It also means a failed ping is harmless. The command sits pending and
// expires in two minutes, which the UI reports honestly as "not delivered".

import { createClient } from '@supabase/supabase-js'
import { logWarn } from '@/lib/log'

/** Channel a device listens on. Must match the agent. */
export function channelFor(deviceName) {
  return `fleet:${deviceName}`
}

/**
 * Wake a device.
 *
 * Never throws and never blocks the caller's success: the command row is
 * already committed by the time this runs, so a failed ping costs a delay, not
 * a lost action.
 *
 * @param {string} deviceName
 * @returns {Promise<boolean>} whether the ping was sent
 */
export async function pingDevice(deviceName) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) {
    logWarn('fleet-cmd', 'doorbell not configured', { deviceName })
    return false
  }

  let client
  try {
    client = createClient(url, key, {
      auth: { persistSession: false, autoRefreshToken: false },
    })
    const channel = client.channel(channelFor(deviceName))
    await channel.subscribe()
    await channel.send({
      type: 'broadcast',
      event: 'wake',
      // Deliberately empty. If a payload is ever added here, the channel stops
      // being a doorbell and the auth argument above no longer holds.
      payload: {},
    })
    await client.removeChannel(channel)
    return true
  } catch (err) {
    logWarn('fleet-cmd', 'failed to ring doorbell', { deviceName, err: String(err) })
    try { await client?.removeAllChannels() } catch { /* best effort */ }
    return false
  }
}
