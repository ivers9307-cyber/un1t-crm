// FLOW-GRAPH.4 — inverse of compile: existing sequence_steps → a flow
// graph for display + the one-time backfill. Pure. Node id = n<step_order>.
//
// FLOW-DELAY.1 — sequence_steps carries delay_days/hours/minutes on EVERY
// row and the runner honours them whatever the step_type (scheduler.js:
// nextStepDelayMs is applied to the row it advances into). The graph
// vocabulary is narrower on purpose: a delay is a `wait` node, full stop.
// So a non-wait row with a non-zero delay decompiles into TWO nodes — a
// synthetic wait (`w<step_order>`) carrying the delay, then the action
// itself carrying none. Anything that pointed at the action (the trigger
// edge, a branch lane, a next_step_order jump, the previous row's
// fall-through) must point at the wait instead, or the delay is jumped
// over and lost.
//
// Without this, opening a template-installed automation in the builder and
// pressing Publish rewrote a seven-day drip into a burst of sends inside
// the hour: nodeConfigFromStep read the delay only for `wait`, and
// compileGraphToSteps stamps 0/0/0 on every non-wait row.

function nodeConfigFromStep(step) {
  switch (step.step_type) {
    case 'email':
      return { subject: step.subject ?? null, html_content: step.html_content ?? null, template_id: step.template_id ?? null }
    case 'whatsapp':
      return {
        template_id: step.whatsapp_template_id ?? null,
        variables: step.whatsapp_variables ?? {},
        header_media_url: step.whatsapp_header_media_url ?? null,
      }
    case 'sms':
      return { body: step.sms_body ?? null }
    case 'wait':
      return { days: step.delay_days ?? 0, hours: step.delay_hours ?? 0, minutes: step.delay_minutes ?? 0 }
    case 'branch': {
      // strip the pointer keys — they become edges
      const { then_step_order, else_step_order, ...rest } = step.config || {}
      void then_step_order; void else_step_order
      return rest
    }
    default: {
      // strip the successor marker — it becomes an edge (or its absence)
      const { next_step_order, ...rest } = step.config || {}
      void next_step_order
      return rest
    }
  }
}

function delayOf(step) {
  return { days: step.delay_days ?? 0, hours: step.delay_hours ?? 0, minutes: step.delay_minutes ?? 0 }
}

function hasDelay(d) {
  return Boolean(d.days || d.hours || d.minutes)
}

export function decompileStepsToGraph(steps, trigger) {
  if (!Array.isArray(steps) || steps.length === 0) {
    return { version: 1, trigger: trigger || { type: 'manual', config: {} }, nodes: [], edges: [] }
  }
  const sorted = [...steps].sort((a, b) => a.step_order - b.step_order)
  const idOf = (order) => `n${order}`
  const waitIdOf = (order) => `w${order}`
  const orders = new Set(sorted.map(s => s.step_order))

  // FLOW-DELAY.1 — which rows need a synthetic wait in front of them.
  // A real `wait` row is left alone: its delay is already the node's.
  const lifted = new Map()
  for (const s of sorted) {
    if (s.step_type === 'wait') continue
    const d = delayOf(s)
    if (hasDelay(d)) lifted.set(s.step_order, d)
  }
  // Where an edge aimed at this step must actually land.
  const entryOf = (order) => (lifted.has(order) ? waitIdOf(order) : idOf(order))

  const nodes = sorted.flatMap(s => {
    const action = { id: idOf(s.step_order), type: s.step_type, config: nodeConfigFromStep(s) }
    const delay = lifted.get(s.step_order)
    return delay ? [{ id: waitIdOf(s.step_order), type: 'wait', config: delay }, action] : [action]
  })

  const edges = [{ from: 'trigger', to: entryOf(sorted[0].step_order) }]
  for (let i = 0; i < sorted.length; i++) {
    const s = sorted[i]
    if (lifted.has(s.step_order)) {
      edges.push({ from: waitIdOf(s.step_order), to: idOf(s.step_order) })
    }
    if (s.step_type === 'branch') {
      const c = s.config || {}
      if (c.then_step_order != null && orders.has(c.then_step_order)) {
        edges.push({ from: idOf(s.step_order), to: entryOf(c.then_step_order), label: 'yes' })
      }
      if (c.else_step_order != null && orders.has(c.else_step_order)) {
        edges.push({ from: idOf(s.step_order), to: entryOf(c.else_step_order), label: 'no' })
      }
    } else {
      // SEQ-TERMINAL — graph-compiled steps carry their real successor in
      // config.next_step_order ('end' | step_order). Honour it: 'end' means
      // no out-edge (a terminal arm), an integer means the edge may jump
      // over another arm's rows. Only legacy rows without the marker keep
      // the linear next-row wiring.
      const marker = (s.config || {}).next_step_order
      if (marker === 'end') continue
      if (Number.isInteger(marker) && orders.has(marker)) {
        edges.push({ from: idOf(s.step_order), to: entryOf(marker) })
      } else {
        const next = sorted[i + 1]
        if (next) edges.push({ from: idOf(s.step_order), to: entryOf(next.step_order) })
      }
    }
  }
  return { version: 1, trigger: trigger || { type: 'manual', config: {} }, nodes, edges }
}
