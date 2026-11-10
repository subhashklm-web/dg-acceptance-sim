FROM oven/bun:1.2.19
WORKDIR /app
COPY server.ts index.html index-4e.html certificate.html ./
COPY vendor ./vendor
CMD ["bun", "server.ts"]
