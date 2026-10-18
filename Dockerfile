# Stage 1 — build TypeScript and compile native modules (better-sqlite3)
FROM node:22-alpine AS builder
RUN apk add --no-cache python3 make g++
WORKDIR /app
COPY package*.json tsconfig.json ./
RUN npm ci
COPY src/ ./src/
RUN npm run build && npm prune --omit=dev

# Stage 2 — lean runtime image (no toolchain, no dev dependencies)
FROM node:22-alpine
WORKDIR /app
COPY --from=builder /app/package.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist/
VOLUME ["/app/data"]
EXPOSE 3000
CMD ["node", "dist/commands/serve.js"]
