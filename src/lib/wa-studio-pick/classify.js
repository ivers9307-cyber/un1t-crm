// WASTUDIOPICK.1 (spec R2.3) — one model call reading ONE message to say
// which listed studio it is about. Runs outside Mia (whether she is on or
// off), metered to the receiving studio. Anything but a confident listed id
// is "unsure": the picker asks instead.
import { anthropicMessages } from '@/lib/anthropic'
import { getAiCapStatus } from '@/lib/usage-caps'
import { AGENT_MODEL } from '@/lib/agent/auto-reply'
import { logWarn } from '../log'

const TIMEOUT_MS = 8000

// anthropicMessages leaves a refused response's body unread; read it for the
// log only, and never let that read fail the call.
async function safeText(res) {
  try { return String(await res.text()) } catch { return '' }
}

function systemPrompt(studios) {
  const lines = studios.map((s) => `- id ${s.id}: ${s.name}${s.label && s.label !== s.name ? ` (also "${s.label}")` : ''}${s.keywords.length ? `; also known as: ${s.keywords.join(', ')}` : ''}`)
  return [
    'You route a WhatsApp message from a new customer of a gym group to the studio it is about.',
    'Studios:',
    ...lines,
    'Answer with the id of the studio the message is clearly about, and confident true, only when the message names or unmistakably points to that studio (its name, nickname, street or area).',
    'If it names none, names more than one, or you are guessing, answer studio "none" and confident false.',
  ].join('\n')
}

export async function classifyStudio({ text, studios, locationId }) {
  const msg = String(text || '').trim()
  if (!msg) return { studioId: null, reason: 'empty' }
  const cap = await getAiCapStatus({ locationId })
  if (cap?.capped) return { studioId: null, reason: 'capped' }
  const ids = studios.map((s) => s.id)
  const body = {
    model: AGENT_MODEL,
    max_tokens: 1024,
    thinking: { type: 'adaptive' },
    output_config: {
      effort: 'low',
      format: {
        type: 'json_schema',
        schema: {
          type: 'object',
          properties: { studio: { type: 'string', enum: [...ids, 'none'] }, confident: { type: 'boolean' } },
          required: ['studio', 'confident'],
          additionalProperties: false,
        },
      },
    },
    system: systemPrompt(studios),
    messages: [{ role: 'user', content: msg.slice(0, 2000) }],
  }
  let out
  try {
    out = await anthropicMessages(body, { locationId, source: 'wa_studio_pick', signal: AbortSignal.timeout(TIMEOUT_MS) })
  } catch (e) {
    logWarn('wa-studio-pick', 'classifier call failed', { locationId, err: e?.message || String(e) })
    return { studioId: null, reason: 'call_failed' }
  }
  if (!out?.res?.ok || !out.data) {
    logWarn('wa-studio-pick', 'classifier call refused', { locationId, status: out?.res?.status ?? null, body: (await safeText(out?.res)).slice(0, 200) })
    return { studioId: null, reason: 'call_failed' }
  }
  if (out.data.stop_reason === 'refusal') return { studioId: null, reason: 'refused' }
  const textBlock = (out.data.content || []).find((b) => b.type === 'text')
  let parsed
  try { parsed = JSON.parse(textBlock?.text || '') } catch { return { studioId: null, reason: 'unparseable' } }
  if (parsed?.confident === true && ids.includes(parsed.studio)) return { studioId: parsed.studio, reason: 'decided' }
  return { studioId: null, reason: 'unsure' }
}
