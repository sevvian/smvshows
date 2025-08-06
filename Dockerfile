# syntax=docker/dockerfile:1.6

# Base image with Node
FROM node:20-slim AS base
WORKDIR /app

# Install only prod dependencies without using or creating lockfiles
# We copy only package.json to avoid sending source yet
FROM base AS deps
COPY package.json ./
# Note: --no-package-lock prevents generating a lock file
RUN npm install --only=production --no-audit --no-fund --no-package-lock

# Create minimal runtime image
FROM node:20-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app

# Copy installed node_modules from deps stage
COPY --from=deps /app/node_modules ./node_modules

# Copy app source (no node_modules or lock files thanks to .dockerignore)
COPY . .

# Ensure data directory exists in container for sqlite
RUN mkdir -p /data

# Expose port configured by env (default 3000)
EXPOSE 3000

# Start the server
CMD ["node", "src/index.js"]