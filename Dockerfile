FROM node:24.22.1-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --fund=false && npm cache clean --force
COPY trust/max-root.pem ./trust/max-root.pem
COPY src/server ./src/server
COPY src/shared ./src/shared
COPY scripts/backup-v2.cjs scripts/backup-agent.cjs scripts/start-workers.cjs scripts/start-background.cjs scripts/prepare-max-upgrade.cjs scripts/prepare-staff-max-upgrade.cjs scripts/prepare-staff-push-upgrade.cjs scripts/prepare-structural-upgrade.cjs scripts/prepare-paid-services-upgrade.cjs scripts/prepare-booking-read-budget.cjs scripts/prepare-booking-public-links.cjs scripts/configure-max-webhook.cjs scripts/restore-organization.cjs ./scripts/
COPY scripts/start-postgres-server.cjs scripts/postgres-ops.cjs scripts/postgres-rehearsal.cjs scripts/postgres-rehearsal-fixture.cjs scripts/postgres-readiness.cjs ./scripts/
COPY multi-server.cjs serve.cjs auth-store.cjs platform-store.cjs storage.cjs mail.cjs backup.cjs backup-cli.cjs dikidi-adapter.cjs validation.cjs image-processing.cjs image-worker.cjs client-address.cjs ./
COPY dist/public ./dist/public
COPY dist/setup ./dist/setup
RUN mkdir /data /backups /backup-state /backup-work /backup-status /rehearsal && chown node:node /data /backups /backup-state /backup-work /backup-status /rehearsal
USER node
ENV NODE_ENV=production BIND_HOST=0.0.0.0 PORT=4173 CARTOTECA_DATA_DIR=/data
ENV NODE_EXTRA_CA_CERTS=/app/trust/max-root.pem
EXPOSE 4173
CMD ["node", "multi-server.cjs"]
