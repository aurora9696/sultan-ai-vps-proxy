FROM node:20-slim
WORKDIR /app
COPY package.json .
RUN npm install --production
COPY server.js outbound.js ./
EXPOSE 8080
CMD ["node", "server.js"]
