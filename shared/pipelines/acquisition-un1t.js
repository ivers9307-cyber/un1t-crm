// HATCHPIPE.2 — the acquisition board, fed from un1t.online instead of contacts.
//
// Same stages and the same classify() as the Glofox acquisition board, by
// reference: the rules are identical, only the inputs differ. inputSource tells
// the pipeline reclassifier to read this board's inputs from un1t.online
// (un1t_* mirror tables) rather than the contacts columns, so requiredFields
// is the identity set the reclassifier needs to place and report a row, not the
// contacts column list acquisition.js carries.
//
// A board that does not declare inputSource reads contacts (acquisition.js).

export { stages, classify } from './acquisition.js'

export const inputSource = 'un1t_online'

export const requiredFields = Object.freeze(['id', 'name', 'email', 'location_id'])
