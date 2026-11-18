FROM node:22-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY tsconfig.json ./
COPY src ./src
COPY public ./public
RUN npm install -D typescript @types/node @types/express @types/jsonwebtoken @types/pg && npm run build && npm prune --omit=dev
RUN mkdir -p /data && chown -R node:node /app /data
USER node
EXPOSE 8092
ENV QUERYPILOT_HOST=0.0.0.0
ENV QUERYPILOT_PORT=8092
ENV QUERYPILOT_DATA_DIR=/data
CMD ["node", "dist/server.js"]
