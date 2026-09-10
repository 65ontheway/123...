FROM node:22-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY server.js ./
COPY lib ./lib
COPY public ./public
COPY views ./views

ENV PORT=3000
EXPOSE 3000

CMD ["node", "server.js"]
