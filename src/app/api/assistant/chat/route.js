import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createServerClient } from '@/lib/supabase'
import { SYSTEM_PROMPT, TOOLS } from '@/lib/assistant-prompt'
import { getCurrentUser } from '@/lib/auth'
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
  move_deal:            'admin',
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

// Execute a tool call against the CRM
async function executeTool(toolName, input, context) {
  const db = createServerClient()
  const { locationId, role, userId } = context

  // Server-side permission check
  if (!checkToolPermission(toolName, role)) {
    return { error: `Permission denied: your role (${role}) does not have access to this action. Please ask a manager or owner for help.` }
  }

  switch (toolName) {
    case 'create_contact': {
      const { data, error } = await db.from('contacts').insert({
        name: input.name,
        email: input.email,
        phone: input.phone || null,
        lead_source: input.lead_source || 'other',
      }).select().single()
      if (error) return { error: error.message }
      return { success: true, contact: { id: data.id, name: data.name, email: data.email } }
    }

    case 'search_contacts': {
      const { data } = await db.from('contacts')
        .select('id, name, email, phone, pipeline_stage_slug, lead_source')
        .or(`name.ilike.%${input.query}%,email.ilike.%${input.query}%`)
        .limit(10)
      return { contacts: data || [], count: (data || []).length }
    }

    case 'create_shift': {
      const { data, error } = await db.from('shifts').insert({
        location_id: locationId,
        profile_id: input.profile_id,
        shift_template_id: input.shift_template_id,
        shift_date: input.shift_date,
        status: 'scheduled',
        published: false,
        created_by: context.userId,
      }).select('*, shift_templates(name), profiles!profile_id(full_name)').single()
      if (error) return { error: error.message }
      return { success: true, shift: { date: data.shift_date, staff: data.profiles?.full_name, template: data.shift_templates?.name } }
    }

    case 'list_staff': {
      const { data } = await db.from('profiles')
        .select('id, full_name, email, role, active')
        .eq('active', true)
        .order('full_name')
      return { staff: (data || []).map(s => ({ id: s.id, name: s.full_name, role: s.role })) }
    }

    case 'list_shift_templates': {
      const { data } = await db.from('shift_templates')
        .select('id, name, start_time, end_time, color')
        .eq('location_id', locationId)
        .eq('active', true)
        .order('display_order')
      return { templates: data || [] }
    }

    case 'get_shifts_for_week': {
      const startDate = input.start_date
      const endDate = new Date(new Date(startDate + 'T00:00:00').getTime() + 6 * 86400000).toISOString().split('T')[0]
      let query = db.from('shifts')
        .select('shift_date, status, profile_id, profiles!profile_id(full_name), shift_templates(name, start_time, end_time)')
        .eq('location_id', locationId)
        .gte('shift_date', startDate)
        .lte('shift_date', endDate)
        .order('shift_date')

      const { data } = await query
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

    case 'move_deal': {
      const { data: stage } = await db.from('pipeline_stages').select('id').eq('slug', input.stage_slug).single()
      if (!stage) return { error: `Stage "${input.stage_slug}" not found` }
      const { data, error } = await db.from('deals')
        .update({ stage_id: stage.id })
        .eq('id', input.deal_id)
        .select('id, title')
        .single()
      if (error) return { error: error.message }
      return { success: true, deal: data, moved_to: input.stage_slug }
    }

    case 'create_activity': {
      const record = {
        subject: input.subject,
        type: input.type,
        contact_id: input.contact_id || null,
        due_date: input.due_date || null,
        note: input.note || null,
        done: false,
      }
      const { data, error } = await db.from('activities').insert(record).select().single()
      if (error) return { error: error.message }
      return { success: true, activity: { id: data.id, subject: data.subject, type: data.type, due_date: data.due_date } }
    }

    case 'navigate_user': {
      return { action: 'navigate', path: input.path, reason: input.reason }
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
      let profileId = input.profile_id || userId
      if (!MANAGER_ROLES.includes(role) && input.profile_id && input.profile_id !== userId) {
        return { error: 'You can only view your own holiday allowance.' }
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
      // We can't easily call /api/schedule/reports internally with the
      // caller's auth context, so generate the report inline here.
      const reportType = input.report_type
      const periodStart = input.period_start
      const periodEnd = input.period_end

      if (reportType === 'staff_hours') {
        const { data: shifts } = await db.from('shifts')
          .select('shift_date, profile_id, profiles!profile_id(full_name), shift_templates(start_time, end_time)')
          .eq('location_id', locationId)
          .gte('shift_date', periodStart)
          .lte('shift_date', periodEnd)
          .order('shift_date')
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
        const { data: profiles } = await db.from('profiles').select('id, full_name, employment_type, annual_salary, hourly_rate, contracted_hours_per_week').eq('active', true)
        const { data: shifts } = await db.from('shifts')
          .select('shift_date, profile_id, shift_templates(start_time, end_time)')
          .eq('location_id', locationId)
          .gte('shift_date', periodStart)
          .lte('shift_date', periodEnd)
        const rateMap = {}
        for (const p of (profiles || [])) {
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
    currentPage: clientContext?.currentPage || '/',
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
- Today: ${new Date().toISOString().split('T')[0]}
`

  const systemPrompt = SYSTEM_PROMPT + contextBlock

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
