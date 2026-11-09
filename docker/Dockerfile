FROM node:24-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    bash \
    ca-certificates \
    curl \
    git \
    jq \
    less \
    procps \
    xz-utils \
  && rm -rf /var/lib/apt/lists/*

# Install the official standalone Codex package into a seed home. The
# entrypoint copies it into the persistent /data volume on first start.
ARG CODEX_VERSION=0.167.0
ENV CODEX_HOME=/opt/codex-seed \
    CODEX_INSTALL_DIR=/opt/codex-seed/bin \
    CODEX_NON_INTERACTIVE=1 \
    CODEX_RELEASE=${CODEX_VERSION}

RUN curl -fsSL https://chatgpt.com/codex/install.sh -o /tmp/codex-install.sh \
  && sh /tmp/codex-install.sh \
  && rm -f /tmp/codex-install.sh \
  && test -x /opt/codex-seed/packages/standalone/current/bin/codex

WORKDIR /app
COPY package.json server.js entrypoint.sh ./
RUN chmod +x /app/entrypoint.sh

ENV CODEX_HOME=/data/codex \
    HOME=/data \
    DOT_WORKSPACE=/workspace \
    DOT_API_PORT=8787 \
    PATH=/opt/codex-seed/bin:${PATH}

RUN mkdir -p /data /workspace

WORKDIR /workspace
VOLUME ["/data"]
EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=10s --start-period=120s --retries=3 \
  CMD curl -fsS "http://127.0.0.1:${DOT_API_PORT}/health" || exit 1

ENTRYPOINT ["/app/entrypoint.sh"]
