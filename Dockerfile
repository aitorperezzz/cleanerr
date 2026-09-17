FROM node:26-alpine

WORKDIR /app

RUN apk add --no-cache curl

COPY package*.json ./
RUN npm ci --omit=dev

COPY config.js server.js ./
COPY public ./public

ENV HOST=0.0.0.0 \
    PORT=3000

EXPOSE 3000

USER node

CMD ["npm", "start"]
