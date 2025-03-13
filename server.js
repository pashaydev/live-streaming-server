const express = require("express");
const http = require("http");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const { promisify } = require("util");
const app = express();
const server = http.createServer(app);
const io = require("socket.io")(server);
require("dotenv").config();
const { Worker } = require("worker_threads");
const compression = require("compression");
app.use(compression());

// Maintain a running size total instead of recalculating
let currentFolderSizeMB = 0;

// File system promisified methods
const stat = promisify(fs.stat);

// Serve static files
app.use(express.static(path.join(__dirname, "public")));
app.use("/hls", express.static(path.join(__dirname, "hls")));

// Create HLS directory if it doesn't exist
const hlsDir = path.join(__dirname, "hls");
if (!fs.existsSync(hlsDir)) {
  fs.mkdirSync(hlsDir, { recursive: true });
}

// Stream configuration
const STREAM_URL =
  "https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4"; // Big Buck Bunny sample
const WINDOW_DURATION = 5 * 60; // 5-minute playback window
const SEGMENT_DURATION = 2; // Duration of each segment in seconds
const MAX_FOLDER_SIZE_MB = 500; // Maximum folder size in MB
const CLEANUP_THRESHOLD_MB = 400; // Clean up to this size

// Stream state
let streamStartTime = null;
let ffmpegProcess = null;
let isStreaming = false;
let segmentCount = 0;

// Calculate folder size in bytes
async function getFolderSize(dirPath) {
  let size = 0;
  const files = fs.readdirSync(dirPath);

  for (const file of files) {
    const filePath = path.join(dirPath, file);
    try {
      const stats = await stat(filePath);
      if (stats.isFile()) {
        size += stats.size;
      }
    } catch (err) {
      console.warn(`Error getting size of ${filePath}: ${err.message}`);
    }
  }

  return size;
}

// Clean up old fragments when folder exceeds size limit
async function cleanupFragments() {
  // Only start cleanup if we're above threshold
  const sizeInMB = currentFolderSizeMB;

  if (sizeInMB > MAX_FOLDER_SIZE_MB) {
    const worker = new Worker(
      `
      const { parentPort, workerData } = require('worker_threads');
      const fs = require('fs');
      const path = require('path');

      // Worker code for cleanup
      const { hlsDir, targetSizeMB, filesToKeep } = workerData;

      // Get and sort files
      const files = fs.readdirSync(hlsDir)
        .filter(file => file.endsWith('.ts'))
        .map(file => {
          const filePath = path.join(hlsDir, file);
          const stats = fs.statSync(filePath);
          return { name: file, path: filePath, creationTime: stats.birthtimeMs, size: stats.size };
        })
        .sort((a, b) => a.creationTime - b.creationTime);

      // Delete oldest files but keep required number
      let deletedSize = 0;
      let deletedCount = 0;

      for (let i = 0; i < files.length - filesToKeep; i++) {
        const file = files[i];
        try {
          fs.unlinkSync(file.path);
          deletedSize += file.size;
          deletedCount++;
        } catch (err) {
          // Continue with next file
        }
      }

      parentPort.postMessage({ deletedSize, deletedCount });
    `,
      {
        workerData: {
          hlsDir,
          targetSizeMB: CLEANUP_THRESHOLD_MB,
          filesToKeep: Math.ceil(WINDOW_DURATION / SEGMENT_DURATION),
        },
      },
    );

    worker.on("message", (result) => {
      updateFolderSize(-result.deletedSize);
      io.emit("cleanupPerformed", {
        deletedCount: result.deletedCount,
        deletedSizeMB: (result.deletedSize / (1024 * 1024)).toFixed(2),
        currentSizeMB: currentFolderSizeMB.toFixed(2),
      });
    });
  }
}

// Start live streaming with dynamic HLS generation
function startLiveStream() {
  if (isStreaming) return;

  console.log("Starting live stream processing...");

  // Clean existing HLS files
  if (fs.existsSync(hlsDir)) {
    const files = fs.readdirSync(hlsDir);
    for (const file of files) {
      if (file.endsWith(".ts") || file.endsWith(".m3u8")) {
        fs.unlinkSync(path.join(hlsDir, file));
      }
    }
  }

  // Set stream start time
  streamStartTime = Date.now();
  segmentCount = 0;

  // Use FFmpeg to process the video as a simulated live stream
  ffmpegProcess = spawn("ffmpeg", [
    "-re",
    "-i",
    STREAM_URL,
    "-c:v",
    "libx264",
    "-preset",
    "veryfast", // Faster encoding
    "-tune",
    "zerolatency", // Optimize for streaming
    "-profile:v",
    "baseline", // More compatible profile
    "-level",
    "3.0",
    "-crf",
    "23", // Balance quality and size
    "-c:a",
    "aac",
    "-b:a",
    "128k", // Lower audio bitrate
    "-f",
    "hls",
    "-hls_time",
    SEGMENT_DURATION.toString(),
    "-hls_list_size",
    Math.ceil(WINDOW_DURATION / SEGMENT_DURATION),
    "-hls_flags",
    "delete_segments+append_list",
    "-hls_segment_filename",
    path.join(hlsDir, "segment%03d.ts"),
    path.join(hlsDir, "playlist.m3u8"),
  ]);

  isStreaming = true;

  function updateFolderSize(sizeChangeBytes) {
    currentFolderSizeMB += sizeChangeBytes / (1024 * 1024);
  }

  ffmpegProcess.stderr.on("data", (data) => {
    const output = data.toString();

    // Track new segments
    if (output.includes("segment") && output.includes(".ts")) {
      segmentCount++;

      // Get the new segment's size
      try {
        const match = output.match(/segment(\d+)\.ts/);
        if (match) {
          const fileName = `segment${match[1]}.ts`;
          const filePath = path.join(hlsDir, fileName);
          const stats = fs.statSync(filePath);
          updateFolderSize(stats.size);
        }
      } catch (err) {
        console.error(err);
      }

      io.emit("segmentCreated", {
        count: segmentCount,
        time: Date.now(),
      });

      // Check fragment folder size every 10 segments
      if (segmentCount % 10 === 0) {
        cleanupFragments();
      }
    }
  });

  ffmpegProcess.on("close", (code) => {
    console.log(`FFmpeg process exited with code ${code}`);
    isStreaming = false;

    // Restart stream after completion
    console.log("Video ended, restarting stream in 3 seconds...");
    setTimeout(startLiveStream, 3000);
  });

  ffmpegProcess.on("error", (err) => {
    console.error(`Error in FFmpeg process: ${err}`);
    isStreaming = false;
  });
}

// Calculate current stream state
function calculateStreamState() {
  if (!streamStartTime) return { isStreaming: false, currentTime: Date.now() };

  const elapsedSeconds = (Date.now() - streamStartTime) / 1000;

  return {
    streamStartTime,
    elapsedSeconds,
    currentTime: Date.now(),
    isStreaming,
    windowDuration: WINDOW_DURATION,
    segmentCount,
    hlsUrl: "/hls/playlist.m3u8",
  };
}

// Routes
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// API endpoint for stream state
app.get("/api/stream-state", (req, res) => {
  res.json(calculateStreamState());
});

// WebSocket connection
io.on("connection", (socket) => {
  console.log("User connected");

  // Send initial stream info
  socket.emit("streamInfo", calculateStreamState());

  // Update stream info periodically
  const interval = setInterval(() => {
    socket.emit("streamUpdate", calculateStreamState());
  }, 1000);

  socket.on("disconnect", () => {
    console.log("User disconnected");
    clearInterval(interval);
  });
});

// Periodically check folder size
const CLEANUP_CHECK_INTERVAL = 5 * 60 * 1000; // Check every 5 minutes
setInterval(cleanupFragments, CLEANUP_CHECK_INTERVAL);

// Handle process termination
process.on("SIGINT", () => {
  console.log("Shutting down server...");
  if (ffmpegProcess && !ffmpegProcess.killed) {
    ffmpegProcess.kill();
  }
  process.exit(0);
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  // Start streaming automatically when server starts
  startLiveStream();
});

const NodeCache = require("node-cache");
const { Console } = require("console");
const streamStateCache = new NodeCache({ stdTTL: 2 }); // 2-second TTL

// Cache stream state calculations
app.get("/api/stream-state", (req, res) => {
  let state = streamStateCache.get("streamState");
  if (!state) {
    state = calculateStreamState();
    streamStateCache.set("streamState", state);
  }
  res.json(state);
});
