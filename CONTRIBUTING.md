# Contributing

The primary repository is on Forgejo; the GitHub repository is a read-only
mirror without CI. Send issues and pull requests to the primary repository.

```bash
cd docker
npm run lint   # node --check + bash -n
npm test       # unit + integration tests against a fake codex (no network, no auth)
```

- `server.js` has zero npm dependencies; please keep it that way.
- New behavior needs a test in `docker/test/`. `fake-codex.mjs` stands in for
  the Codex CLI.
- By contributing you agree that your contribution is licensed under
  Apache-2.0.
