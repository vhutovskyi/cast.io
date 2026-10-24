# One image: the Colyseus backend, serving the built 3D client on the same port.

FROM node:24-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/backend/package.json apps/backend/
COPY apps/frontend/package.json apps/frontend/
RUN npm ci
COPY apps apps
RUN npm run build -w apps/frontend && npm run build -w apps/backend

FROM node:24-slim
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/backend/package.json apps/backend/
COPY apps/frontend/package.json apps/frontend/
RUN npm ci --omit=dev -w apps/backend && npm cache clean --force
COPY --from=build /app/apps/backend/build apps/backend/build
COPY --from=build /app/apps/frontend/dist apps/frontend/dist
USER node
EXPOSE 2567
CMD ["node", "apps/backend/build/index.js"]
