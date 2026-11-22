/** Safe recovery for an absent named overlay, before its client composition can load. */
function escapeAttribute(value) {
  return value.replaceAll('&', '&amp;').replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}

/** Preserve this document's current workspace query while removing the unavailable selector. */
export function missingOverlayResponse(url, runId) {
  const parameters = new URLSearchParams()
  for (const [key, value] of url.searchParams) {
    if (!['exo_overlay', 'token', '__dsh_auth_continue'].includes(key)) parameters.append(key, value)
  }
  const query = parameters.toString()
  const href = query === '' ? './' : './?' + query
  return new Response('<!doctype html><html lang="en"><head><meta charset="utf-8">'
    + '<meta name="viewport" content="width=device-width, initial-scale=1">'
    + '<title>Workspace view unavailable</title></head><body>'
    + '<main data-testid="overlay-entry-unavailable"><h1>This workspace view is unavailable</h1>'
    + '<p>The ' + escapeAttribute(runId) + ' overlay has no saved UI files on this server.</p>'
    + '<p>Your current workspace is available below.</p>'
    + '<a href="' + escapeAttribute(href) + '">Open current workspace</a></main></body></html>', {
    status: 404,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
    },
  })
}
