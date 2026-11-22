# independent host entry review

## verdict

approved for the frozen candidate below. no outstanding correctness, security, or compatibility blocker remains in the reviewed change. this is a source review and evidence assessment, not a production promotion receipt.

base: `947b7d890333a35a177e52d0fa5d82f59769e1ac`, branch `cap/browser-auth-entry-20261122`.

| source | reviewed sha256 |
|---|---|
| `packages/client/connection/src/browser-auth.ts` | `a1c9d3a0d466d7296e72e0b22d052238db64894b4db52cfde3d3c4764b6a6257` |
| `packages/host/frontend-static/src/index.ts` | `02c44d5cacd9d55d74a6e3c8b75eb4b2f02e6f550d41839ee615148765c08698` |
| `.proof/bundles/exo-overlay/lib/boot.js` | `9be748e02e50dd259b0e49ac3bb3376db72b263e34c47899dd4f9126fe672ef0` |
| `.proof/bundles/exo-overlay/lib/entry-recovery.js` | `255818b242fbba0564ac476779a7463f129a503661d7830dc1eb021fc8c9f0c0` |

## resolved finding

the first manual Continue anchor dropped the browser fragment when JavaScript was disabled. an actual Firefox regression reproduced that failure. the replacement is an omitted-action GET form with escaped, cleaned hidden query fields and a same-origin form-action policy. final Firefox proof verifies the proxy path, duplicate queries, fragment, and removal of the token and continuation marker. the scripted continuation independently retains the fragment.

## review conclusions

- browser entry still requires the existing token or trusted-mesh grant. the new document branch does not change signing, authority binding, expiry, HttpOnly, SameSite=Strict, or native TLS Secure-cookie behavior.
- the continuation marker is not an authorization grant. a missing cookie stops automatic navigation; a valid cookie permits cleanup. non-document launch exchange remains 303, and the independent API connect/trust paths remain unchanged.
- retained query values are data, not navigation targets. the landing uses a relative continuation, escaped attributes, a nonce for its only script, no external resources, no-store, no-referrer, base-uri none, and frame-ancestors none.
- frontend-static catches only an explicit Response thrown by its trusted index renderer after authentication. GET preserves its status/headers/body; HEAD cancels and omits its body. unexpected errors retain the previous error path.
- the overlay response propagates through the existing boot-selector/index-render path. it reports 404 and offers an explicit same-directory link that retains panel/chat/other query values while removing exo_overlay and auth bookkeeping. it does not automatically select a fallback, recreate files, or modify toggles.
- all deployed overlay preimage hashes were checked against the actual recorded source. candidate files remain identical except the bounded boot.js change and the new entry-recovery.js file. valid overlay composition remains unchanged.

## evidence inspected

- [final Firefox receipt](firefox-final/receipt.json): complete, 11 passing checks, source hash equal to the reviewed browser-auth source. covers direct/cross-site entry, proxy mount, scripted and no-JavaScript fragment handling, Strict/HttpOnly cookies, bounded cookie-disabled behavior, desktop-style 303, and foreign/opaque Origin, cross-site metadata, and untrusted Host API refusals.
- [focused regression](final-tests.log): 97 passed across six suites, including existing browser authentication, API trust, native connection, desktop document exchange, the new landing cases, and the real-Loader frontend-static response case.
- [overlay regression](overlay-unit-green.log): 3 passed; no-state-creation recovery, escaping/same-origin behavior, and valid/invalid overlay behavior.
- [final artifact build](final-build-artifacts.log): 8 passed, 0 failed.
- independent `git diff --text --check`: passed.

## delivery boundary

the implementation agent owns remaining repository gate results in [final-gates.json](final-gates.json). at the time this review was written, the final artifact build had passed and build:check was running; the subsequent GUI gate had not yet reported. these gates are not represented here as complete.

the reviewer made no product edits, live changes, production requests, actor mutations, or service restarts. only this review note was written.
