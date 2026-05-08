// Sequences package — public surface.
//
// Every concrete piece of sequence logic lives in a sibling module:
//
//   audience.js       — contactMatchesSequenceAudience
//   cooldown.js       — findBlockedByCooldown
//   enrol.js          — enrolContacts
//   triggers.js       — webhook-driven triggerSequencesFor*
//   cron-triggers.js  — runEventReminderTriggers, runAnniversary, runInactivity
//   steps.js          — every step handler (email/whatsapp/sms/tag/field/branch/webhook/task)
//   scheduler.js      — runSequences + setEnrollmentStatus + helpers
//
// This file is the package barrel — `import { … } from '@/lib/sequences'`
// resolves here because `src/lib/sequences.js` no longer exists, so
// Node falls through to `src/lib/sequences/index.js`. Existing call
// sites continue to work; new code is free to import directly from
// the per-concern modules.

export { enrolContacts } from './enrol.js'
export {
  triggerSequencesForBooking,
  triggerSequencesForStatusChange,
  triggerSequencesForTagsAdded,
  triggerSequencesForRaceRegistered,
  triggerSequencesForRaceFinished,
  triggerSequencesForOrderStatus,
  triggerSequencesForFirstBooking,
} from './triggers.js'
export {
  runEventReminderTriggers,
  runAnniversaryTriggers,
  runInactivityTriggers,
} from './cron-triggers.js'
export { evaluateBranchPredicate, processBranchStep } from './steps.js'
export { runSequences, setEnrollmentStatus } from './scheduler.js'
