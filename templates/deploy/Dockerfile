# Node 24 runs the .ts files as they are: no build step, no dist/ folder.
FROM node:24-alpine

WORKDIR /app
ENV NODE_ENV=production

# dependencies first, so this layer is cached until package.json changes
COPY package.json ./
RUN npm install --omit=dev && npm cache clean --force

COPY src ./src

# never run as root
USER node

ENV PORT=3000
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- "http://127.0.0.1:$PORT/healthz" || exit 1

# exec form, so node is PID 1 and receives SIGTERM itself
CMD ["node", "src/app.ts"]
