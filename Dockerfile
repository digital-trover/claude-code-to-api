# One instance per user. Isolation is the container boundary, so this image is
# deliberately single-tenant: one workspace, one upstream Claude credential.
FROM node:24-slim

# git and ca-certificates are what the harness's own tooling reaches for during
# agent runs; without them `/v1/runs` fails in ways that look like model errors.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates git \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

COPY tsconfig.json ./
COPY src ./src

# The workspace is the only path agent runs may touch, and the only thing worth
# persisting. Keep it outside /app so a redeploy never clobbers user files.
RUN mkdir -p /workspace /home/node/.claude \
  && chown -R node:node /workspace /home/node/.claude /app
VOLUME ["/workspace", "/home/node/.claude"]

USER node

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8787 \
    WORKDIR=/workspace

EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["npx", "tsx", "src/index.ts"]
