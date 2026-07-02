// NOTIF.3 — push-notification `data` payload → mobile route. The payloads
// are owned by the server's sendPush()/sendPushToRolesAtLocation() call
// sites (src/app/api/** and src/lib/**); this maps each data.type to an
// existing screen under mobile/app/ — a detail deep link when the payload
// carries the entity id, otherwise the most specific inbox/list.
//
// Return contract (mirrors today-feed-nav.js, plus an unknown marker):
//   string    — route to push
//   null      — known type, deliberately no navigation (e.g. admin test push)
//   undefined — unknown type; the caller logs it so new server payloads
//               surface as a console error instead of a silent dead tap.
//
// Routing choices that aren't obvious:
//   swaps (staff-recipient types) — the accept/decline + "my posted swaps"
//     cards live on the personal dashboard (home tab), not /schedule.
//   swap_open / swap_awaiting / time_off_inbound / expense_submitted — sent
//     to managers/owners; their decision queue is the /approvals inbox.
//   instagram fallback — the WhatsApp tab is the unified inbox (it lists IG
//     conversations too), and there is no /instagram index screen.
//   wa_quality / number_health / flow_health / template_status — WhatsApp
//     admin/health alerts; mobile has no WA-settings surface, so land on
//     the WhatsApp tab (the closest WA context that exists).
//   checklist_compliance — manager-side alert about a coach's checklist;
//     there is no manager checklist surface on mobile, so land on home
//     (the studio dashboard for managers).

export function routeForNotification(data) {
  if (!data?.type) return null
  switch (data.type) {
    // ── Tasks & bookings (cron/send-push-reminders) ─────────────────
    case 'task_reminder':
      return data.task_id ? `/tasks/${data.task_id}` : '/tasks'
    case 'booking_reminder':
      return data.booking_id ? `/bookings/${data.booking_id}` : '/(tabs)/bookings'

    // ── Shift swaps (schedule/swaps routes) ─────────────────────────
    case 'swap_inbound':   // targeted at me — respond on the dashboard
    case 'swap_claimed':   // my posted shift was claimed
    case 'swap_accepted':  // my targeted swap was accepted
    case 'swap_withdrawn': // taker withdrew — my shift is open again
    case 'swap_declined':  // my targeted swap was declined
      return '/(tabs)'
    case 'swap_open':      // manager: open swap posted
    case 'swap_awaiting':  // manager: swap awaiting approval
      return '/approvals'
    case 'swap_decision':  // requester/taker: final decision — roster changed
      return '/(tabs)/schedule'

    // ── Time off ────────────────────────────────────────────────────
    case 'time_off_inbound': // manager: new request
      return '/approvals'
    case 'time_off_decision': // staff: approved/declined
      return '/(tabs)/schedule'

    // ── Roster (roster-notify, rosters republish, assignment adjust) ─
    case 'schedule_published':
    case 'schedule_updated':
    case 'shift_adjusted':
      return '/(tabs)/schedule'

    // ── Leads (POST /api/contacts) ──────────────────────────────────
    case 'lead_new':
      return data.contact_id ? `/contacts/${data.contact_id}` : '/contacts'

    // ── Messaging (whatsapp webhook, instagram, agent handoffs) ─────
    case 'whatsapp_inbound':
    case 'whatsapp_agent_handoff':
      return data.conversation_id ? `/whatsapp/${data.conversation_id}` : '/(tabs)/whatsapp'
    case 'instagram_inbound':
    case 'instagram_agent_handoff':
      return data.conversation_id ? `/instagram/${data.conversation_id}` : '/(tabs)/whatsapp'

    // ── WhatsApp health / template alerts (webhooks + health cron) ──
    case 'wa_quality':
    case 'number_health':
    case 'flow_health':
    case 'template_status':
      return '/(tabs)/whatsapp'

    // ── Contractor invoices (invoices approve/decline) ──────────────
    case 'invoice_approved':
    case 'invoice_declined':
      return data.invoice_id ? `/invoices/${data.invoice_id}` : '/(tabs)/invoices'

    // ── FTE expenses (expenses submit/approve/decline) ──────────────
    case 'expense_submitted': // owner: awaiting approval
      return '/approvals'
    case 'expense_approved':
    case 'expense_declined':
      return data.claim_id ? `/expenses/${data.claim_id}` : '/(tabs)/expenses'

    // ── Contracts (contracts issue) ─────────────────────────────────
    case 'contract_issued':
      return data.contract_id ? `/contracts/${data.contract_id}` : '/contracts'

    // ── Checklists (cron/checklist-sweep) ───────────────────────────
    case 'checklist_overdue': // coach: their own unfinished checklist
      return '/checklists/today'
    case 'checklist_compliance': // manager: a coach's missed checklist
      return '/(tabs)'

    // ── Issues (issues create/resolve) ──────────────────────────────
    case 'issue_submitted': // owner/master: handler triage detail
      return data.issue_id ? `/issues/inbox/${data.issue_id}` : '/issues/inbox'
    case 'issue_resolved': // submitter: their own report detail
      return data.issue_id ? `/issues/${data.issue_id}` : '/issues'

    // ── Admin ───────────────────────────────────────────────────────
    case 'admin_test_push': // delivery test from /admin — no destination
      return null

    default:
      return undefined
  }
}
