# Shadow Swap market indexer — read-only, no wallet, no custody.
# node:20-alpine (libc-free enough: the ootle wasm is portable).
FROM node:20-alpine

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev 2>/dev/null || npm i --omit=dev
COPY server.mjs codec.mjs ./

# Run as the unprivileged node user; read-only rootfs; loopback only.
USER node
EXPOSE 8080
ENTRYPOINT ["node", "server.mjs"]
