FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY public ./public
EXPOSE 8787
CMD ["node", "--no-warnings=ExperimentalWarning", "src/server.js"]
