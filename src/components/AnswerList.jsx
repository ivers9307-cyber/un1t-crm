// AnswerList — QUESTIONS.1. The answers an entry or a person gave to the
// event's registration questions, as "Label: value" rows (answersForDisplay
// built them server-side). Renders nothing when there are none. Inherits the
// surface's text colour so it reads on the dark host portal and the light
// staff pages alike.

export default function AnswerList({ answers, className = '' }) {
  const rows = Array.isArray(answers) ? answers : []
  if (rows.length === 0) return null
  return (
    <dl className={`text-[11px] opacity-80 ${className}`}>
      {rows.map((a, i) => (
        <div key={i} className="inline-flex gap-1 mr-3">
          <dt className="font-medium">{a.label}:</dt>
          <dd>{a.value}</dd>
        </div>
      ))}
    </dl>
  )
}
