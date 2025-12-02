# Build stage
FROM oven/bun:1 AS builder

WORKDIR /app

# Copy package files
COPY package.json bun.lock ./

# Install dependencies
RUN bun install --frozen-lockfile

# Copy source files
COPY tsconfig.json eleventy.config.js ./
COPY src ./src

# Build the static site
RUN bun run build

# Production stage
FROM oven/bun:1-slim

WORKDIR /app

# Copy package files and install production dependencies
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

# Copy built assets and server
COPY --from=builder /app/_site ./_site
COPY --from=builder /app/src/server.ts ./src/server.ts
COPY tsconfig.json ./

# Create data directory
RUN mkdir -p /app/data

# Set environment variables
ENV PORT=8147
ENV NODE_ENV=production

# Expose port
EXPOSE 8147

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD curl -f http://localhost:8147/ || exit 1

# Run the server
CMD ["bun", "run", "src/server.ts"]
