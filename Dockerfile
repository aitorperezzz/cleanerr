FROM node:26-alpine

WORKDIR /app

RUN apk add --no-cache curl \
    && mkdir -p /data \
    && chown node:node /data

COPY package*.json ./
RUN npm ci --omit=dev

COPY config.js config.json settings-store.js server.js ./
COPY public ./public

ENV NODE_ENV=production

EXPOSE 3050

VOLUME ["/data"]

USER node

CMD ["npm", "start"]
