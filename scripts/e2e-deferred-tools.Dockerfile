FROM node:24.20.0-bookworm
WORKDIR /work
COPY . .
RUN npm install -g --allow-scripts=bun,opencode-ai bun@1.3.11 opencode-ai@1.18.32 && npm ci --ignore-scripts && npm run postinstall && npm run build && npm install --prefix /scrub --ignore-scripts @rynfar/meridian-plugin-opencode-scrub@0.2.3
ENV E2E_CONTAINER=1
ENTRYPOINT ["node", "scripts/e2e-container-entry.cjs"]
CMD ["bun", "scripts/e2e-opencode-deferred-refusal.mjs"]
