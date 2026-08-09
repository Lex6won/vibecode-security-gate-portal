FROM node:20-slim
WORKDIR /app
RUN node -e "const [major, minor] = process.versions.node.split('.').map(Number); if (major !== 20 || minor < 19) { console.error('Node 20.19+ required'); process.exit(1); }"
COPY package.json package-lock.json* ./
RUN npm install --omit=dev --ignore-scripts
COPY src ./src
EXPOSE 3000
CMD ["npm", "start"]
