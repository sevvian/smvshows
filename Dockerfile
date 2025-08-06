# Use an official Node.js runtime as a parent image
FROM node:20-slim

# Install procps which contains the 'ps' command needed by Crawlee for memory monitoring
RUN apt-get update && apt-get install -y procps && rm -rf /var/lib/apt/lists/*

# Set the working directory for subsequent commands
WORKDIR /app

# Create a dedicated directory for persistent data. This is where the volume will be mounted.
RUN mkdir /data

# Copy the 'public' directory containing the admin UI into the image
COPY public/ ./public/

# Copy package files and install production dependencies
COPY package*.json ./
RUN npm install --omit=dev

# Copy the application source code
COPY src/ ./src/

# Expose the application port
EXPOSE 3000

# The command to run the application
CMD ["node", "src/index.js"]
