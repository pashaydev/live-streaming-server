FROM oven/bun:slim

# Create app directory
WORKDIR /app

# Install ffmpeg
RUN apt-get update && \
    apt-get install -y ffmpeg && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

# Install app dependencies
COPY package*.json bun.lockb* ./
RUN bun install --frozen-lockfile

# Bundle app source
COPY . .

# Create directory for HLS segments
RUN mkdir -p hls

# Expose the port
EXPOSE 3000

# Start the application
CMD ["bun", "server.js"]
