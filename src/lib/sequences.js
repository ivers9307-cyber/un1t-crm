// Sequences package — public surface.
//
// As of the slice 3 refactor (audit item 3.1) every concrete piece
// of sequence logic lives under ./sequences/:
//
//   audience.js       — contactMatchesSequenceAudience
//   cooldown.js       — findBlockedByCooldown
//   enrol.js          — enrolContacts
//   triggers.js       — webhook-driven triggerSequencesFor*
//   cron-triggers.js  — runEventReminderTriggers, runAnniversary, runInactivity
//   steps.js          — every step handler (email/whatsapp/sms/tag/field/branch/webhook/task)
//   scheduler.js      — runSequences + setEnrollmentStatus + helpers
//
// This file is a barrel: it re-exports the public surface so every
// existing `import { … } from '@/lib/sequences'` in the codebase
// keeps working without churn. New imports should reach into the
// per-concern modules above.
//
// Slice 4 will replace this file with src/lib/sequences/index.js
// (true package barrel) and delete sequences.js. Holding off on
// that bigger move until everything else has settled.

export { enrolContacts } from './sequences/enrol.js'
export {
  triggerSequencesForBooking,
  triggerSequencesForStatusChange,
  triggerSequencesForTagsAdded,
  triggerSequencesForRaceRegistered,
  triggerSequencesForRaceFinished,
  triggerSequencesForOrderStatus,
  triggerSequencesForFirstBooking,
} from './sequences/triggers.js'
export {
  runEventReminderTriggers,
  runAnniversaryTriggers,
  runInactivityTriggers,
} from './sequences/cron-triggers.js'
export { evaluateBranchPredicate, processBranchStep } from './sequences/steps.js'
export { runSequences, setEnrollmentStatus } from './sequences/scheduler.js'
