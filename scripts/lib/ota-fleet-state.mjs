// OTA-VISIBLE.1 — is the phone fleet running behind `main`?
//
// WHY THIS EXISTS, and why it is a PR check rather than another alarm.
//
// eas-update.yml publishes an OTA on every qualifying push to main, and it
// runs its own vitest gate first. On 2026-09-10 that gate hit an unrelated
// flaky test and the publish failed, so every change in PR #1668 — including
// a fix that stops mangled text going out to external recipients — sat on
// main and on nobody's phone for hours. The PR was green. The merge was
// clean. Nothing anyone looked at said otherwise.
//
// The workflow already had TWO fallbacks for this, and both are inert for the
// same reason:
//   • a red run on `main` — which eas-update.yml's own comment describes as
//     "the signal that was already proven not to reach anyone", because a
//     push to main has no PR to hang an X on;
//   • an auto-opened tracking issue — which worked perfectly (#1669 was filed
//     the same minute the run failed) and was still not read. This repo had
//     two open issues at the time, the older one untouched since 10 August.
//     An issue in a repo where nobody reads issues is a record, not a
//     notification.
//
// So this check does not add a third alarm on a surface nobody watches. It
// puts the fact on the ONE surface everyone in this estate demonstrably reads
// — the checks list of the pull request they are about to merge — at the
// moment it changes what they would do, because merging more code onto a main
// that cannot publish just lengthens the queue of work that is not shipping.
//
// 🔴 IT IS ADVISORY AND MUST STAY ADVISORY. Do not add it to branch
// protection. The fleet being behind is not a reason to refuse an unrelated
// PR — the author cannot fix it from there, and a check that blocks work it
// cannot help with gets routed around, which is how a signal dies. Red and
// unmissable, never blocking.

/**
 * The ground truth is the LAST COMPLETED run, not the last run.
 *
 * A publish in progress says nothing: it may be about to succeed. Reading it
 * as "unknown" and reporting the previous completed verdict is right, because
 * that verdict is what is true of the fleet right now.
 *
 * @param {{status?: string, conclusion?: string|null, databaseId?: number,
 *          headSha?: string, createdAt?: string}[]} runs
 *          EAS Update runs on main, NEWEST FIRST, as `gh run list` returns them.
 * @returns {{ behind: boolean, reason: string, run?: object }}
 */
export function fleetState(runs) {
  if (!Array.isArray(runs)) {
    // 🔴 FAILS OPEN, deliberately. An unreadable API answer is not evidence of
    // a broken fleet, and a check that reddens every PR on a network blip is
    // one people learn to ignore — which would cost exactly the signal this
    // exists to create.
    return { behind: false, reason: 'could not read the workflow history — reporting nothing' }
  }

  const completed = runs.filter(r => r && r.status === 'completed')
  if (completed.length === 0) {
    return { behind: false, reason: 'no completed EAS Update run to judge' }
  }

  const latest = completed[0]
  if (latest.conclusion === 'success') {
    return { behind: false, reason: 'the last completed publish succeeded', run: latest }
  }

  // `cancelled`, `skipped` and `neutral` are not failures and are not evidence
  // the fleet is behind: nothing was attempted, so the previous successful
  // publish still stands. Only a genuine failure means main moved and the
  // devices did not.
  if (latest.conclusion !== 'failure' && latest.conclusion !== 'timed_out') {
    return {
      behind: false,
      reason: `the last completed publish ended '${latest.conclusion}', which is not a failure`,
      run: latest,
    }
  }

  return {
    behind: true,
    reason: 'the last completed OTA publish FAILED, so main is ahead of the phone fleet',
    run: latest,
  }
}

/**
 * What the check says on a PR. One paragraph, no jargon, and it names the
 * action — a message that only states a fact makes the reader do the work of
 * deciding whether it matters.
 */
export function fleetMessage(state, repoUrl = '') {
  if (!state.behind) return `OTA fleet: up to date — ${state.reason}.`
  const runUrl = state.run?.databaseId && repoUrl
    ? `${repoUrl}/actions/runs/${state.run.databaseId}`
    : '(see Actions → EAS Update)'
  return [
    'OTA fleet is BEHIND main.',
    '',
    'The last completed EAS Update publish failed, so every mobile change merged',
    'since then is on main and on nobody\'s phone. Merging this PR is fine — it just',
    'joins the queue of work that is not shipping.',
    '',
    `Failed run: ${runUrl}`,
    '',
    'Fix the cause, then re-run Actions → EAS Update → Run workflow. It publishes from',
    'main HEAD, so one successful run delivers everything that has landed since.',
  ].join('\n')
}
