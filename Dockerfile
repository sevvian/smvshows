# -------- Base dependencies builder --------
FROM node:20-bullseye-slim AS deps
WORKDIR /app

# Install build tools for native deps if any appear in the future (kept minimal)
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*

# Copy only package manifests to leverage Docker layer caching
COPY package.json ./

# Install prod dependencies without requiring a lock file
# --no-package-lock ensures this build is self-contained and doesn’t expect a lock
RUN npm install --omit=dev --no-audit --no-fund --no-package-lock

# -------- Runtime image --------
FROM node:20-bullseye-slim AS runtime
WORKDIR /app

# Install procps to provide the `ps` command for Crawlee memory snapshots
RUN apt-get update && apt-get install -y --no-install-recommends procps && rm -rf /var/lib/apt/lists/*

# Create data directories
RUN mkdir -p /data

# Copy installed node_modules from deps stage
COPY --from=deps /app/node_modules ./node_modules

# Copy application source
COPY . .

# Environment
ENV NODE_ENV=production
ENV PORT=3000

# Expose port
EXPOSE 3000

# Default command
CMD ["node", "src/index.js"]