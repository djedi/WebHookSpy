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
FROM oven/bun:1

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

# Health check using bun to make HTTP request
HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
  CMD bun -e "fetch('http://localhost:8147/').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

# Run the server
CMD ["bun", "run", "src/server.ts"]
