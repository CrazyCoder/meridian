# ---- Build stage ----
FROM oven/bun:1 AS build

WORKDIR /app
COPY package.json bun.lock* ./
RUN --mount=type=cache,target=/root/.bun \
    bun install

COPY tsconfig.json* ./
COPY bin/ ./bin/
COPY src/ ./src/
# Run bun build directly (not "bun run build") to skip postbuild hook,
# which calls "node --check" — unavailable in oven/bun image
RUN rm -rf dist && bun build bin/cli.ts src/proxy/server.ts --outdir dist --target node --splitting --external @anthropic-ai/claude-agent-sdk --external libsql --entry-naming '[name].js'

# ---- Runtime stage ----
FROM node:22-alpine

RUN deluser --remove-home node 2>/dev/null; \
    adduser -D -u 1000 claude \
    && mkdir -p /home/claude/.claude \
    && chown -R claude:claude /home/claude

USER claude
WORKDIR /app

COPY --from=build --chown=claude:claude /app/node_modules ./node_modules
COPY --from=build --chown=claude:claude /app/dist ./dist
COPY --from=build --chown=claude:claude /app/package.json ./

# SDK >= 0.2.98 ships a separate @anthropic-ai/claude-code package. Its
# bin/claude.exe starts out as a 500-byte stub; postinstall (install.cjs)
# copies the platform-specific native binary over it. bun does not run
# postinstalls by default — invoke it explicitly here. The SDK's subprocess
# launcher rejects shell shims, so the shim must point at the real binary.
RUN node /app/node_modules/@anthropic-ai/claude-code/install.cjs \
    && mkdir -p /app/bin/shims \
    && ln -sf /app/node_modules/@anthropic-ai/claude-code/bin/claude.exe /app/bin/shims/claude
ENV PATH="/app/bin/shims:$PATH"
COPY --chown=claude:claude bin/docker-entrypoint.sh bin/claude-proxy-supervisor.sh ./bin/
RUN chmod +x ./bin/docker-entrypoint.sh ./bin/claude-proxy-supervisor.sh

EXPOSE 3456

HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
    CMD node -e "const r=await fetch('http://127.0.0.1:3456/health');process.exit(r.ok?0:1)"

ENV CLAUDE_PROXY_PASSTHROUGH=1 \
    CLAUDE_PROXY_HOST=0.0.0.0 \
    IS_SANDBOX=1
ENTRYPOINT ["./bin/docker-entrypoint.sh"]
CMD ["./bin/claude-proxy-supervisor.sh"]
