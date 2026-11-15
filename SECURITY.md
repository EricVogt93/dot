# Security policy

dotcker exposes an agent with shell access through an HTTP API. Treat it as a
remote-code-execution endpoint.

## Reporting a vulnerability

Please do not open a public issue. Report privately to the maintainer
(see the contact in the repository profile or `git log`) with reproduction
steps. You will get a response within a few days.

## Hardening defaults

- The API binds `127.0.0.1` (published on host loopback in Compose).
- Without `DOT_API_KEY`, requests with a non-loopback `Host` header are
  rejected (DNS-rebinding protection) and cross-origin browser requests are
  refused unless listed in `DOT_CORS_ORIGINS`.
- Always set `DOT_API_KEY` before exposing the API beyond loopback.
- Never mount the Docker socket, SSH keys, or your home directory.
- The `/data` volume contains ChatGPT tokens; keep it private and never share
  it between containers.
