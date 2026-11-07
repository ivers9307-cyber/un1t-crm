// PIPEBUILD.3b — the offer board module for un1t.online studios (Hatch Street).
// Same stages, claim rule and classifier as `offer` (./offer.js, by reference);
// only the way people reach it differs: inputSource tells the orchestrator to
// read this board's people from the location's membership read adapter
// (pipelineInputs), not from contacts columns. Stages come from config.

export { stagesFor, classify, offerClaimLive } from './offer.js'

export const inputSource = 'un1t_online'

export const stages = Object.freeze([])

export const requiredFields = Object.freeze(['id', 'name', 'email', 'location_id'])
