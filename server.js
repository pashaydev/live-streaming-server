const express = require("express");
const http = require("http");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const { promisify } = require("util");
const { Worker } = require("worker_threads");
const compression = require("compression");
const NodeCache = require("node-cache");
require("dotenv").config();

// Initialize Express app and server
const app = express();
const server = http.createServer(app);
const io = require("socket.io")(server);

// Configuration constants
const STREAM_URL =
  process.env.STREAM_URL ||
  "https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4";
const WINDOW_DURATION = parseInt(process.env.WINDOW_DURATION || 300); // 5-minute playback window
const SEGMENT_DURATION = parseInt(process.env.SEGMENT_DURATION || 2);
const MAX_FOLDER_SIZE_MB = parseInt(process.env.MAX_FOLDER_SIZE_MB || 500);
const CLEANUP_THRESHOLD_MB = parseInt(process.env.CLEANUP_THRESHOLD_MB || 400);
const CLEANUP_CHECK_INTERVAL = parseInt(
  process.env.CLEANUP_CHECK_INTERVAL || 300000,
);
const PORT = process.env.PORT || 3000;

// File system promisified methods
const stat = promisify(fs.stat);
const readdir = promisify(fs.readdir);
const unlink = promisify(fs.unlink);

// Path for HLS content
const hlsDir = path.join(__dirname, "hls");

// Cache for stream state
const streamStateCache = new NodeCache({ stdTTL: 2 }); // 2-second TTL

// Stream state
let streamStartTime = null;
let ffmpegProcess = null;
let isStreaming = false;
let segmentCount = 0;
let currentFolderSizeMB = 0;

/**
 * Updates the folder size tracking
 * @param {number} sizeChangeBytes - Change in bytes (positive for increase, negative for decrease)
 */
function updateFolderSize(sizeChangeBytes) {
  currentFolderSizeMB += sizeChangeBytes / (1024 * 1024);
}

/**
 * Calculate folder size in bytes
 * @param {string} dirPath - Directory path to calculate size for
 * @returns {Promise<number>} - Size in bytes
 */
async function getFolderSize(dirPath) {
  let size = 0;
  try {
    const files = await readdir(dirPath);

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
  } catch (err) {
    console.error(`Error reading directory ${dirPath}: ${err.message}`);
  }

  return size;
}

/**
 * Clean up old fragments when folder exceeds size limit
 */
async function cleanupFragments() {
  try {
    // Get current folder size
    const folderSizeBytes = await getFolderSize(hlsDir);
    const folderSizeMB = folderSizeBytes / (1024 * 1024);

    // Update our tracking variable
    currentFolderSizeMB = folderSizeMB;

    // Only start cleanup if we're above threshold
    if (folderSizeMB > MAX_FOLDER_SIZE_MB) {
      console.log(
        `Folder size ${folderSizeMB.toFixed(2)}MB exceeds limit, starting cleanup...`,
      );

      // Create a worker for cleanup
      const worker = new Worker("./cleanupWorker.js", {
        workerData: {
          hlsDir,
          targetSizeMB: CLEANUP_THRESHOLD_MB,
          filesToKeep: Math.ceil(WINDOW_DURATION / SEGMENT_DURATION),
        },
      });

      worker.on("message", (result) => {
        updateFolderSize(-result.deletedSize);
        console.log(
          `Cleanup completed: Deleted ${result.deletedCount} files (${(result.deletedSize / (1024 * 1024)).toFixed(2)}MB)`,
        );

        io.emit("cleanupPerformed", {
          deletedCount: result.deletedCount,
          deletedSizeMB: (result.deletedSize / (1024 * 1024)).toFixed(2),
          currentSizeMB: currentFolderSizeMB.toFixed(2),
        });
      });

      worker.on("error", (err) => {
        console.error(`Cleanup worker error: ${err}`);
      });
    }
  } catch (err) {
    console.error(`Error during cleanup: ${err.message}`);
  }
}

/**
 * Calculate current stream state
 * @returns {Object} Stream state object
 */
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
    folderSizeMB: currentFolderSizeMB.toFixed(2),
  };
}

/**
 * Start live streaming with dynamic HLS generation
 */
function startLiveStream() {
  if (isStreaming) return;

  console.log("Starting live stream processing...");

  try {
    // Clean existing HLS files
    if (fs.existsSync(hlsDir)) {
      const files = fs.readdirSync(hlsDir);
      for (const file of files) {
        if (file.endsWith(".ts") || file.endsWith(".m3u8")) {
          fs.unlinkSync(path.join(hlsDir, file));
        }
      }
    }

    // Reset folder size tracking
    currentFolderSizeMB = 0;

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
      "veryfast",
      "-tune",
      "zerolatency",
      "-profile:v",
      "baseline",
      "-level",
      "3.0",
      "-crf",
      "23",
      "-c:a",
      "aac",
      "-b:a",
      "128k",
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
            if (fs.existsSync(filePath)) {
              const stats = fs.statSync(filePath);
              updateFolderSize(stats.size);
            }
          }
        } catch (err) {
          console.error(`Error processing segment: ${err.message}`);
        }

        io.emit("segmentCreated", {
          count: segmentCount,
          time: Date.now(),
        });

        // Check fragment folder size every 10 segments
        if (segmentCount % 10 === 0) {
          cleanupFragments().catch((err) => {
            console.error(`Error in periodic cleanup: ${err.message}`);
          });
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
      console.error(`Error in FFmpeg process: ${err.message}`);
      isStreaming = false;

      // Attempt to restart on error
      console.log("Attempting to restart stream in 5 seconds...");
      setTimeout(startLiveStream, 5000);
    });
  } catch (err) {
    console.error(`Failed to start stream: ${err.message}`);
    isStreaming = false;
  }
}

/**
 * Graceful shutdown
 */
function shutdownGracefully() {
  console.log("Shutting down server...");
  if (ffmpegProcess && !ffmpegProcess.killed) {
    ffmpegProcess.kill();
  }
  server.close(() => {
    console.log("Server closed.");
    process.exit(0);
  });
}

// Initialize server
async function initializeServer() {
  // Create HLS directory if it doesn't exist
  if (!fs.existsSync(hlsDir)) {
    fs.mkdirSync(hlsDir, { recursive: true });
  } else {
    // Calculate initial folder size
    currentFolderSizeMB = (await getFolderSize(hlsDir)) / (1024 * 1024);
  }

  // Setup middleware
  app.use(compression());
  app.use(express.static(path.join(__dirname, "public")));
  app.use("/hls", express.static(hlsDir));

  // Setup routes
  app.get("/", (req, res) => {
    res.sendFile(path.join(__dirname, "public", "index.html"));
  });

  // API endpoint for stream state with caching
  app.get("/api/stream-state", (req, res) => {
    let state = streamStateCache.get("streamState");
    if (!state) {
      state = calculateStreamState();
      streamStateCache.set("streamState", state);
    }
    res.json(state);
  });

  // Setup WebSocket
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

  // Handle process termination
  process.on("SIGINT", shutdownGracefully);
  process.on("SIGTERM", shutdownGracefully);

  // Start server
  server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    // Start streaming automatically when server starts
    startLiveStream();
  });

  // Setup periodic tasks
  setInterval(cleanupFragments, CLEANUP_CHECK_INTERVAL);
}

// Initialize the server
initializeServer().catch((err) => {
  console.error(`Failed to initialize server: ${err.message}`);
  process.exit(1);
});
