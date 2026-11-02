// HATCH39 — UN1T Hatch Street's €39 Trial board: the Stillorgan module's
// stages and rules by reference (shared/pipelines/paid-trial.js), fed from the
// un1t.online mirror. inputSource tells the orchestrator to read this board's
// people from the location's membership read adapter (pipelineInputs), not
// from contacts columns; the claim is the snapshot's paid_trial_at /
// paid_trial_expires_at (paidClaimFromSnapshot), judged by the router.
// Spec: docs/superpowers/specs/2026-11-01-hatch-paid-trial-board-design.md

export { stages, classify } from './paid-trial.js'

export const inputSource = 'un1t_online'

export const requiredFields = Object.freeze(['id', 'name', 'email', 'location_id'])
