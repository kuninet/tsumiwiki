# TsumiWiki 本番イメージ(NFR-OPS-01)
# git(履歴管理・バックアップpushに必須)を含むDebianベース

FROM node:22-bookworm-slim AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/shared/package.json packages/shared/
COPY packages/server/package.json packages/server/
COPY packages/client/package.json packages/client/
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
  && pnpm install --frozen-lockfile
COPY . .
RUN pnpm --filter @tsumiwiki/client build

FROM node:22-bookworm-slim
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends git \
  && rm -rf /var/lib/apt/lists/* \
  && corepack enable
COPY --from=build /app /app

# 文書ライブラリとアプリデータは永続ボリュームに置く
ENV LIBRARY_PATH=/library \
    DB_PATH=/data/app.db \
    PORT=3000
VOLUME ["/library", "/data"]
EXPOSE 3000

CMD ["pnpm", "--filter", "@tsumiwiki/server", "start"]
