// Pure presentation for the "Book your first visit" Flow. No I/O — the handler
// resolves live data and passes it in. FLOW_JSON is the asset published to Meta.
// State threading: each screen's returned `data` carries forward `path` (and the
// chosen `slot`) so the footer payloads can re-send them via ${data.*}. Meta only
// posts the fields named in each footer's payload, so state must be re-declared
// on every screen.
export const SCREEN = { DAY: 'DAY', SLOT: 'SLOT', DETAILS: 'DETAILS', CONFIRM: 'CONFIRM' }

export function dayScreen(days, path) {
  return { screen: SCREEN.DAY, data: { days, path } }
}
export function slotScreen({ day, slots, path }) {
  return { screen: SCREEN.SLOT, data: { day, slots, path } }
}
// UN1TWRITE.19 — `terms` drives the un1t.online terms and waiver OptIn: hidden
// and not required unless the studio's funnel needs it (the handler decides).
export function detailsScreen(prefill = {}, carry = {}, terms = {}) {
  return {
    screen: SCREEN.DETAILS,
    data: {
      name: prefill.name || '',
      email: prefill.email || '',
      marketing_opt_in: prefill.marketing_opt_in === false ? false : true,
      path: carry.path,
      slot: carry.slot,
      terms_required: terms.required === true,
      terms_label: terms.label || '',
      terms_url: terms.url || '',
      terms_accepted: terms.accepted === true,
      terms_error: terms.error || '',
    },
  }
}
export function confirmScreen(summary, selection) {
  return { screen: SCREEN.CONFIRM, data: { summary, selection } }
}

// The published Flow definition (Flow JSON v7.3 — the version WhatsApp Flow
// Builder currently accepts). Data-exchange screens declare dynamic props via
// ${data.*}; navigation posts back to the endpoint. Footer payloads forward
// carry state (path/slot) alongside the current form fields. NB: array screen
// data needs an `items` schema, prefills use Form `init-values` (not per-input
// `init-value`), and `${data.selection.*}` needs `selection` sub-properties —
// all v7.3 requirements Builder rejects otherwise. The published asset also
// carries a base64 header Image on the DAY screen (the entry screen); that's
// added at publish time by scripts/build-flow-json.mjs (kept out of source).
export const FLOW_JSON = {
  version: '7.3',
  data_api_version: '3.0',
  routing_model: { DAY: ['SLOT'], SLOT: ['DETAILS'], DETAILS: ['CONFIRM'], CONFIRM: [] },
  screens: [
    {
      id: SCREEN.DAY, title: 'Pick a day',
      data: { days: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, title: { type: 'string' } } }, __example__: [{ id: '2026-07-03', title: 'Thu 3 Jul' }] }, path: { type: 'string', __example__: 'class' } },
      layout: { type: 'SingleColumnLayout', children: [{
        type: 'Form', name: 'form', children: [
          { type: 'RadioButtonsGroup', name: 'day', label: 'Which day?', required: true, 'data-source': '${data.days}' },
          { type: 'Footer', label: 'Continue', 'on-click-action': { name: 'data_exchange', payload: { path: '${data.path}', day: '${form.day}' } } },
        ] }] },
    },
    {
      id: SCREEN.SLOT, title: 'Pick a time',
      data: { day: { type: 'string', __example__: '' }, slots: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, title: { type: 'string' } } }, __example__: [{ id: 'c1|2026-07-03T18:00:00Z|HIIT', title: '18:00 HIIT' }] }, path: { type: 'string', __example__: 'class' } },
      layout: { type: 'SingleColumnLayout', children: [{
        type: 'Form', name: 'form', children: [
          { type: 'RadioButtonsGroup', name: 'slot', label: 'Available times', required: true, 'data-source': '${data.slots}' },
          { type: 'Footer', label: 'Continue', 'on-click-action': { name: 'data_exchange', payload: { path: '${data.path}', slot: '${form.slot}' } } },
        ] }] },
    },
    {
      id: SCREEN.DETAILS, title: 'Your details',
      data: {
        name: { type: 'string', __example__: '' }, email: { type: 'string', __example__: '' }, marketing_opt_in: { type: 'boolean', __example__: true }, path: { type: 'string', __example__: 'class' }, slot: { type: 'string', __example__: '' },
        // UN1TWRITE.19 — the un1t.online terms and waiver OptIn.
        terms_required: { type: 'boolean', __example__: false }, terms_label: { type: 'string', __example__: '' }, terms_url: { type: 'string', __example__: '' }, terms_accepted: { type: 'boolean', __example__: false }, terms_error: { type: 'string', __example__: '' },
      },
      layout: { type: 'SingleColumnLayout', children: [{
        type: 'Form', name: 'form', 'init-values': { name: '${data.name}', email: '${data.email}', marketing_opt_in: '${data.marketing_opt_in}', terms_accepted: '${data.terms_accepted}' }, children: [
          { type: 'TextInput', name: 'name', label: 'Name', required: true },
          { type: 'TextInput', name: 'email', label: 'Email', 'input-type': 'email', required: true },
          { type: 'OptIn', name: 'marketing_opt_in', label: 'Keep me posted with offers and updates' },
          // Flow labels carry no links: tapping the label opens the terms page,
          // which links the waiver. Builder may refuse the bound `required`; if
          // so drop that one property (the handler's DETAILS check still holds).
          { type: 'OptIn', name: 'terms_accepted', label: '${data.terms_label}', visible: '${data.terms_required}', required: '${data.terms_required}', 'on-click-action': { name: 'open_url', url: '${data.terms_url}' } },
          { type: 'TextCaption', text: '${data.terms_error}' },
          { type: 'Footer', label: 'Review', 'on-click-action': { name: 'data_exchange', payload: { path: '${data.path}', slot: '${data.slot}', name: '${form.name}', email: '${form.email}', marketing_opt_in: '${form.marketing_opt_in}', terms_accepted: '${form.terms_accepted}' } } },
        ] }] },
    },
    {
      id: SCREEN.CONFIRM, title: 'Confirm', terminal: true,
      data: { summary: { type: 'string', __example__: '' }, selection: { type: 'object', properties: { path: { type: 'string' }, slot: { type: 'string' }, name: { type: 'string' }, email: { type: 'string' }, marketing_opt_in: { type: 'boolean' }, terms_accepted: { type: 'boolean' } }, __example__: { path: 'class', slot: '', name: '', email: '', marketing_opt_in: true, terms_accepted: false } } },
      layout: { type: 'SingleColumnLayout', children: [{
        type: 'Form', name: 'form', children: [
          { type: 'TextBody', text: '${data.summary}' },
          { type: 'Footer', label: 'Confirm booking', 'on-click-action': { name: 'complete', payload: { path: '${data.selection.path}', slot: '${data.selection.slot}', name: '${data.selection.name}', email: '${data.selection.email}', marketing_opt_in: '${data.selection.marketing_opt_in}', terms_accepted: '${data.selection.terms_accepted}' } } },
        ] }] },
    },
  ],
}
