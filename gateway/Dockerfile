FROM node:26-slim

WORKDIR /app

# Copy gateway source (verbatim style, Node 26 type stripping)
COPY gateway/ ./gateway/
COPY package.json ./package.json
COPY tsconfig.json ./tsconfig.json

ENV NODE_ENV=production
ENV PORT=8080

EXPOSE 8080

CMD ["node", "gateway/server.mjs"]
