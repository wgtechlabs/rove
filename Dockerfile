FROM node:24.19.0-bookworm-slim AS build
WORKDIR /app
COPY --from=oven/bun:1.3.10 /usr/local/bin/bun /usr/local/bin/bun
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY tsconfig.json ./
COPY src ./src
RUN bun run build
# Install production dependencies separately so build tools stay out of the image.
RUN mkdir /production && cp package.json bun.lock /production/
RUN cd /production && bun install --frozen-lockfile --production

FROM node:24.19.0-bookworm-slim
ENV NODE_ENV=production PORT=3000
WORKDIR /app
COPY --from=build /production/node_modules ./node_modules
COPY --from=build /app/dist/src ./dist/src
COPY package.json bun.lock tsconfig.json LICENSE Dockerfile .dockerignore ./
COPY src ./src
COPY public ./public
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s CMD node -e "fetch('http://127.0.0.1:' + process.env.PORT + '/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"
ENTRYPOINT []
CMD ["node", "dist/src/server.js"]
