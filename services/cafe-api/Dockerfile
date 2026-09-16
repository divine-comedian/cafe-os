FROM node:22-alpine AS web-build

WORKDIR /workspace/services/cafe-web
COPY services/cafe-web/package.json services/cafe-web/package-lock.json ./
RUN npm ci
COPY services/cafe-web ./
RUN npm run build

FROM node:22-alpine AS api-build

WORKDIR /service
COPY services/cafe-api/package.json services/cafe-api/package-lock.json ./
RUN npm ci
COPY services/cafe-api/tsconfig.json ./
COPY services/cafe-api/src ./src
RUN npm run build

FROM node:22-alpine AS runtime

ENV NODE_ENV=production
WORKDIR /service
COPY services/cafe-api/package.json services/cafe-api/package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=api-build /service/dist ./dist
COPY --from=web-build /workspace/services/cafe-api/public ./public

USER node
EXPOSE 8100

CMD ["node", "dist/server.js"]
