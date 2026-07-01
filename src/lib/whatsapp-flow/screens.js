// Pure presentation for the "Book your first visit" Flow. No I/O — the handler
// resolves live data and passes it in. FLOW_JSON is the asset published to Meta.
// State threading: each screen's returned `data` carries forward `path` (and the
// chosen `slot`) so the footer payloads can re-send them via ${data.*}. Meta only
// posts the fields named in each footer's payload, so state must be re-declared
// on every screen.
export const SCREEN = { PATH: 'PATH', DAY: 'DAY', SLOT: 'SLOT', DETAILS: 'DETAILS', CONFIRM: 'CONFIRM' }

export function pathScreen() {
  return { screen: SCREEN.PATH, data: {} }
}
export function dayScreen(days, path) {
  return { screen: SCREEN.DAY, data: { days, path } }
}
export function slotScreen({ day, slots, path }) {
  return { screen: SCREEN.SLOT, data: { day, slots, path } }
}
export function detailsScreen(prefill = {}, carry = {}) {
  return { screen: SCREEN.DETAILS, data: { name: prefill.name || '', email: prefill.email || '', marketing_opt_in: true, path: carry.path, slot: carry.slot } }
}
export function confirmScreen(summary, selection) {
  return { screen: SCREEN.CONFIRM, data: { summary, selection } }
}

// The published Flow definition (Flow JSON v3.1). Data-exchange screens declare
// dynamic props via ${data.*}; navigation posts back to the endpoint. Footer
// payloads forward carry state (path/slot) alongside the current form fields.
export const FLOW_JSON = {
  version: '3.1',
  data_api_version: '3.0',
  routing_model: { PATH: ['DAY'], DAY: ['SLOT'], SLOT: ['DETAILS'], DETAILS: ['CONFIRM'], CONFIRM: [] },
  screens: [
    {
      id: SCREEN.PATH, title: 'Book your first visit',
      layout: { type: 'SingleColumnLayout', children: [{
        type: 'Form', name: 'form', children: [
          { type: 'RadioButtonsGroup', name: 'path', label: 'How would you like to start?', required: true,
            'data-source': [{ id: 'class', title: 'Free class' }, { id: 'consult', title: 'Consultation' }] },
          { type: 'Footer', label: 'Continue', 'on-click-action': { name: 'data_exchange', payload: { path: '${form.path}' } } },
        ] }] },
    },
    {
      id: SCREEN.DAY, title: 'Pick a day',
      data: { days: { type: 'array', __example__: [] }, path: { type: 'string', __example__: 'class' } },
      layout: { type: 'SingleColumnLayout', children: [{
        type: 'Form', name: 'form', children: [
          { type: 'RadioButtonsGroup', name: 'day', label: 'Which day?', required: true, 'data-source': '${data.days}' },
          { type: 'Footer', label: 'Continue', 'on-click-action': { name: 'data_exchange', payload: { path: '${data.path}', day: '${form.day}' } } },
        ] }] },
    },
    {
      id: SCREEN.SLOT, title: 'Pick a time',
      data: { day: { type: 'string', __example__: '' }, slots: { type: 'array', __example__: [] }, path: { type: 'string', __example__: 'class' } },
      layout: { type: 'SingleColumnLayout', children: [{
        type: 'Form', name: 'form', children: [
          { type: 'RadioButtonsGroup', name: 'slot', label: 'Available times', required: true, 'data-source': '${data.slots}' },
          { type: 'Footer', label: 'Continue', 'on-click-action': { name: 'data_exchange', payload: { path: '${data.path}', slot: '${form.slot}' } } },
        ] }] },
    },
    {
      id: SCREEN.DETAILS, title: 'Your details',
      data: { name: { type: 'string', __example__: '' }, email: { type: 'string', __example__: '' }, marketing_opt_in: { type: 'boolean', __example__: true }, path: { type: 'string', __example__: 'class' }, slot: { type: 'string', __example__: '' } },
      layout: { type: 'SingleColumnLayout', children: [{
        type: 'Form', name: 'form', children: [
          { type: 'TextInput', name: 'name', label: 'Name', required: true, 'init-value': '${data.name}' },
          { type: 'TextInput', name: 'email', label: 'Email', 'input-type': 'email', required: true, 'init-value': '${data.email}' },
          { type: 'OptIn', name: 'marketing_opt_in', label: 'Keep me posted with offers and updates', 'init-value': '${data.marketing_opt_in}' },
          { type: 'Footer', label: 'Review', 'on-click-action': { name: 'data_exchange', payload: { path: '${data.path}', slot: '${data.slot}', name: '${form.name}', email: '${form.email}', marketing_opt_in: '${form.marketing_opt_in}' } } },
        ] }] },
    },
    {
      id: SCREEN.CONFIRM, title: 'Confirm', terminal: true,
      data: { summary: { type: 'string', __example__: '' }, selection: { type: 'object', __example__: {} } },
      layout: { type: 'SingleColumnLayout', children: [{
        type: 'Form', name: 'form', children: [
          { type: 'TextBody', text: '${data.summary}' },
          { type: 'Footer', label: 'Confirm booking', 'on-click-action': { name: 'complete', payload: { path: '${data.selection.path}', slot: '${data.selection.slot}', name: '${data.selection.name}', email: '${data.selection.email}', marketing_opt_in: '${data.selection.marketing_opt_in}' } } },
        ] }] },
    },
  ],
}
