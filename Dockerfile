FROM node:24-alpine

ENV NODE_ENV=production \
    DATA_DIR=/data

WORKDIR /app

# Dependencies first, so this layer is cached when only the code changes.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY index.js ./
COPY src ./src

# Gladys mounts a writable /data; the rest of the filesystem is read-only.
USER node

CMD ["node", "index.js"]
