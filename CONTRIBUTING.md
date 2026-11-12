# Contributing

The primary repository is on Forgejo; the GitHub repository is a read-only
mirror without CI. Send issues and pull requests to the primary repository.

```bash
cd docker
npm run lint   # node --check + bash -n
npm test       # unit + integration tests against a fake codex (no network, no auth)
```

- `server.js` has zero npm dependencies; please keep it that way.
- New behavior needs a test in the matching suite: `helpers.test.js`
  (pure logic), `bridge.test.js` / `lifecycle.test.js` (HTTP + app-server
  lifecycle), `supervisor.test.js` (shell supervision). The stateful fake in
  `test/support/fake-codex.mjs` stands in for the Codex CLI; protocol
  fixtures must follow the pinned release schemas, not product constants.
- `npm test` names the suites explicitly; do not rely on directory-wide
  discovery (it would pick up fixtures and the in-image smoke test).
- By contributing you agree that your contribution is licensed under
  Apache-2.0.
