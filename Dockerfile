FROM node:24.19.0-bookworm-slim
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@10.33.0 --activate
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --prod --frozen-lockfile --ignore-scripts
COPY src ./src
COPY shared ./shared
ENV NODE_ENV=production HOST=0.0.0.0 PORT=4320
USER node
EXPOSE 4320
CMD ["node", "src/server.ts"]
