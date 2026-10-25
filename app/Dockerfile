FROM node:26-alpine AS base
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY ./ ./

FROM base AS test
RUN npm test

FROM base AS production
RUN mkdir -p /data && chown node:node /data
USER node
ENV PORT=3000 DATABASE_PATH=/data/scores.sqlite
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:3000/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["npm", "run", "start"]
