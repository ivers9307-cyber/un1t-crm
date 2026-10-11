// Pure push-copy builders for challenge events (cron). data.type 'challenge' → /challenges.
//
// W1.S1a — the points metric is the studio's own product, productName on the
// SHORT brand (org_settings.short_name; "UN1T" → "UN1T Points"). These
// builders have no location in scope, so the caller (the run-challenge-events
// cron) resolves `shortName` from the challenge's location and passes it in;
// without one the label is the bare "Points", never another gym's.
import { productName } from './brand-name.js'

export function metricLabel(metric, shortName = '') {
  if (metric === 'points') return productName(shortName, 'points')
  if (metric === 'classes') return 'classes'
  if (metric === 'z4plus_minutes') return 'Z4+ minutes'
  return metric
}

export function buildChallengeStartPush(challenge) {
  return { title: `New challenge: ${challenge.name}`, body: "You're in. See the leaderboard.", data: { type: 'challenge' } }
}

export function buildChallengeResultPush({ challenge, winner = null, collective = null, shortName = '' }) {
  let body
  if (challenge.mode === 'collective') {
    const hit = collective && collective.total >= collective.target
    body = hit
      ? `We smashed the goal: ${challenge.target} ${metricLabel(challenge.metric, shortName)}! 🎉`
      : `We reached ${Math.round((collective?.pct || 0) * 100)}% of the goal.`
  } else {
    body = winner ? `🏆 ${winner.name} took the top spot.` : 'The challenge has ended.'
  }
  return { title: `${challenge.name}: results`, body, data: { type: 'challenge' } }
}

export function buildCollectiveTargetPush(challenge, { shortName = '' } = {}) {
  return { title: `Goal reached: ${challenge.name} 🎉`, body: `The gym hit ${challenge.target} ${metricLabel(challenge.metric, shortName)}!`, data: { type: 'challenge' } }
}
