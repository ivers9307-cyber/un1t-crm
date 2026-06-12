# AGENT-FOLLOWUP — proactive follow-ups for Mia (spec, 2026-06-12)

**Status: SPEC ONLY — not built.** Requested by Richard 2026-06-12 alongside the
Tier-1 agent upgrades. The open question this answers: *"we are restricted to
the 24-hour chat window — what would the follow-up plan be if it was outside
the window?"*

## The problem

Mia is 100% reactive today. The highest-converting moment she misses: a lead
asks about a consultation or class, Mia answers (or offers slots), and the
person simply goes quiet. Industry agents (Keepme Antares et al.) win on
exactly this — the polite, persistent nudge.

## The WhatsApp window rules that shape the design

1. **Inside 24h of the customer's last inbound message** → free-form messages
   allowed. Mia can send anything she composes.
2. **Outside 24h** → ONLY Meta-approved **template** messages can be sent.
   Fixed text + `{{n}}` variables; category enforced by Meta.
3. **Any customer reply (including a button tap) re-opens the window** — after
   which Mia continues normally with zero extra work (the inbound webhook
   already runs her).
4. Category reality check: "you were asking about X — still interested?" is
   **MARKETING** in Meta's taxonomy (re-engagement), not utility. Submitting it
   as utility risks reclassification/quality strikes. So the out-of-window leg
   is consent-gated like a campaign (`whatsapp_marketing`) — which the
   lead-gen-campaign audience already satisfies by construction.

## The ladder (per "intent cycle")

An **intent cycle** starts when a conversation goes quiet with an open intent:
Mia's last message was a question/offer (e.g. listed consultation slots), the
customer hasn't replied, and no booking/audit action concluded the thread.
A new inbound message ends the cycle (and resets everything).

| Stage | When | Mechanism | Constraint |
|---|---|---|---|
| **1 — in-window nudge** | last inbound 3–20h old | **Mia-composed** contextual free-form message (one model call; she sees the thread, so the nudge references what they actually asked) | must send before the window shuts at 24h — the 20h ceiling leaves margin; Dublin daytime only (09:00–20:00) |
| **2 — out-of-window template** | last inbound 24–48h old AND stage 1 sent (or window missed) | ONE approved **marketing template**, e.g. `mia_followup_v1`: *"Hi {{1}}, Mia from UN1T here — you were asking about {{2}} yesterday. Want me to pick it back up? Just reply and I'll sort it for you."* Variables only; Mia picks `{{2}}` from the thread (e.g. "booking a consultation") | `whatsapp_marketing` consent required; template must be APPROVED; one shot, ever, per cycle |
| **3 — stop & hand to nurture** | no reply to stage 2 | tag the contact (`mia_followup_no_reply`) and stop. Long-cycle re-engagement belongs to the existing sequences/drips/radars — we do NOT rebuild that machinery inside Mia | the tag can trigger a sequence (`tag_added` trigger already exists) |

The key insight for outside-the-window: **the template's only job is to earn a
reply.** One tap/reply re-opens the 24h window and full-capability Mia takes
over automatically. We never try to conduct business through templates.

## Safety rails (all hard, all server-side)

- **Per-cycle cap:** max 2 proactive sends (one per stage), reset on any inbound.
- **Location daily cap:** settable, default 50 proactive sends/day — shares the
  spirit of the radar/drip pacing rules.
- **Quiet hours:** Dublin 09:00–20:00 only, both stages.
- **Skip list:** handed-off threads, resolved threads, agent disabled,
  test-mode non-allowlisted numbers, opted-out contacts, conversations where
  the open intent is a pause/cancellation (never chase those).
- **Audit:** every proactive send recorded in the thread (`source='agent'`)
  plus the structured no-send log line (`[radar-agent] followup-skip` with
  reason) so silence is always explainable — the #478/#479 lesson.
- **Default OFF:** `settings.customer_agent.followups.enabled` starts false;
  enable per location once the template is approved.

## Settings shape

```jsonc
"customer_agent": {
  "followups": {
    "enabled": false,
    "nudge_after_hours": 3,        // stage-1 trigger age
    "template_name": null,          // approved template for stage 2 (null = stage 2 off)
    "daily_cap": 50
  }
}
```

## Implementation sketch (when picked up)

1. **Detection** — new cron `/api/cron/agent-followups` every 15 min
   (heartbeat row + stampHeartbeat per house rules). Query
   `whatsapp_conversations` for candidates: agent active, not handed off /
   resolved, last message outbound from the agent and question-shaped intent
   open (v1 heuristic: an agent message exists after the last inbound and no
   `agent_membership_requests` row concluded the cycle), last inbound age in
   the stage's band, stage marker column (`agent_followup_stage` smallint +
   `agent_followup_last_inbound_at` snapshot — one small migration) not yet at
   that stage.
2. **Stage 1 send** — invoke the existing runner in a "nudge" mode: same
   system prompt + history + a synthetic instruction ("the customer went
   quiet — send ONE short, warm follow-up that moves their open request
   forward; no new questions beyond the one they left open"). Reuses caps,
   claim locking, recording, [[OPTIONS]] buttons.
3. **Stage 2 send** — `sendTemplateMessage` with the configured template +
   variables, recorded into the thread like radar outreach (#487 pattern).
4. **Reset** — the inbound webhook already runs on every reply; add
   `agent_followup_stage = 0` to the conversation update it makes.
5. **Tests** — pure candidate-selection + band logic red-first; the cron is a
   thin shell.

Estimated size: one migration (2 columns + heartbeat row), one cron route, ~60
lines of pure selection logic, prompt addition, settings UI block. One PR.

## Decisions Richard needs to make before build

1. Approve the stage-2 template copy (above) for Meta submission — or veto
   stage 2 entirely and run in-window-only (stage 1 alone is still a big win).
2. First scope: all open intents, or consultation-leads only (recommended —
   highest value, lowest risk)?
3. Daily cap comfort level (default 50).
