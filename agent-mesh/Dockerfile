# Optional container image that runs the daemon as a standalone service. The
# dashboard and the console are not in it; run `pnpm ui` from a checkout for those.
FROM node:24.13-bookworm-slim

WORKDIR /app

# The sources go in before the install: its postinstall step (prisma generate)
# writes the console's database client into src/generated, which the build needs.
COPY package.json tsconfig.json prisma.config.ts ./
COPY prisma/ ./prisma/
COPY src/ ./src/
RUN npm install && npm run build && npm prune --omit=dev

# The daemon listens on a Unix socket under AGENT_MESH_HOME; mount a volume there
# if you want inbox durability across restarts. It runs as the image's
# unprivileged `node` user: legacy exec/file/fifo delivery runs commands and
# writes paths that registering agents choose, so it must not do that as root.
# /data is created and chowned before VOLUME so a fresh named volume inherits
# that ownership; a bind mount needs to be writable by uid 1000.
ENV AGENT_MESH_HOME=/data
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]

CMD ["node", "dist/daemon.js"]
