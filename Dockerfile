# ---------------------------------------------------------------------------
# Stage 1: build
# Compiles TypeScript and builds the better-sqlite3 native binding.
# ---------------------------------------------------------------------------
FROM node:22-alpine AS builder

# Native build tools required by better-sqlite3
RUN apk add --no-cache python3 make g++

WORKDIR /build

# Install dependencies first (layer-cached unless package files change)
COPY package.json package-lock.json ./
RUN npm ci

# Compile TypeScript
COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

# ---------------------------------------------------------------------------
# Stage 2: runtime
# Lean image — only compiled output, node_modules, and static assets.
# ---------------------------------------------------------------------------
FROM node:22-alpine AS runtime

WORKDIR /app

# Copy compiled JS
COPY --from=builder /build/dist ./dist

# Copy node_modules including the compiled .node native binding
COPY --from=builder /build/node_modules ./node_modules

# Copy package.json — required for ESM "type": "module" resolution
COPY package.json ./

# Copy migrations and workflow definitions
COPY migrations/ ./migrations/
COPY workflows/ ./workflows/

# Copy banned words seed file (edit this file to bulk-load the banned word list)
COPY banned_words_seed.txt ./banned_words_seed.txt

# Default DB path — overridable via env var
ENV DB_PATH=/app/data/comfygen.db

# The bot makes outbound connections only — no ports to expose

CMD ["node", "dist/index.js"]
