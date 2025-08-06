# Existing base image assumed (e.g., node:18-bullseye or similar)

# --- install ps (procps) so Crawlee can take memory snapshots ---
RUN apt-get update && apt-get install -y --no-install-recommends procps && rm -rf /var/lib/apt/lists/*

# Keep the rest of your existing Dockerfile content as-is