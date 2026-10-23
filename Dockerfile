FROM node:24-alpine
WORKDIR /app
COPY package.json core.mjs server.mjs planner.mjs ./
COPY public ./public
ENV HOST=0.0.0.0 PORT=8787
RUN mkdir -p .data && chown -R node:node /app
USER node
EXPOSE 8787
VOLUME ["/app/.data"]
CMD ["node", "server.mjs"]
