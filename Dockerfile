FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm ci --omit=dev
COPY --chown=node:node server ./server
COPY --chown=node:node scripts ./scripts
COPY --from=build --chown=node:node /app/server/public ./server/public
RUN mkdir -p uploads && chown -R node:node /app
USER node
EXPOSE 3000
CMD ["node", "server/index.js"]
