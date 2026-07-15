// FLOW-GRAPH.4 — inverse of compile: existing sequence_steps → a flow
// graph for display + the one-time backfill. Pure. Node id = n<step_order>.

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

export function decompileStepsToGraph(steps, trigger) {
  if (!Array.isArray(steps) || steps.length === 0) {
    return { version: 1, trigger: trigger || { type: 'manual', config: {} }, nodes: [], edges: [] }
  }
  const sorted = [...steps].sort((a, b) => a.step_order - b.step_order)
  const idOf = (order) => `n${order}`
  const orders = new Set(sorted.map(s => s.step_order))

  const nodes = sorted.map(s => ({ id: idOf(s.step_order), type: s.step_type, config: nodeConfigFromStep(s) }))

  const edges = [{ from: 'trigger', to: idOf(sorted[0].step_order) }]
  for (let i = 0; i < sorted.length; i++) {
    const s = sorted[i]
    if (s.step_type === 'branch') {
      const c = s.config || {}
      if (c.then_step_order != null && orders.has(c.then_step_order)) {
        edges.push({ from: idOf(s.step_order), to: idOf(c.then_step_order), label: 'yes' })
      }
      if (c.else_step_order != null && orders.has(c.else_step_order)) {
        edges.push({ from: idOf(s.step_order), to: idOf(c.else_step_order), label: 'no' })
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
        edges.push({ from: idOf(s.step_order), to: idOf(marker) })
      } else {
        const next = sorted[i + 1]
        if (next) edges.push({ from: idOf(s.step_order), to: idOf(next.step_order) })
      }
    }
  }
  return { version: 1, trigger: trigger || { type: 'manual', config: {} }, nodes, edges }
}
