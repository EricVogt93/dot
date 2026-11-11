# Dots / Work local computer connector (experimental)

> [!WARNING]
> This connector uses **undocumented ChatGPT backend endpoints** and sets
> `CODEX_INTERNAL_ORIGINATOR_OVERRIDE=codex_work_desktop`, so the Codex CLI
> identifies itself like the ChatGPT desktop app. It may break at any time and
> may not be permitted by the terms of your account or workspace. Check them
> before enabling it. It is **off by default** and not covered by any
> stability promise.

When `DOT_DOTS_EXECUTOR=1`, the entrypoint runs `docker/dots-executor.sh`,
which:

1. registers a local executor with `POST {DOT_CHATGPT_BASE_URL}/flora/cca/executor`;
2. runs `codex exec-server --remote {DOT_DOTS_REMOTE_URL} --environment-id <id>`
   and restarts it if it exits;
3. attaches the executor to the primary Dot via
   `/tbo/{tbo}/computers/{env}/connect-and-replace`, re-checking every
   `DOT_DOTS_POLL_SECONDS`.

State lives in `/data/codex`: `.tpp-local-executor-installation-id`,
`.dots-executor-environment-id`, `dots-executor.log`, `dots-exec-server.log`.

## Variables

| Variable | Default | Meaning |
|---|---|---|
| `DOT_DOTS_EXECUTOR` | `0` | `1` enables the connector |
| `DOT_DOTS_NAME` | hostname | Display name in the Dot's Computers list |
| `DOT_DOTS_ATTACH` | `1` | Attach to the Dot automatically |
| `DOT_DOTS_TBO_THREAD_ID` | auto (`/tbo/primary`) | Explicit Dot thread id |
| `DOT_DOTS_TBO_ID` | auto (`/tbo/by-thread`) | Explicit TBO id |
| `DOT_DOTS_POLL_SECONDS` | `60` | Attachment re-check interval |
| `DOT_DOTS_CONCURRENT_REQUESTS` | `32` | `exec-server` concurrency |
| `DOT_DOTS_REMOTE_URL` | `https://codex-cloud-environments.chatgpt.com/api` | Rendezvous API |
| `DOT_CHATGPT_BASE_URL` | `https://chatgpt.com/backend-api` | Registration API |

## Security

The connector gives the Dot/Work agent shell access to the container and
`/workspace`. Enable it only for dedicated sandboxes, protect `/data` (it holds
`auth.json`), and prefer a dedicated ChatGPT account or workspace.
