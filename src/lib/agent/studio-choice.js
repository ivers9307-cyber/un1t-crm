// src/lib/agent/studio-choice.js — MIAASKSTUDIO.1
//
// When the person's memberships do not tell Mia which studio she is answering
// for (accounts at several studios, active at none: answerableStudios' choices),
// she asks them, or reads it off the thread, and calls choose_studio. The
// runner (auto-reply.js) keeps the answer on the WhatsApp conversation
// (agent_chosen_location_id, mig 780) and re-plans the turn, so that studio's
// tools (at a un1t.online studio: the purchase tools) are there from the next
// iteration of the same turn and on every later turn.
//
// Pure: the tool definition, the prompt block and the name matcher. The write
// lives in the runner, next to the other conversation writes.

export const CHOOSE_STUDIO_TOOL_NAME = 'choose_studio'

export const CHOOSE_STUDIO_TOOL = Object.freeze({
  name: CHOOSE_STUDIO_TOOL_NAME,
  description:
    'Record which studio this customer means, when the prompt says you do not know yet. Call it as soon as they ' +
    'tell you, or when the conversation already makes it plain (they are replying to that studio\'s message, or ' +
    'name it). Pass the studio name exactly as the prompt lists it. After it succeeds you have that studio\'s tools: ' +
    'carry on with what they asked for in the same reply.',
  input_schema: {
    type: 'object',
    properties: {
      studio: { type: 'string', description: 'The studio name, exactly as listed in the prompt.' },
    },
    required: ['studio'],
  },
})

const norm = (v) => String(v || '').toLowerCase().replace(/\bun1t\b/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim()

/**
 * The listed studio a name means, or null. Exact (case and the "UN1T" prefix
 * ignored) first, then the one studio whose name contains it ("Hatch").
 * Never guesses between two. Pure.
 */
export function matchStudioChoice(choices, input) {
  const want = norm(input)
  if (!want || !Array.isArray(choices)) return null
  const exact = choices.filter((c) => norm(c?.name) === want)
  if (exact.length === 1) return exact[0]
  const partial = choices.filter((c) => {
    const name = norm(c?.name)
    return name && (name.includes(want) || want.includes(name))
  })
  return partial.length === 1 ? partial[0] : null
}

/** The uncached prompt block for a turn with studio choices, '' without. Pure. */
export function buildStudioChoiceBlock(choices) {
  const names = (Array.isArray(choices) ? choices : []).map((c) => c?.name).filter(Boolean)
  if (names.length < 2) return ''
  const list = names.map((n) => `"${n}"`).join(', ')
  return '## Which studio?\n' +
    `This person has an account at more than one studio (${list}) and is not an active member at any of them, so you do not know yet which studio they mean. ` +
    'If the conversation already makes it plain (they are replying to one studio\'s message, or they name it), call choose_studio with that studio straight away, without asking. ' +
    'Otherwise, before you answer anything that depends on the studio (buying a membership or classes, booking, their account), ask which studio they mean, offering the names as tap choices, and call choose_studio when they answer. ' +
    'Once it succeeds, carry on with what they asked for in the same reply.'
}
