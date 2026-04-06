FROM node:20-slim

WORKDIR /app

# Install dependencies first for better caching
COPY package*.json ./
RUN npm ci

# Copy remaining source files
COPY . .

# Build TypeScript to JavaScript
RUN npm run build

# Start the bot
CMD ["npm", "start"]
