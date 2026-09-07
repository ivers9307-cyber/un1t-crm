// MAIL-REPLY-QUOTE.1 — the ONE text → HTML conversion for outbound mail the
// studio writes by hand (compose, reply, forward). It used to be three private
// copies, one per route, each carrying a TODO to collapse them.
//
// THIS IS THE WHOLE ANSWER TO HOSTILE INBOUND TEXT ON THE WIRE. Everything
// reaching it is PLAIN TEXT — the operator's words, the plain signature, and
// (on a forward or a reply) a stranger's `text_body` — and these three
// replacements escape it before it is wrapped. So markup never becomes markup;
// it is strictly stronger than sanitising, whose permissiveness is bought by
// the sandboxed iframe the thread renders into, an iframe a recipient's mail
// client does not have.
//
// EMAIL-TICKET.5: callers run this over the body WITH the plain signature
// already appended (see appendSignature), so the sign-off is escaped by
// exactly the same replacements as the words. Escape-then-concatenate would
// hand an operator a raw HTML injection point into outbound mail.

export function textToHtml(text) {
  const escaped = String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
  return `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;font-size:14px;line-height:1.5;white-space:pre-wrap;">${escaped}</div>`
}
