FROM node:22-alpine AS build

WORKDIR /service
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-alpine AS runtime

ENV NODE_ENV=production
WORKDIR /service
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /service/dist ./dist

USER node
EXPOSE 8100

CMD ["node", "dist/server.js"]
