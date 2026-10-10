# syntax=docker/dockerfile:1
FROM node:24-slim

WORKDIR /app
ENV NODE_ENV=production \
    TZ=Asia/Ho_Chi_Minh

# Dependencies first, so editing source does not reinstall them.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY tsconfig.json ./
COPY src ./src
COPY mcp ./mcp

# Content, settings and state are mounted at run time (see docker-compose.yml); nothing of the
# operator's is baked into the image. The folders exist so the unprivileged user can write to them.
RUN mkdir -p data workspace && chown -R node:node /app
USER node

# tsx runs the TypeScript sources directly; there is no separate build step.
CMD ["node", "node_modules/tsx/dist/cli.mjs", "src/index.ts"]
