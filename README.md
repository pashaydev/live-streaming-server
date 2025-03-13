# Live Streaming Server with Dynamic HLS

server that creates live streaming experiences from video sources using HTTP Live Streaming (HLS).

```bash
# Build the Docker image
docker build -t live-streaming-server .

# Run the container
docker run -p 3000:3000 live-streaming-server
```

## Client Integration

Access the built-in streaming page at `http://localhost:3000` or integrate with your application using the HLS URL at `/hls/playlist.m3u8`.
