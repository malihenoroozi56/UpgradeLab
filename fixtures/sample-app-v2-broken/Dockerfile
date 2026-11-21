# Build context: fixtures/ (so the shared application code can be copied in).
# This variant contains an intentionally destructive migration so UpgradeLab's
# failure path can be demonstrated without editing a working fixture.
FROM node:22-alpine

RUN apk add --no-cache postgresql-client

WORKDIR /app
COPY shared/ /app/
COPY sample-app-v2-broken/migrations/ /app/migrations/

ENV NODE_ENV=production \
    APP_VERSION=2.0.0-broken \
    PORT=3000 \
    MIGRATIONS_DIR=/app/migrations \
    AUTO_MIGRATE=true

USER node
EXPOSE 3000
HEALTHCHECK --interval=5s --timeout=3s --retries=12 \
  CMD node -e "fetch('http://127.0.0.1:3000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.mjs"]
