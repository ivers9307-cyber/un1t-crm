// FUNNEL.1 — acquisition-funnel classifier (operator-approved 2026-07-02).
//
// SHARED-CORE (FUNNEL-M.1): the classifier module is 100% pure (no
// imports, no IO), and the mobile pipeline screen needs the funnel
// taxonomy + splitStagesByFunnel — so the implementation moved to
// shared/pipeline-classifier.js, the only seam mobile can import across
// (repo invariant: mobile cannot import src/lib). Everything is
// re-exported here so every web caller — page.js, glofox-sync,
// pipeline-reclassify, ContactDrawer, and pipeline-classifier.test.js —
// keeps importing from '@/lib/pipeline-classifier' unchanged (same
// pattern as race-control.js / shared/race-control.js).
//
// Stage taxonomy, thresholds, and the war-story comments live with the
// implementation in shared/pipeline-classifier.js.
export {
  PIPELINE_THRESHOLDS,
  FUNNEL_STAGE_SLUGS,
  OFF_FUNNEL_STAGE_SLUGS,
  RETURNING_STAGE_SLUGS,
  returnEpisode,
  countAttendedBookings,
  nextBookedClass,
  classifyContact,
  splitStagesByFunnel,
} from '../../shared/pipeline-classifier'
