import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createServerClient } from '@/lib/supabase'
import { dublinTodayStr } from '@/lib/dublin-time'
import { fetchScheduledShiftRows } from '@/lib/report-generator'
import { upsertShiftAssignment } from '@/lib/roster-write'
import { SYSTEM_PROMPT, TOOLS } from '@/lib/assistant-prompt'
import { getCurrentUser } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import { validateBody } from '@/lib/validate'
import { MANAGER_ROLES, ADMIN_ROLES } from '@/lib/schemas'
import {
  splitSSEEvents,
  initTurn,
  applyAnthropicEvent,
  finalizeTurn,
  encodeClientEvent,
} from '@/lib/assistant-stream'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
// Streaming a tool-loop turn can run longer than the default; give it
// the same headroom as the heavier crons.
export const maxDuration = 60

const ChatRequestSchema = z.object({
  // Anthropic messages array — content can be string or block array, both valid.
  messages: z.array(z.object({
    role: z.enum(['user', 'assistant']),
    content: z.union([z.string(), z.array(z.unknown())]),
  })).min(1).max(200),
  // ASSIST-STREAM.1 — opt-in token streaming. When true the route
  // returns text/event-stream; when absent/false it returns the legacy
  // buffered JSON (kept as the client's automatic fallback).
  stream: z.boolean().optional(),
  // userContext is informational only — server overwrites role/locationId/userId
  // from the trusted session in the handler.
  userContext: z.object({
    currentPage: z.string().max(2000).optional(),
  }).passthrough().optional(),
})

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages'
const ASSISTANT_MODEL = 'claude-sonnet-4-20250514'
const MAX_TOOL_ITERATIONS = 5

// Role-based tool permissions — server-side enforcement
// 'all' = any role, 'manager' = owner/manager/head_coach, 'admin' = owner/manager only
const TOOL_PERMISSIONS = {
  navigate_user:        'all',
  get_shifts_for_week:  'all',       // staff see filtered results
  get_time_off:         'all',       // staff see filtered results
  get_holiday_allowance:'all',       // staff see own only
  search_contacts:      'manager',
  list_staff:           'manager',
  list_shift_templates: 'manager',
  create_shift:         'manager',
  create_contact:       'admin',
  // FUNNEL.1 — move_deal was removed: pipeline stages are classifier-
  // derived (webhook + nightly cron); a manual deals.stage_id write is
  // silently reverted by the next sync.
  create_activity:      'manager',
  generate_report:      'manager',
}

function checkToolPermission(toolName, role) {
  const level = TOOL_PERMISSIONS[toolName] || 'admin'
  if (level === 'all') return true
  if (level === 'manager') return MANAGER_ROLES.includes(role)
  if (level === 'admin') return ADMIN_ROLES.includes(role)
  return false
}

// Execute a tool call against the CRM.
//
// SECURITY (H2, 2026-06 platform audit): every tool runs through
// createServerClient() (service role → BYPASSES RLS), so app-layer
// scoping to context.locationId — the server-trusted active location,
// never client input — is the only thing confining the assistant to the
// caller's tenant. Tenant-data reads/writes below are scoped accordingly;
// see route.test.js for the regression guards.
export async function executeTool(toolName, input, context) {
  const db = createServerClient()
  const { locationId, role, userId } = context

  // Server-side permission check
  if (!checkToolPermission(toolName, role)) {
    return { error: `Permission denied: your role (${role}) does not have access to this action. Please ask a manager or owner for help.` }
  }

  switch (toolName) {
    case 'create_contact': {
      // Stamp the active location; never trust an input-supplied one.
      // Without a location this would insert a tenant-less orphan row.
      if (!locationId) return { error: 'No active location — switch to a location before creating a contact.' }
      const { data, error } = await db.from('contacts').insert({
        name: input.name,
        email: input.email,
        phone: input.phone || null,
        lead_source: input.lead_source || 'other',
        location_id: locationId,
      }).select().single()
      if (error) return { error: error.message }
      // AUTOMATIONS: glofox_lead_provisioning (assistant-created lead).
      try {
        const { maybeProvisionLeadInGlofox } = await import('@/lib/automations/glofox-lead-provisioning')
        await maybeProvisionLeadInGlofox({ db, locationId, contact: data, source: 'assistant' })
        const { triggerSequencesForContactCreated } = await import('@/lib/sequences/triggers')
        await triggerSequencesForContactCreated(data.id)
      } catch { /* hook never throws */ }
      return { success: true, contact: { id: data.id, name: data.name, email: data.email } }
    }

    case 'search_contacts': {
      // Scope to the active location — an unscoped search would match
      // contacts in every tenant. No location → no unscoped read.
      if (!locationId) return { contacts: [], count: 0 }
      const { data } = await db.from('contacts')
        .select('id, name, email, phone, pipeline_stage_slug, lead_source')
        .eq('location_id', locationId)
        .or(`name.ilike.%${input.query}%,email.ilike.%${input.query}%`)
        .limit(10)
      return { contacts: data || [], count: (data || []).length }
    }

    case 'create_shift': {
      if (!locationId) return { error: 'No active location — switch to a location before creating a shift.' }
      // RETIRE-SHIFTS-MIRROR.4 — writes the Roster v2 model (find-or-create
      // block + upsert assignment) instead of the legacy shifts table.
      // The helper validates template + profile against the location
      // (SAAS-1): a cross-tenant id errors before anything is written.
      const { template, error } = await upsertShiftAssignment(db, {
        locationId,
        profileId: input.profile_id,
        shiftTemplateId: input.shift_template_id,
        shiftDate: input.shift_date,
        actorId: context.userId,
      })
      if (error) return { error: error.message }
      // Friendly name for the response — the template comes back from the
      // validated fetch above, and profile_id was checked against
      // profile_locations inside the helper, so this bare-id read can only
      // hit an in-location staff member.
      const { data: prof } = await db.from('profiles').select('full_name').eq('id', input.profile_id).maybeSingle()
      return { success: true, shift: { date: input.shift_date, staff: prof?.full_name, template: template?.name } }
    }

    case 'list_staff': {
      // Scope to staff sharing the active location (mirror the
      // /api/staff list pattern) — an unscoped profiles read returns
      // every tenant's staff.
      if (!locationId) return { staff: [] }
      const { data: links } = await db.from('profile_locations')
        .select('profile_id')
        .eq('location_id', locationId)
      const profileIds = [...new Set((links || []).map(l => l.profile_id))]
      if (profileIds.length === 0) return { staff: [] }
      const { data } = await db.from('profiles')
        .select('id, full_name, email, role, active')
        .in('id', profileIds)
        .eq('active', true)
        .order('full_name')
      return { staff: (data || []).map(s => ({ id: s.id, name: s.full_name, role: s.role })) }
    }

    case 'list_shift_templates': {
      // No location → no unscoped read.
      if (!locationId) return { templates: [] }
      const { data } = await db.from('shift_templates')
        .select('id, name, start_time, end_time, color')
        .eq('location_id', locationId)
        .eq('active', true)
        .order('display_order')
      return { templates: data || [] }
    }

    case 'get_shifts_for_week': {
      // No location → no unscoped read.
      if (!locationId) return { shifts: [] }
      const startDate = input.start_date
      const endDate = new Date(new Date(startDate + 'T00:00:00').getTime() + 6 * 86400000).toISOString().split('T')[0]
      // RETIRE-SHIFTS-MIRROR.3 — reads shift_assignments+shift_blocks now.
      const data = await fetchScheduledShiftRows(db, { locationId, periodStart: startDate, periodEnd: endDate })
      data.sort((a, b) => String(a.shift_date).localeCompare(String(b.shift_date)))
      return {
        shifts: (data || []).map(s => ({
          date: s.shift_date,
          staff: s.profiles?.full_name,
          shift: s.shift_templates?.name,
          time: `${s.shift_templates?.start_time?.slice(0,5)}–${s.shift_templates?.end_time?.slice(0,5)}`,
          status: s.status,
        }))
      }
    }

    case 'create_activity': {
      if (!locationId) return { error: 'No active location for this action.' }
      // If linking to a contact, confirm it's in the caller's location
      // BEFORE inserting — and always stamp the active location_id.
      let contactId = null
      if (input.contact_id) {
        const { data: contact } = await db.from('contacts')
          .select('id')
          .eq('id', input.contact_id)
          .eq('location_id', locationId)
          .maybeSingle()
        if (!contact) return { error: 'Contact not found in your active location.' }
        contactId = contact.id
      }
      const record = {
        subject: input.subject,
        type: input.type,
        contact_id: contactId,
        location_id: locationId,
        due_date: input.due_date || null,
        note: input.note || null,
        done: false,
      }
      const { data, error } = await db.from('activities').insert(record).select().single()
      if (error) return { error: error.message }
      return { success: true, activity: { id: data.id, subject: data.subject, type: data.type, due_date: data.due_date } }
    }

    case 'navigate_user': {
      // input.path is handed to the client which router.push()es it verbatim.
      // Only allow internal app paths — an absolute or protocol-relative URL
      // would be an open redirect driven by (potentially injected) prompt content.
      const p = String(input.path || '')
      if (!p.startsWith('/') || p.startsWith('//')) {
        return { error: 'navigate_user: path must be an internal path starting with "/"' }
      }
      return { action: 'navigate', path: p, reason: input.reason }
    }

    case 'get_time_off': {
      let query = db.from('time_off_requests')
        .select('start_date, end_date, type, status, total_days, reason, profile_id, profiles!profile_id(full_name)')
        .eq('location_id', locationId)
        .lte('start_date', input.end_date)
        .gte('end_date', input.start_date)
        .order('start_date')
      if (input.status) query = query.eq('status', input.status)

      // Staff can only see their own time-off requests
      if (!MANAGER_ROLES.includes(role)) {
        query = query.eq('profile_id', userId)
      }

      const { data } = await query
      return {
        time_off: (data || []).map(t => ({
          staff: t.profiles?.full_name,
          type: t.type,
          start: t.start_date,
          end: t.end_date,
          days: t.total_days,
          status: t.status,
          reason: t.reason,
        }))
      }
    }

    case 'get_holiday_allowance': {
      // Staff can only check their own allowance
      const profileId = input.profile_id || userId
      if (!MANAGER_ROLES.includes(role) && profileId !== userId) {
        return { error: 'You can only view your own holiday allowance.' }
      }
      // Reading anyone else requires them to share the active location —
      // a bare profile_id would read any tenant's allowance (SAAS-1).
      // Self-reads skip the check so a caller without an active location
      // still sees their own.
      if (profileId !== userId) {
        if (!locationId) return { error: 'No active location for this action.' }
        const { data: link } = await db.from('profile_locations')
          .select('profile_id')
          .eq('profile_id', profileId)
          .eq('location_id', locationId)
          .maybeSingle()
        if (!link) return { error: 'Staff member not found in your active location.' }
      }
      const year = input.year || new Date().getFullYear()
      const { data } = await db.from('staff_allowances')
        .select('total_days, used_days, carried_over')
        .eq('profile_id', profileId)
        .eq('year', year)
        .single()
      if (!data) return { total_days: 20, used_days: 0, carried_over: 0, remaining: 20, year }
      return { ...data, remaining: data.total_days + data.carried_over - data.used_days, year }
    }

    case 'generate_report': {
      if (!locationId) return { error: 'No active location for this action.' }
      // We can't easily call /api/schedule/reports internally with the
      // caller's auth context, so generate the report inline here.
      const reportType = input.report_type
      const periodStart = input.period_start
      const periodEnd = input.period_end

      if (reportType === 'staff_hours') {
        // RETIRE-SHIFTS-MIRROR.3 — reads shift_assignments+shift_blocks now.
        const shifts = await fetchScheduledShiftRows(db, { locationId, periodStart, periodEnd })
        const staffHours = {}
        for (const s of (shifts || [])) {
          const name = s.profiles?.full_name || 'Unknown'
          if (!staffHours[name]) staffHours[name] = 0
          const st = s.shift_templates?.start_time
          const en = s.shift_templates?.end_time
          if (st && en) {
            const [sh, sm] = st.split(':').map(Number)
            const [eh, em] = en.split(':').map(Number)
            let hrs = (eh + em / 60) - (sh + sm / 60)
            if (hrs < 0) hrs += 24
            staffHours[name] += hrs
          }
        }
        const result = Object.entries(staffHours).map(([name, hours]) => ({ name, hours: Math.round(hours * 10) / 10 })).sort((a, b) => b.hours - a.hours)
        return { report: 'Staff Hours Worked', period: `${periodStart} to ${periodEnd}`, staff: result, total_hours: Math.round(result.reduce((s, r) => s + r.hours, 0) * 10) / 10 }
      }

      if (reportType === 'staff_cost') {
        // Rate data only for staff linked to the active location (mirror
        // list_staff) — an unscoped profiles read would expose every
        // tenant's salary data (SAAS-1).
        const { data: links } = await db.from('profile_locations')
          .select('profile_id')
          .eq('location_id', locationId)
        const profileIds = [...new Set((links || []).map(l => l.profile_id))]
        let profiles = []
        if (profileIds.length > 0) {
          const { data } = await db.from('profiles')
            .select('id, full_name, employment_type, annual_salary, hourly_rate, contracted_hours_per_week')
            .in('id', profileIds)
            .eq('active', true)
          profiles = data || []
        }
        // RETIRE-SHIFTS-MIRROR.3 — reads shift_assignments+shift_blocks now.
        const shifts = await fetchScheduledShiftRows(db, { locationId, periodStart, periodEnd })
        const rateMap = {}
        for (const p of profiles) {
          let rate = 0
          if (p.employment_type === 'contractor') rate = Number(p.hourly_rate) || 0
          else if (p.annual_salary && p.contracted_hours_per_week) rate = Number(p.annual_salary) / (Number(p.contracted_hours_per_week) * 52)
          rateMap[p.id] = { name: p.full_name, rate: Math.round(rate * 100) / 100 }
        }
        const costs = {}
        for (const s of (shifts || [])) {
          const p = rateMap[s.profile_id]
          if (!p) continue
          if (!costs[p.name]) costs[p.name] = { hours: 0, cost: 0, rate: p.rate }
          const st = s.shift_templates?.start_time
          const en = s.shift_templates?.end_time
          if (st && en) {
            const [sh, sm] = st.split(':').map(Number)
            const [eh, em] = en.split(':').map(Number)
            let hrs = (eh + em / 60) - (sh + sm / 60)
            if (hrs < 0) hrs += 24
            costs[p.name].hours += hrs
            costs[p.name].cost += hrs * p.rate
          }
        }
        const result = Object.entries(costs).map(([name, d]) => ({ name, hours: Math.round(d.hours * 10) / 10, cost: `€${(Math.round(d.cost * 100) / 100).toFixed(2)}`, hourly_rate: `€${d.rate.toFixed(2)}` })).sort((a, b) => parseFloat(b.cost.slice(1)) - parseFloat(a.cost.slice(1)))
        const totalCost = Object.values(costs).reduce((s, d) => s + d.cost, 0)
        return { report: 'Staff Cost Breakdown', period: `${periodStart} to ${periodEnd}`, currency: 'EUR', staff: result, total_cost: `€${(Math.round(totalCost * 100) / 100).toFixed(2)}` }
      }

      return { error: `Use the Reporting tab for ${reportType} reports — navigate to /schedule and click Reporting` }
    }

    default:
      return { error: `Unknown tool: ${toolName}` }
  }
}

export async function POST(request) {
  // Server-side auth — the role and location used for permission checks
  // MUST come from the session, not from the request body. Trusting
  // client-supplied userContext.role would let any caller pretend to be
  // an owner.
  const user = await getCurrentUser()
  if (!user) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  }

  // The `assistant` permission gates this route, mirroring the web AppShell
  // gate (hasPermission(user, 'assistant')). Web hides the bubble and mobile
  // hides the tile unless the user has it — enforce it server-side too so a
  // staff user (assistant defaults off) can't call the API directly.
  if (!hasPermission(user, 'assistant')) {
    return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 })
  }

  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) {
    return NextResponse.json({ success: false, error: 'ANTHROPIC_API_KEY not configured' }, { status: 500 })
  }

  const validation = await validateBody(request, ChatRequestSchema)
  if (!validation.ok) return validation.response
  const { messages, userContext: clientContext, stream: wantStream } = validation.data

  // Trusted context derived from the session. Display-only hints
  // (currentPage, permissions for UI) can still come from the client.
  const userContext = {
    name: user.full_name,
    role: user.role,
    userId: user.id,
    locationId: user.activeLocation?.id || null,
    locationName: user.activeLocation?.name || 'Unknown',
    // Client-supplied — sanitise before it lands in the system prompt below
    // (single line, length-capped) so a crafted value can't inject instructions.
    currentPage: String(clientContext?.currentPage || '/').split('\n')[0].slice(0, 120),
    permissions: user.permissions || {},
  }

  // Build the context-aware system prompt
  const contextBlock = `
## Current Session
- User: ${userContext.name} (${userContext.role})
- Current page: ${userContext.currentPage}
- Location: ${userContext.locationName}
- Location ID: ${userContext.locationId || 'none'}
- Permissions: ${JSON.stringify(userContext.permissions)}
- Today: ${dublinTodayStr()}
`

  // Prompt caching (CACHE.1): the static SYSTEM_PROMPT (~3.1k tokens) and the
  // tool definitions (which render BEFORE system, so the breakpoint below
  // covers them too) are re-sent on every turn of the tool loop and on every
  // request. Mark the static block ephemeral so repeat turns/requests read it
  // from cache (~0.1× input cost) instead of reprocessing it; only the small
  // dynamic contextBlock after the breakpoint is billed at full rate. No
  // anthropic-beta header needed — caching is GA on anthropic-version
  // 2023-06-01. SYSTEM_PROMPT + tools clear the model's 1024-token minimum.
  const systemPrompt = [
    { type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } },
    { type: 'text', text: contextBlock },
  ]

  // Filter tools to only those the user's role permits — using the
  // server-trusted role, not the client-supplied one.
  const allowedTools = TOOLS.filter(tool => checkToolPermission(tool.name, userContext.role))

  // Call Claude API
  let claudeMessages = messages.map(m => ({
    role: m.role,
    content: m.content,
  }))

  const toolContext = {
    locationId: userContext.locationId,
    userId: userContext.userId,
    role: userContext.role,
  }

  // ── Streaming path (ASSIST-STREAM.1) ────────────────────────────────
  // Opt-in via { stream: true }. Forwards Anthropic text deltas to the
  // client as SSE while still running the buffered tool-execution loop
  // between turns. The pure framing/accumulation logic is unit-tested in
  // assistant-stream.test.js; this function owns only the network + the
  // tool loop. The legacy buffered path below is untouched and is the
  // client's automatic fallback.
  if (wantStream) {
    const encoder = new TextEncoder()
    const sseStream = new ReadableStream({
      async start(controller) {
        const send = (obj) => controller.enqueue(encoder.encode(encodeClientEvent(obj)))
        let navigateTo = null
        try {
          let iterations = MAX_TOOL_ITERATIONS
          while (iterations-- > 0) {
            const res = await fetch(ANTHROPIC_API_URL, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'x-api-key': apiKey,
                'anthropic-version': '2023-06-01',
              },
              body: JSON.stringify({
                model: ASSISTANT_MODEL,
                max_tokens: 1024,
                system: systemPrompt,
                messages: claudeMessages,
                tools: allowedTools,
                stream: true,
              }),
            })
            if (!res.ok || !res.body) {
              const errText = await res.text().catch(() => 'stream_open_failed')
              send({ type: 'error', error: `Claude API error: ${errText}` })
              break
            }

            const reader = res.body.getReader()
            const decoder = new TextDecoder()
            const turn = initTurn()
            let buf = ''
            while (true) {
              const { done, value } = await reader.read()
              if (done) break
              buf += decoder.decode(value, { stream: true })
              const { events, rest } = splitSSEEvents(buf)
              buf = rest
              for (const evt of events) {
                const { textDelta } = applyAnthropicEvent(turn, evt)
                if (textDelta) send({ type: 'text', delta: textDelta })
              }
            }

            const { content, stopReason } = finalizeTurn(turn)

            if (stopReason === 'tool_use') {
              claudeMessages.push({ role: 'assistant', content })
              const toolResults = []
              for (const block of content) {
                if (block.type === 'tool_use') {
                  const result = await executeTool(block.name, block.input, toolContext)
                  if (result && result.action === 'navigate') navigateTo = result.path
                  toolResults.push({
                    type: 'tool_result',
                    tool_use_id: block.id,
                    content: JSON.stringify(result),
                  })
                }
              }
              claudeMessages.push({ role: 'user', content: toolResults })
              send({ type: 'tool' }) // lets the client show a "working…" beat
              continue
            }

            // Final turn — text already streamed. Close out.
            send({ type: 'done', navigateTo })
            controller.close()
            return
          }
          // Ran out of iterations without a non-tool turn.
          send({ type: 'done', navigateTo })
          controller.close()
        } catch (err) {
          try { send({ type: 'error', error: err?.message || 'stream_error' }) } catch { /* controller already closed */ }
          try { controller.close() } catch { /* already closed */ }
        }
      },
    })

    return new Response(sseStream, {
      headers: {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-store, no-transform',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
      },
    })
  }

  // ── Buffered path (legacy / fallback) ───────────────────────────────
  // Loop to handle tool use (Claude may call multiple tools)
  let maxIterations = MAX_TOOL_ITERATIONS
  let finalResponse = null

  while (maxIterations > 0) {
    maxIterations--

    const claudeRes = await fetch(ANTHROPIC_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1024,
        system: systemPrompt,
        messages: claudeMessages,
        tools: allowedTools,
      }),
    })

    if (!claudeRes.ok) {
      const errText = await claudeRes.text()
      return NextResponse.json({ success: false, error: `Claude API error: ${errText}` }, { status: 500 })
    }

    const claudeData = await claudeRes.json()

    // Check if Claude wants to use tools
    if (claudeData.stop_reason === 'tool_use') {
      // Add Claude's response to messages
      claudeMessages.push({ role: 'assistant', content: claudeData.content })

      // Execute each tool call. Context is the trusted server-derived
      // userContext built from the session — never the raw client input.
      const toolResults = []
      for (const block of claudeData.content) {
        if (block.type === 'tool_use') {
          const result = await executeTool(block.name, block.input, {
            locationId: userContext.locationId,
            userId: userContext.userId,
            role: userContext.role,
          })
          toolResults.push({
            type: 'tool_result',
            tool_use_id: block.id,
            content: JSON.stringify(result),
          })
        }
      }

      // Add tool results and continue the loop
      claudeMessages.push({ role: 'user', content: toolResults })
    } else {
      // Claude is done — extract text response
      finalResponse = claudeData
      break
    }
  }

  if (!finalResponse) {
    return NextResponse.json({ success: false, error: 'Assistant exceeded maximum tool iterations' }, { status: 500 })
  }

  // Extract text and any navigation actions from the response
  const textBlocks = finalResponse.content.filter(b => b.type === 'text')
  const text = textBlocks.map(b => b.text).join('\n')

  // Check if any tool results had navigation actions
  let navigateTo = null
  for (const msg of claudeMessages) {
    if (msg.role === 'user' && Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block.type === 'tool_result') {
          try {
            const result = JSON.parse(block.content)
            if (result.action === 'navigate') {
              navigateTo = result.path
            }
          } catch {}
        }
      }
    }
  }

  return NextResponse.json({
    response: text,
    navigateTo,
  })
}
