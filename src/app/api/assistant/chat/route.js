import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { SYSTEM_PROMPT, TOOLS } from '@/lib/assistant-prompt'

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages'

// Execute a tool call against the CRM
async function executeTool(toolName, input, context) {
  const db = createServerClient()
  const { locationId } = context

  switch (toolName) {
    case 'create_contact': {
      const { data, error } = await db.from('contacts').insert({
        name: input.name,
        email: input.email,
        phone: input.phone || null,
        lead_source: input.lead_source || 'other',
        lead_status: 'active_trial',
      }).select().single()
      if (error) return { error: error.message }
      return { success: true, contact: { id: data.id, name: data.name, email: data.email } }
    }

    case 'search_contacts': {
      const { data } = await db.from('contacts')
        .select('id, name, email, phone, lead_status, lead_source')
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
      const { data } = await db.from('shifts')
        .select('shift_date, status, profiles!profile_id(full_name), shift_templates(name, start_time, end_time)')
        .eq('location_id', locationId)
        .gte('shift_date', startDate)
        .lte('shift_date', endDate)
        .order('shift_date')
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

    default:
      return { error: `Unknown tool: ${toolName}` }
  }
}

export async function POST(request) {
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) {
    return NextResponse.json({ error: 'ANTHROPIC_API_KEY not configured' }, { status: 500 })
  }

  const body = await request.json()
  const { messages, userContext } = body

  if (!messages || !Array.isArray(messages)) {
    return NextResponse.json({ error: 'messages array is required' }, { status: 400 })
  }

  // Build the context-aware system prompt
  const contextBlock = `
## Current Session
- User: ${userContext?.name || 'Unknown'} (${userContext?.role || 'staff'})
- Current page: ${userContext?.currentPage || '/'}
- Location: ${userContext?.locationName || 'Unknown'}
- Location ID: ${userContext?.locationId || 'none'}
- Permissions: ${JSON.stringify(userContext?.permissions || {})}
- Today: ${new Date().toISOString().split('T')[0]}
`

  const systemPrompt = SYSTEM_PROMPT + contextBlock

  // Call Claude API
  let claudeMessages = messages.map(m => ({
    role: m.role,
    content: m.content,
  }))

  // Loop to handle tool use (Claude may call multiple tools)
  let maxIterations = 5
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
        tools: TOOLS,
      }),
    })

    if (!claudeRes.ok) {
      const errText = await claudeRes.text()
      return NextResponse.json({ error: `Claude API error: ${errText}` }, { status: 500 })
    }

    const claudeData = await claudeRes.json()

    // Check if Claude wants to use tools
    if (claudeData.stop_reason === 'tool_use') {
      // Add Claude's response to messages
      claudeMessages.push({ role: 'assistant', content: claudeData.content })

      // Execute each tool call
      const toolResults = []
      for (const block of claudeData.content) {
        if (block.type === 'tool_use') {
          const result = await executeTool(block.name, block.input, {
            locationId: userContext?.locationId,
            userId: userContext?.userId,
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
    return NextResponse.json({ error: 'Assistant exceeded maximum tool iterations' }, { status: 500 })
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
