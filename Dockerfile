# Use the official Node.js 20 Long-Term Support image
FROM node:20-slim

# Set the working directory inside the container
WORKDIR /usr/src/app

# Copy package files and install dependencies
COPY package*.json ./
# Use a clean install command
RUN npm ci

# Copy the rest of your project files into the container
COPY . .

# Default command
CMD ["npx", "hardhat", "node"]
