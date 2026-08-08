// FLEET-CMD.1 — the action model.
//
// These tests exist mostly to pin the security properties in place. The
// interesting cases are the refusals, not the happy paths.

import { describe, it, expect } from 'vitest'
import {
  ACTIONS,
  ACTION_NAMES,
  COMMAND_TTL_MS,
  isKnownAction,
  actionAppliesToRole,
  permissionForAction,
  availableActions,
  expiryFor,
  suppressionFor,
  isExpired,
} from './fleet-commands.js'

const always = () => true
const never = () => false
const only = (...keys) => (k) => keys.includes(k)

describe('the allowlist', () => {
  it('carries no executable field', () => {
    // The whole design rests on names never being commands. This is the real
    // guard: adding a `command:` field to make the API "simpler" fails here.
    for (const [name, spec] of Object.entries(ACTIONS)) {
      expect(Object.keys(spec).sort(), `${name} grew a field`).toEqual(
        ['blurb', 'danger', 'label', 'permission', 'roles'],
      )
    }
  })

  it('holds no shell text in any machine-read field', () => {
    // `label` and `blurb` are deliberately excluded: they are operator copy,
    // and describing redeploy_bridge honestly means saying "git pull". Nothing
    // reads them but a human.
    for (const [name, spec] of Object.entries(ACTIONS)) {
      const machineRead = JSON.stringify({
        roles: spec.roles, permission: spec.permission, danger: spec.danger,
      })
      expect(machineRead, `${name} looks like it carries a command`)
        .not.toMatch(/pkill|systemctl|sudo|git |journalctl|rm |&&|\|\||;/)
    }
  })

  it('rejects anything not on it', () => {
    expect(isKnownAction('reboot')).toBe(true)
    expect(isKnownAction('rm -rf /')).toBe(false)
    expect(isKnownAction('')).toBe(false)
    expect(isKnownAction(null)).toBe(false)
    expect(isKnownAction(undefined)).toBe(false)
    expect(isKnownAction(123)).toBe(false)
  })

  it('is not fooled by inherited properties', () => {
    // A plain `action in ACTIONS` would say true for these.
    expect(isKnownAction('toString')).toBe(false)
    expect(isKnownAction('constructor')).toBe(false)
    expect(isKnownAction('__proto__')).toBe(false)
  })

  it('gates every destructive action behind fleet_admin', () => {
    for (const name of ACTION_NAMES) {
      const { danger, permission } = ACTIONS[name]
      if (danger !== 'safe') {
        expect(permission, `${name} must not be a safe-tier action`).toBe('fleet_admin')
      }
    }
  })

  it('keeps screenshot out of the coach tier even though it is harmless to the device', () => {
    // The danger axis is about the DEVICE; this one is gated on PRIVACY. A
    // board capture carries member first names and live BPM, so restarting a
    // frozen TV must not come with photographing the room's vitals.
    expect(ACTIONS.screenshot.danger).toBe('safe')
    expect(ACTIONS.screenshot.permission).toBe('fleet_admin')
    expect(availableActions('kiosk', only('fleet_restart')).map((a) => a.action))
      .not.toContain('screenshot')
  })

  it('marks shutdown, and only shutdown, as stranding', () => {
    // Shutdown is the one action a keyboard cannot undo. If another action
    // ever earns that class the UI's typed-confirmation branch must cover it.
    const stranding = ACTION_NAMES.filter((a) => ACTIONS[a].danger === 'stranding')
    expect(stranding).toEqual(['shutdown'])
  })
})

describe('role applicability', () => {
  it('keeps kiosk-only and bridge-only actions apart', () => {
    expect(actionAppliesToRole('restart_kiosk', 'kiosk')).toBe(true)
    expect(actionAppliesToRole('restart_kiosk', 'bridge')).toBe(false)
    expect(actionAppliesToRole('redeploy_bridge', 'bridge')).toBe(true)
    expect(actionAppliesToRole('redeploy_bridge', 'kiosk')).toBe(false)
  })

  it('offers nothing at all for an unclaimed device', () => {
    // The cron auto-registers whatever Tailscale reports, so a device can
    // exist with no role. Guessing would be worse than offering nothing.
    for (const name of ACTION_NAMES) {
      expect(actionAppliesToRole(name, null)).toBe(false)
      expect(actionAppliesToRole(name, undefined)).toBe(false)
      expect(actionAppliesToRole(name, '')).toBe(false)
    }
    expect(availableActions(null, always)).toEqual([])
  })

  it('refuses an unknown action for any role', () => {
    expect(actionAppliesToRole('format_disk', 'kiosk')).toBe(false)
  })
})

describe('permission mapping', () => {
  it('names the key for the action, not the page', () => {
    expect(permissionForAction('restart_kiosk')).toBe('fleet_restart')
    expect(permissionForAction('shutdown')).toBe('fleet_admin')
    expect(permissionForAction('nonsense')).toBeNull()
  })

  it('never lets fleet_restart reach a destructive action', () => {
    // The bug this guards: a coach holds fleet_restart, so the page renders,
    // and a hand-rolled POST asks for a shutdown.
    const offered = availableActions('kiosk', only('fleet_restart')).map((a) => a.action)
    expect(offered).toContain('restart_kiosk')
    expect(offered).not.toContain('reboot')
    expect(offered).not.toContain('shutdown')
  })

  it('offers nothing to someone with neither key', () => {
    expect(availableActions('kiosk', never)).toEqual([])
    expect(availableActions('bridge', never)).toEqual([])
  })

  it('gives a bridge admin the bridge actions and no kiosk ones', () => {
    const offered = availableActions('bridge', always).map((a) => a.action)
    // No screenshot: a bridge is headless.
    expect(offered.sort()).toEqual(['pull_logs', 'reboot', 'redeploy_bridge', 'shutdown'])
  })
})

describe('expiry', () => {
  it('is two minutes out', () => {
    const now = Date.parse('2026-08-02T16:00:00.000Z')
    expect(expiryFor(now)).toBe('2026-08-02T16:02:00.000Z')
    expect(COMMAND_TTL_MS).toBe(120000)
  })

  it('treats the boundary as expired', () => {
    const now = Date.parse('2026-08-02T16:00:00.000Z')
    const cmd = { expires_at: expiryFor(now) }
    expect(isExpired(cmd, now)).toBe(false)
    expect(isExpired(cmd, now + COMMAND_TTL_MS - 1)).toBe(false)
    // Exactly at the deadline it is dead — a command that "just made it" is
    // the one most likely to land somewhere unexpected.
    expect(isExpired(cmd, now + COMMAND_TTL_MS)).toBe(true)
    expect(isExpired(cmd, now + COMMAND_TTL_MS + 1)).toBe(true)
  })
})

describe('alert suppression', () => {
  const now = Date.parse('2026-08-02T16:00:00.000Z')

  it('suppresses a shutdown indefinitely', () => {
    // A halted Pi has no expected return, so there is no honest deadline.
    expect(suppressionFor('shutdown', now)).toBe('infinity')
  })

  it('does NOT suppress a reboot', () => {
    // Deliberate. fleet-health's OFFLINE_AFTER_MS is 15 minutes, chosen so the
    // nightly 04:00 reboots stay quiet, so a healthy ~90s reboot never grades
    // unreachable in the first place. Any suppression window shorter than 15
    // minutes could never fire, and a longer one would mask a reboot that hung
    // — which is a real outage worth paging for.
    expect(suppressionFor('reboot', now)).toBeNull()
  })

  it('does not suppress anything that leaves the device up', () => {
    // Suppressing redeploy_bridge would hide a redeploy that broke the
    // service — the exact failure FLEET-ALERT.1 was built to catch.
    expect(suppressionFor('redeploy_bridge', now)).toBeNull()
    expect(suppressionFor('restart_kiosk', now)).toBeNull()
    expect(suppressionFor('pull_logs', now)).toBeNull()
  })
})
