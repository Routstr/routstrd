FROM oven/bun:1-slim
WORKDIR /app

COPY package.json bun.lock ./
COPY patches ./patches
RUN bun install --frozen-lockfile

COPY . .
RUN bun run build && bun install -g . && bun add -g @earendil-works/pi-coding-agent

EXPOSE 8008
CMD ["/bin/bash"]
