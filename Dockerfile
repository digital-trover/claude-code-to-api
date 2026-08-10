# One instance per user: single workspace, no stored Claude credential.
#
# Base image note: this must be glibc, not musl. The Agent SDK ships Claude Code
# as a platform-specific native binary chosen from optionalDependencies, and an
# alpine build resolves the `-musl` variant. Mixing the two fails at runtime
# with "binary exists but failed to launch … musl dynamic loader missing",
# which surfaces as an opaque 500 rather than a build error.

# ── builder: compile TypeScript, resolve production dependencies ─────────────
FROM node:24-slim AS builder

WORKDIR /app

COPY package.json package-lock.json* ./

# Full install (including tsc) purely to build. None of it reaches the runtime
# image, which is the point of the split: tsx, typescript and @types together
# are tens of megabytes that would otherwise ship for no reason.
RUN npm ci --no-audit --no-fund

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Re-resolve with dev dependencies pruned. `npm ci` rather than `npm prune`
# because it also drops the package-lock bookkeeping and any partially-built
# dev trees.
RUN npm ci --omit=dev --no-audit --no-fund

# ── runtime ──────────────────────────────────────────────────────────────────
FROM node:24-slim AS runtime

# ca-certificates: TLS to api.anthropic.com.
# git: agent runs clone and commit; drop it and the apt line below to save
#      ~50MB if you only use /v1/messages.
# tini: reaps orphaned grandchildren. Every turn spawns a `claude` subprocess
#      which spawns its own children, and Node as PID 1 does not reap them.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates git tini \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY --from=builder --chown=node:node /app/node_modules ./node_modules
COPY --from=builder --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json ./
# Served at GET /openapi.json, and resolved relative to dist/routes/.
COPY --chown=node:node openapi.json ./

# Workspace and transcripts live outside /app so a redeploy never touches user
# data. SESSION_DIR must hold no stored login: that absence is what forces a
# caller-supplied token to be used instead of silently falling back to one.
RUN mkdir -p /workspace /sessions && chown -R node:node /workspace /sessions
VOLUME ["/workspace", "/sessions"]

USER node

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8787 \
    WORKDIR=/workspace \
    SESSION_DIR=/sessions

EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/index.js"]
