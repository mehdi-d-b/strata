FROM node:22-alpine
WORKDIR /app

# Dépendances d'abord (cache Docker).
COPY package.json ./
RUN npm install

COPY . .

CMD ["npm", "start"]
