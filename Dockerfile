FROM node:24-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY --chown=node:node public ./public
COPY --chown=node:node server.js store.js ./
RUN mkdir /app/data && chown node:node /app/data
USER node
ENV HOST=0.0.0.0 PORT=3000 DB_PATH=/app/data/grid.sqlite
EXPOSE 3000
VOLUME ["/app/data"]
CMD ["node", "server.js"]
