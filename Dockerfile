FROM node:20-alpine

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev && npm cache clean --force

COPY server.js reset-pin.js ./
COPY public/ ./public/

EXPOSE 3000

CMD ["node", "server.js"]
