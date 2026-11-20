# Pine AI — one image for the API and the worker (CMD picks which).
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
# tsx runs the TypeScript server directly; dev-only packages (vite, vitest, embedded-postgres) stay out.
RUN npm ci --omit=dev && npm i --no-save tsx@4 && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY server ./server
COPY tsconfig.json ./
USER node
EXPOSE 4000
CMD ["npx", "tsx", "server/main.ts"]
