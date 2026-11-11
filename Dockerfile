FROM node:22-slim AS build
WORKDIR /app
COPY package*.json tsconfig*.json ./
COPY scripts ./scripts
COPY src ./src
RUN npm ci --ignore-scripts && npm run build && npm prune --omit=dev

FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=4477
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
EXPOSE 4477
USER node
CMD ["node", "dist/cli.js", "server"]
