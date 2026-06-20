// Pure push-copy builders for challenge events (cron). data.type 'challenge' → /challenges.
export function metricLabel(metric) {
  if (metric === 'points') return 'UN1T Points'
  if (metric === 'classes') return 'classes'
  if (metric === 'z4plus_minutes') return 'Z4+ minutes'
  return metric
}

export function buildChallengeStartPush(challenge) {
  return { title: `New challenge: ${challenge.name}`, body: "You're in — see the leaderboard.", data: { type: 'challenge' } }
}

export function buildChallengeResultPush({ challenge, winner = null, collective = null }) {
  let body
  if (challenge.mode === 'collective') {
    const hit = collective && collective.total >= collective.target
    body = hit
      ? `We smashed the goal — ${challenge.target} ${metricLabel(challenge.metric)}! 🎉`
      : `We reached ${Math.round((collective?.pct || 0) * 100)}% of the goal.`
  } else {
    body = winner ? `🏆 ${winner.name} took the top spot.` : 'The challenge has ended.'
  }
  return { title: `${challenge.name} — results`, body, data: { type: 'challenge' } }
}

export function buildCollectiveTargetPush(challenge) {
  return { title: `Goal reached: ${challenge.name} 🎉`, body: `The gym hit ${challenge.target} ${metricLabel(challenge.metric)}!`, data: { type: 'challenge' } }
}
