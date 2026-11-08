FROM oven/bun:1.2.19
WORKDIR /app
COPY server.ts index.html certificate.html ./
COPY vendor ./vendor
CMD ["bun", "server.ts"]
