# Use official Microsoft Playwright image with Ubuntu Jammy & pre-installed browser dependencies
ARG PLAYWRIGHT_VERSION=v1.49.1-jammy
FROM mcr.microsoft.com/playwright:${PLAYWRIGHT_VERSION}

# Set environment
ENV NODE_ENV=production \
    PORT=3000 \
    HOST=0.0.0.0 \
    HEADLESS=true \
    AUTH_STATE_PATH=/app/auth_state.json

WORKDIR /app

# Copy package manifests first for efficient Docker layer caching
COPY package*.json ./

# Install production dependencies only and ensure Chromium browser binary is present
RUN npm ci --omit=dev && npx playwright install chromium

# Copy application source code
COPY src ./src
COPY generate_auth.js ./

# Expose API port
EXPOSE 3000

# Run as non-root user (playwright base image provides 'pwuser')
USER pwuser

# Healthcheck using native Node.js fetch with configured API_KEY
HEALTHCHECK --interval=30s --timeout=10s --start-period=20s --retries=3 \
  CMD node -e 'fetch("http://127.0.0.1:3000/health", { headers: { Authorization: "Bearer " + (process.env.API_KEY || "") } }).then(r => r.ok ? process.exit(0) : process.exit(1)).catch(() => process.exit(1))'

# Start the Fastify API server
CMD ["node", "src/server.js"]
