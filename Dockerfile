FROM oven/bun:1.2.19
WORKDIR /app
COPY server.ts index.html ./
CMD ["bun", "server.ts"]
