// @vitest-environment jsdom
//
// MIASETTINGS.1a — the golden round trip for the Mia settings page. Saving with
// no edits must PUT exactly buildSavePayload(loaded settings, initialOverridden),
// and one edit must change exactly one key. It pins today's page; every later
// task of the redesign keeps it green.

import { describe, it, expect, afterEach } from 'vitest'
import { cleanup } from '@testing-library/react'
import { initialOverridden } from '@/lib/agent/settings-overrides'
import { buildSavePayload } from './save-payload'
import {
  STILLORGAN_GET, HATCH_GET, LEGACY_FULL_BLOB_GET, HATCH_NO_BLOB_GET, EDIT_ONE_PER_SECTION,
} from './__fixtures__/agent-settings'
import { renderEditor, lastPutBody, saveNow, editByLabel } from './__fixtures__/harness'

afterEach(() => { cleanup(); delete global.fetch; window.history.replaceState(null, '', '/') })

// Leaf paths of a PUT body: objects descend (null counts as empty), arrays and
// scalars are leaves. `overridden` is compared apart.
function leaves(body) {
  const out = {}
  const walk = (v, path) => {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      for (const [k, x] of Object.entries(v)) walk(x, path ? `${path}.${k}` : k)
    } else out[path] = v
  }
  const { overridden: _o, ...rest } = body
  walk(rest, '')
  return out
}
function changedPaths(a, b) {
  const la = leaves(a)
  const lb = leaves(b)
  // A path absent on one side is changed; `undefined` and absent are the same.
  return [...new Set([...Object.keys(la), ...Object.keys(lb)])]
    .filter((p) => JSON.stringify(la[p] ?? null) !== JSON.stringify(lb[p] ?? null))
    .sort()
}

describe('round trip: saving with no edits', () => {
  for (const [name, get] of [['Stillorgan', STILLORGAN_GET], ['Hatch', HATCH_GET], ['legacy full blob', LEGACY_FULL_BLOB_GET], ['Hatch with no blob', HATCH_NO_BLOB_GET]]) {
    it(`${name}: the PUT body equals buildSavePayload of what was loaded`, async () => {
      await renderEditor(get)
      await saveNow()
      expect(lastPutBody()).toEqual(buildSavePayload(get.settings, initialOverridden(get.studio)))
    })
  }
})

// Frozen literals, so a change inside buildSavePayload itself cannot move the
// page and the expectation together. (One call site per snapshot: written by
// `vitest -u`, never in a loop.)
async function noEditBody(get) {
  await renderEditor(get)
  await saveNow()
  return lastPutBody()
}
describe('round trip: the frozen PUT bodies', () => {
  it('Stillorgan', async () => { expect(await noEditBody(STILLORGAN_GET)).toMatchInlineSnapshot(`
    {
      "account_conflict_handoff_text": null,
      "agent_name": "Mia",
      "approval_decline_text": null,
      "auto_resolve_after_reply_hours": 8,
      "auto_resolve_stale_hours": 48,
      "booking_confirmation_text": null,
      "booking_cta_label": null,
      "booking_flow_text": null,
      "booking_issue_handoff_text": null,
      "booking_mode": "auto",
      "booking_url": null,
      "cancellation_confirmation_text": null,
      "cancellation_form": null,
      "chat_booking_unavailable_text": null,
      "class_move_confirmation_text": null,
      "comp_credits_confirmation_text": null,
      "consultation_event_type_id": null,
      "effort": null,
      "enabled": true,
      "event_move_confirmation_text": null,
      "event_move_failed_text": null,
      "extra_rules": null,
      "first_class_checkin": {
        "daily_cap": 20,
        "delay_hours": 2,
        "enabled": false,
        "template_name": null,
      },
      "flow_booking_ack_text": null,
      "flow_booking_duplicate_text": null,
      "flow_booking_holding_text": null,
      "flow_paid_trial_text": null,
      "followups": {
        "daily_cap": 80,
        "enabled": false,
        "nudge_after_hours": 3,
        "template_name": null,
      },
      "glofox_auto_cancel": false,
      "handoff_after_verify_failures": null,
      "handoff_cooldown_hours": 12,
      "handoff_sla_minutes": null,
      "holding_message": "Studio holding message",
      "inline_suggestion": {
        "enabled": true,
      },
      "limits": null,
      "link_button_text": null,
      "membership_cta_label": null,
      "membership_signup_url": null,
      "monthly_points_target": null,
      "no_credits_handoff_text": null,
      "overridden": [
        "holding_message",
      ],
      "pay_cancel_page_text": null,
      "pay_done_page_text": null,
      "purchase_link_open_text": null,
      "purchase_link_text": null,
      "purchase_offer_intro_text": null,
      "purchase_paid_booked_text": null,
      "purchase_paid_booking_failed_text": null,
      "purchase_paid_class_gone_text": null,
      "purchase_paid_no_class_text": null,
      "quiet_hours": null,
      "refund_request_text": null,
      "social_enabled": false,
      "test_mode": false,
      "test_phones": [],
      "tone": "Org tone",
      "trial_done": {
        "daily_cap": 20,
        "delay_hours": 2,
        "enabled": false,
        "followup_after_hours": 22,
        "followup_max_hours": 30,
        "followup_template": "hatch_trial_done_followup",
        "mia_instruction": "This customer finished their trial at {studio} on {date}, and we messaged them about carrying on. Help them choose between the Foundation membership and a class pack. Call list_purchase_options before naming any product or price, lead with the Foundation membership, and once they choose, send the payment link with send_purchase_link. Answer their questions honestly and never pressure them.",
        "nudge_after_hours": 3,
        "nudge_max_hours": 20,
        "only_contact_ids": [],
        "opener_template": "hatch_trial_done_checkin",
        "stale_after_hours": 24,
      },
      "trial_used_text": null,
      "un1t_chat_actions_enabled": false,
      "welcome_greeting": null,
    }
  `) })
  it('Hatch', async () => { expect(await noEditBody(HATCH_GET)).toMatchInlineSnapshot(`
    {
      "account_conflict_handoff_text": null,
      "agent_name": "Mia",
      "approval_decline_text": null,
      "auto_resolve_after_reply_hours": 8,
      "auto_resolve_stale_hours": 48,
      "booking_confirmation_text": null,
      "booking_cta_label": null,
      "booking_flow_text": null,
      "booking_issue_handoff_text": null,
      "booking_mode": "auto",
      "booking_url": null,
      "cancellation_confirmation_text": null,
      "cancellation_form": null,
      "chat_booking_unavailable_text": null,
      "class_move_confirmation_text": null,
      "comp_credits_confirmation_text": null,
      "consultation_event_type_id": null,
      "effort": null,
      "enabled": true,
      "event_move_confirmation_text": null,
      "event_move_failed_text": null,
      "extra_rules": null,
      "first_class_checkin": {
        "daily_cap": 20,
        "delay_hours": 2,
        "enabled": false,
        "template_name": null,
      },
      "flow_booking_ack_text": null,
      "flow_booking_duplicate_text": null,
      "flow_booking_holding_text": null,
      "flow_paid_trial_text": null,
      "followups": {
        "daily_cap": 50,
        "enabled": false,
        "nudge_after_hours": 3,
        "template_name": null,
      },
      "glofox_auto_cancel": false,
      "handoff_after_verify_failures": null,
      "handoff_cooldown_hours": 12,
      "handoff_sla_minutes": null,
      "holding_message": null,
      "inline_suggestion": {
        "enabled": true,
      },
      "limits": null,
      "link_button_text": null,
      "membership_cta_label": null,
      "membership_signup_url": null,
      "monthly_points_target": null,
      "no_credits_handoff_text": null,
      "overridden": [
        "purchase_offer_intro_text",
        "trial_used_text",
      ],
      "pay_cancel_page_text": null,
      "pay_done_page_text": null,
      "purchase_link_open_text": null,
      "purchase_link_text": null,
      "purchase_offer_intro_text": "Here is how you can keep training:",
      "purchase_paid_booked_text": null,
      "purchase_paid_booking_failed_text": null,
      "purchase_paid_class_gone_text": null,
      "purchase_paid_no_class_text": null,
      "quiet_hours": null,
      "refund_request_text": null,
      "social_enabled": false,
      "test_mode": false,
      "test_phones": [],
      "tone": null,
      "trial_done": {
        "daily_cap": 15,
        "delay_hours": 6,
        "enabled": true,
        "only_contact_ids": [],
      },
      "trial_used_text": "You have had your free trial already.",
      "un1t_chat_actions_enabled": false,
      "welcome_greeting": null,
    }
  `) })
  it('legacy full blob', async () => { expect(await noEditBody(LEGACY_FULL_BLOB_GET)).toMatchInlineSnapshot(`
    {
      "account_conflict_handoff_text": null,
      "agent_name": "Mia",
      "approval_decline_text": null,
      "auto_resolve_after_reply_hours": 8,
      "auto_resolve_stale_hours": 48,
      "booking_confirmation_text": null,
      "booking_cta_label": null,
      "booking_flow_text": null,
      "booking_issue_handoff_text": null,
      "booking_mode": "auto",
      "booking_url": null,
      "cancellation_confirmation_text": null,
      "cancellation_form": null,
      "chat_booking_unavailable_text": null,
      "class_move_confirmation_text": null,
      "comp_credits_confirmation_text": null,
      "consultation_event_type_id": null,
      "effort": null,
      "enabled": true,
      "event_move_confirmation_text": null,
      "event_move_failed_text": null,
      "extra_rules": null,
      "first_class_checkin": {
        "daily_cap": 20,
        "delay_hours": 2,
        "enabled": false,
        "template_name": null,
      },
      "flow_booking_ack_text": null,
      "flow_booking_duplicate_text": null,
      "flow_booking_holding_text": null,
      "flow_paid_trial_text": null,
      "followups": {
        "daily_cap": 40,
        "enabled": true,
        "nudge_after_hours": 4,
        "template_name": "nudge_v2",
      },
      "glofox_auto_cancel": false,
      "handoff_after_verify_failures": null,
      "handoff_cooldown_hours": 0,
      "handoff_sla_minutes": null,
      "holding_message": null,
      "inline_suggestion": {
        "enabled": true,
      },
      "limits": null,
      "link_button_text": null,
      "membership_cta_label": null,
      "membership_signup_url": null,
      "monthly_points_target": 600,
      "no_credits_handoff_text": null,
      "overridden": [
        "agent_name",
        "auto_resolve_after_reply_hours",
        "auto_resolve_stale_hours",
        "first_class_checkin.daily_cap",
        "first_class_checkin.delay_hours",
        "first_class_checkin.enabled",
        "followups.daily_cap",
        "followups.enabled",
        "followups.nudge_after_hours",
        "followups.template_name",
        "handoff_cooldown_hours",
        "inline_suggestion.enabled",
        "quiet_hours.end",
        "quiet_hours.start",
        "tone",
      ],
      "pay_cancel_page_text": null,
      "pay_done_page_text": null,
      "purchase_link_open_text": null,
      "purchase_link_text": null,
      "purchase_offer_intro_text": null,
      "purchase_paid_booked_text": null,
      "purchase_paid_booking_failed_text": null,
      "purchase_paid_class_gone_text": null,
      "purchase_paid_no_class_text": null,
      "quiet_hours": {
        "end": "07:00",
        "start": "21:00",
        "tz": null,
      },
      "refund_request_text": null,
      "social_enabled": false,
      "test_mode": true,
      "test_phones": [
        "+353871234567",
      ],
      "tone": "Warm",
      "trial_done": {
        "daily_cap": 20,
        "delay_hours": 2,
        "enabled": false,
        "followup_after_hours": 22,
        "followup_max_hours": 30,
        "followup_template": "hatch_trial_done_followup",
        "mia_instruction": "This customer finished their trial at {studio} on {date}, and we messaged them about carrying on. Help them choose between the Foundation membership and a class pack. Call list_purchase_options before naming any product or price, lead with the Foundation membership, and once they choose, send the payment link with send_purchase_link. Answer their questions honestly and never pressure them.",
        "nudge_after_hours": 3,
        "nudge_max_hours": 20,
        "only_contact_ids": [],
        "opener_template": "hatch_trial_done_checkin",
        "stale_after_hours": 24,
      },
      "trial_used_text": null,
      "un1t_chat_actions_enabled": false,
      "welcome_greeting": null,
    }
  `) })
  it('Hatch with no blob', async () => { expect(await noEditBody(HATCH_NO_BLOB_GET)).toMatchInlineSnapshot(`
    {
      "account_conflict_handoff_text": null,
      "agent_name": "Mia",
      "approval_decline_text": null,
      "auto_resolve_after_reply_hours": 8,
      "auto_resolve_stale_hours": 48,
      "booking_confirmation_text": null,
      "booking_cta_label": null,
      "booking_flow_text": null,
      "booking_issue_handoff_text": null,
      "booking_mode": "auto",
      "booking_url": null,
      "cancellation_confirmation_text": null,
      "cancellation_form": null,
      "chat_booking_unavailable_text": null,
      "class_move_confirmation_text": null,
      "comp_credits_confirmation_text": null,
      "consultation_event_type_id": null,
      "effort": null,
      "enabled": false,
      "event_move_confirmation_text": null,
      "event_move_failed_text": null,
      "extra_rules": null,
      "first_class_checkin": {
        "daily_cap": 20,
        "delay_hours": 2,
        "enabled": false,
        "template_name": null,
      },
      "flow_booking_ack_text": null,
      "flow_booking_duplicate_text": null,
      "flow_booking_holding_text": null,
      "flow_paid_trial_text": null,
      "followups": {
        "daily_cap": 50,
        "enabled": false,
        "nudge_after_hours": 3,
        "template_name": null,
      },
      "glofox_auto_cancel": false,
      "handoff_after_verify_failures": null,
      "handoff_cooldown_hours": 12,
      "handoff_sla_minutes": null,
      "holding_message": null,
      "inline_suggestion": {
        "enabled": true,
      },
      "limits": null,
      "link_button_text": null,
      "membership_cta_label": null,
      "membership_signup_url": null,
      "monthly_points_target": null,
      "no_credits_handoff_text": null,
      "overridden": [],
      "pay_cancel_page_text": null,
      "pay_done_page_text": null,
      "purchase_link_open_text": null,
      "purchase_link_text": null,
      "purchase_offer_intro_text": null,
      "purchase_paid_booked_text": null,
      "purchase_paid_booking_failed_text": null,
      "purchase_paid_class_gone_text": null,
      "purchase_paid_no_class_text": null,
      "quiet_hours": null,
      "refund_request_text": null,
      "social_enabled": false,
      "test_mode": false,
      "test_phones": [],
      "tone": null,
      "trial_done": {
        "daily_cap": 20,
        "delay_hours": 2,
        "enabled": false,
        "followup_after_hours": 22,
        "followup_max_hours": 30,
        "followup_template": "hatch_trial_done_followup",
        "mia_instruction": "This customer finished their trial at {studio} on {date}, and we messaged them about carrying on. Help them choose between the Foundation membership and a class pack. Call list_purchase_options before naming any product or price, lead with the Foundation membership, and once they choose, send the payment link with send_purchase_link. Answer their questions honestly and never pressure them.",
        "nudge_after_hours": 3,
        "nudge_max_hours": 20,
        "only_contact_ids": [],
        "opener_template": "hatch_trial_done_checkin",
        "stale_after_hours": 24,
      },
      "trial_used_text": null,
      "un1t_chat_actions_enabled": false,
      "welcome_greeting": null,
    }
  `) })
})

describe('round trip: one edit changes one key', () => {
  for (const e of EDIT_ONE_PER_SECTION) {
    it(`${e.section}: editing "${e.label}" changes only ${e.expectKey}`, async () => {
      const get = e.get ?? HATCH_GET
      await renderEditor(get)
      await saveNow()
      const base = lastPutBody()
      cleanup()

      await renderEditor(get)
      await editByLabel(e.label, e.value, { section: e.section })
      await saveNow()
      const edited = lastPutBody()

      expect(changedPaths(base, edited)).toEqual([e.expectKey])
      // Editing an inheritable field makes it the studio's own: it may join
      // `overridden`, and nothing else may.
      const added = edited.overridden.filter((p) => !base.overridden.includes(p))
      expect(added.every((p) => p === e.expectKey)).toBe(true)
      expect(base.overridden.every((p) => edited.overridden.includes(p))).toBe(true)
    })
  }
})
