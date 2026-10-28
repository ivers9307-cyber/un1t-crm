// SHELLYGROUPS.3 — what a device should be judged against this tick. Pure: no
// I/O, no clock (nowMs is passed in, computed once per tick by the caller).
//
// planDeviceAction reads `enabled`, `schedule_mode`, `fixed_windows`,
// `class_rule`, `override` and `last_applied` straight off the row. For a
// device in a group this resolves those onto a copy of the device, so the
// planner is reused unchanged:
//  • the GROUP's enabled and schedule govern;
//  • a live DEVICE override beats a live GROUP override (the per-device switch
//    / widget wins); an expired one falls through to the group's;
//  • `last_applied` stays the DEVICE's own — the exactly-once stamp is per
//    device, because each relay can fail or be toggled by hand independently.
// Pressing the group switch clears member overrides in its route; this
// function does not mutate anything.
//
// A group from another location is never applied: the DB forbids the mix, but
// this is the last place a cross-tenant mix-up could become a relay command.
// The device is returned unchanged and the caller decides whether to log it.

import { isLiveOverride } from './plan'

// Must match real shelly_groups columns (check:select-columns).
export const GROUP_COLUMNS =
  'id, location_id, name, icon, sort_order, enabled, schedule_mode, fixed_windows, class_rule, override, last_applied, created_at, updated_at'

export function effectiveTarget(device, group, nowMs) {
  if (!group) return device
  if (group.location_id !== device?.location_id) return device
  const override = isLiveOverride(device?.override, nowMs)
    ? device.override
    : isLiveOverride(group.override, nowMs)
      ? group.override
      : null
  return {
    ...device,
    enabled: group.enabled,
    schedule_mode: group.schedule_mode,
    fixed_windows: group.fixed_windows,
    class_rule: group.class_rule,
    override,
  }
}
