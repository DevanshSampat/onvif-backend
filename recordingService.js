const ffmpeg = require('fluent-ffmpeg');
const fs = require('fs');
const path = require('path');

const RECORDINGS_DIR = path.join(__dirname, 'recordings');
const TEMP_DIR = path.join(__dirname, 'temp');
const RETENTION_MS = 24 * 60 * 60 * 1000; // 24 hours in milliseconds

let currentRtspUrl = null;
let rotationTimer = null;
let isRecording = false;
let currentSlotName = null;

/**
 * Ensure recordings and temp directories exist
 */
function ensureDirs() {
  if (!fs.existsSync(RECORDINGS_DIR)) {
    fs.mkdirSync(RECORDINGS_DIR, { recursive: true });
  }
  if (!fs.existsSync(TEMP_DIR)) {
    fs.mkdirSync(TEMP_DIR, { recursive: true });
  }
}

/**
 * Format date to YYYY-MM-DD_HH:MM
 */
function formatSegmentTimestamp(date) {
  const pad = (n) => String(n).padStart(2, '0');
  const yyyy = date.getFullYear();
  const mm = pad(date.getMonth() + 1);
  const dd = pad(date.getDate());
  const hh = pad(date.getHours());
  const min = pad(date.getMinutes());
  return `${yyyy}-${mm}-${dd}_${hh}:${min}`;
}

/**
 * Calculate boundary slot start name (e.g. 12:14 -> 12:10)
 */
function getSlotStartTimestamp(date = new Date()) {
  const slotDate = new Date(date);
  const minutes = slotDate.getMinutes();
  const slotMinutes = Math.floor(minutes / 10) * 10;
  slotDate.setMinutes(slotMinutes, 0, 0);
  return formatSegmentTimestamp(slotDate);
}

/**
 * Calculate seconds remaining until next 10-minute clock boundary (:00, :10, :20, :30, :40, :50)
 */
function getSecondsToNextBoundary(now = new Date()) {
  const minutes = now.getMinutes();
  const seconds = now.getSeconds();
  const ms = now.getMilliseconds();

  const nextBoundaryMinutes = (Math.floor(minutes / 10) + 1) * 10;
  const minutesDiff = nextBoundaryMinutes - minutes;

  const totalSecondsDiff = minutesDiff * 60 - seconds - ms / 1000;
  return Math.max(1, Math.round(totalSecondsDiff));
}

/**
 * Get active slot name
 */
function getCurrentSlotName() {
  return currentSlotName;
}

/**
 * Clean up recordings older than 24 hours
 */
function cleanupOldRecordings() {
  ensureDirs();
  const now = Date.now();
  console.log('[Recorder] Executing 24-hour retention cleanup...');

  try {
    const files = fs.readdirSync(RECORDINGS_DIR);
    for (const file of files) {
      if (file.endsWith('.mp4')) {
        const filePath = path.join(RECORDINGS_DIR, file);
        const stats = fs.statSync(filePath);
        const ageMs = now - stats.mtimeMs;

        if (ageMs > RETENTION_MS) {
          console.log(`[Recorder] Deleting recording older than 24 hours: ${file}`);
          try {
            fs.unlinkSync(filePath);
          } catch (e) {
            console.error(`[Recorder] Failed to delete ${file}:`, e.message);
          }
        }
      }
    }
  } catch (err) {
    console.error('[Recorder] Cleanup error:', err.message);
  }
}

/**
 * Sanitize stream.m3u8 in temp directory:
 * 1. Filter out missing .ts segments
 * 2. Append #EXT-X-ENDLIST tag so FFmpeg demuxer knows the stream has ended
 */
function sanitizePlaylistForConversion(tempHlsDir) {
  const playlistPath = path.join(tempHlsDir, 'stream.m3u8');
  if (!fs.existsSync(playlistPath)) return false;

  try {
    const content = fs.readFileSync(playlistPath, 'utf8');
    const lines = content.split('\n');
    const sanitizedLines = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (line.endsWith('.ts')) {
        const tsPath = path.join(tempHlsDir, line);
        if (fs.existsSync(tsPath) && fs.statSync(tsPath).size > 0) {
          // Segment exists on disk, keep #EXTINF preceding tag if applicable
          if (i > 0 && lines[i - 1].trim().startsWith('#EXTINF:')) {
            sanitizedLines.push(lines[i - 1].trim());
          }
          sanitizedLines.push(line);
        }
      } else if (!line.startsWith('#EXTINF:') && line !== '#EXT-X-ENDLIST') {
        sanitizedLines.push(line);
      }
    }

    // Always append #EXT-X-ENDLIST tag so FFmpeg finishes demuxing cleanly
    sanitizedLines.push('#EXT-X-ENDLIST');
    fs.writeFileSync(playlistPath, sanitizedLines.join('\n'));
    return true;
  } catch (err) {
    console.error('[HLS Sanitizer] Error sanitizing playlist:', err.message);
    return false;
  }
}

/**
 * Convert a temp HLS directory containing stream.m3u8 into a single 10-minute MP4 file
 */
function convertHlsToMp4(tempHlsDir, outputMp4Filename) {
  return new Promise((resolve) => {
    ensureDirs();
    const playlistPath = path.join(tempHlsDir, 'stream.m3u8');
    const outputPath = path.join(RECORDINGS_DIR, outputMp4Filename);

    if (!fs.existsSync(playlistPath)) {
      console.log(`[HLS Converter] No stream.m3u8 found in ${tempHlsDir}, skipping conversion.`);
      try {
        fs.rmSync(tempHlsDir, { recursive: true, force: true });
      } catch (e) {}
      return resolve(null);
    }

    // Sanitize playlist & append #EXT-X-ENDLIST tag
    sanitizePlaylistForConversion(tempHlsDir);

    console.log(`[HLS Converter] Processing HLS segments in ${tempHlsDir} -> ${outputMp4Filename}`);

    const command = ffmpeg(playlistPath)
      .inputOptions([
        '-allowed_extensions ALL',
        '-protocol_whitelist file,http,https,tcp,tls,crypto,data',
      ])
      .outputOptions([
        '-c copy',              // Fast stream copy concatenation (0 CPU usage, ultra fast)
        '-movflags +faststart', // Web optimized MP4 headers
      ])
      .output(outputPath);

    command.on('end', () => {
      console.log(`[HLS Converter] Successfully generated 10-min MP4: ${outputMp4Filename}`);
      try {
        fs.rmSync(tempHlsDir, { recursive: true, force: true });
      } catch (e) {}
      cleanupOldRecordings();
      resolve(outputPath);
    });

    command.on('error', (err) => {
      console.error(`[HLS Converter] Error processing HLS to MP4:`, err.message);
      try {
        fs.rmSync(tempHlsDir, { recursive: true, force: true });
      } catch (e) {}
      resolve(null);
    });

    command.run();
  });
}

/**
 * Scan temp directory on startup and process any leftover un-converted HLS batch folders into MP4 files
 */
async function processExistingTempBatches() {
  ensureDirs();
  console.log('[Startup Recovery] Checking for existing/leftover temp HLS recording batches...');

  try {
    const items = fs.readdirSync(TEMP_DIR);
    for (const item of items) {
      const itemPath = path.join(TEMP_DIR, item);
      if (fs.statSync(itemPath).isDirectory()) {
        const playlistPath = path.join(itemPath, 'stream.m3u8');
        if (fs.existsSync(playlistPath)) {
          const stats = fs.statSync(playlistPath);
          const slotName = `${getSlotStartTimestamp(stats.mtime)}.mp4`;
          console.log(`[Startup Recovery] Found leftover temp batch (${item}) -> converting to ${slotName}`);
          await convertHlsToMp4(itemPath, slotName);
        } else {
          try {
            fs.rmSync(itemPath, { recursive: true, force: true });
          } catch (e) {}
        }
      }
    }
  } catch (err) {
    console.error('[Startup Recovery] Error processing existing temp batches:', err.message);
  }
}

/**
 * Start automated 10-minute interval recording loop
 */
async function startRecordingLoop(rtspUrl) {
  // First, process any leftover temp batch directories before starting new loop
  await processExistingTempBatches();

  currentRtspUrl = rtspUrl;
  isRecording = true;

  const now = new Date();
  const secondsToNext = getSecondsToNextBoundary(now);
  currentSlotName = `${getSlotStartTimestamp(now)}.mp4`;

  console.log(`[Recorder] Initializing 10-min boundary scheduler.`);
  console.log(`[Recorder] First segment (${currentSlotName}) aligned to next boundary in ${secondsToNext}s`);

  // Schedule next boundary rotation
  rotationTimer = setTimeout(async () => {
    if (isRecording && currentRtspUrl) {
      await rotateNextSegment();
    }
  }, secondsToNext * 1000);
}

/**
 * Rotate to full 10-minute segment & process completed HLS directory into MP4
 */
async function rotateNextSegment() {
  if (!isRecording || !currentRtspUrl) return;

  const streamService = require('./streamService');
  const now = new Date();

  // The slot that just completed is currentSlotName (e.g. 01:40)
  const completedSlotName = currentSlotName || `${getSlotStartTimestamp(now)}.mp4`;

  // The new slot starting now is assigned getSlotStartTimestamp(now) (e.g. 01:50)
  currentSlotName = `${getSlotStartTimestamp(now)}.mp4`;
  
  // Dynamically calculate exact seconds remaining until next 10-minute clock boundary
  const secondsToNext = getSecondsToNextBoundary(now);

  console.log(`[Recorder] 10-minute boundary reached.`);
  console.log(`[Recorder] Completed segment: ${completedSlotName}. Next segment (${currentSlotName}) aligned to boundary in ${secondsToNext}s`);

  // 1. Force-stop HLS stream, snapshot current HLS directory to temp folder, & start fresh HLS stream
  try {
    const tempHlsDir = await streamService.archiveHlsToTempAndRestart(currentRtspUrl);
    if (tempHlsDir) {
      // 2. Process archived HLS directory into single MP4 file named after COMPLETED slot (e.g. 01:40)
      convertHlsToMp4(tempHlsDir, completedSlotName);
    }
  } catch (err) {
    console.error('[Recorder] Error archiving HLS on rotation:', err.message);
  }

  // 3. Schedule next boundary rotation dynamically to prevent clock drift
  rotationTimer = setTimeout(async () => {
    if (isRecording && currentRtspUrl) {
      await rotateNextSegment();
    }
  }, secondsToNext * 1000);
}

/**
 * Stop recording loop
 */
async function stopRecordingLoop() {
  isRecording = false;
  currentRtspUrl = null;
  currentSlotName = null;
  if (rotationTimer) {
    clearTimeout(rotationTimer);
    rotationTimer = null;
  }
}

/**
 * List all downloadable recordings
 */
function getRecordingsList() {
  ensureDirs();
  cleanupOldRecordings();

  try {
    const files = fs.readdirSync(RECORDINGS_DIR);
    const recordings = files
      .filter((file) => file.endsWith('.mp4'))
      .map((file) => {
        const filePath = path.join(RECORDINGS_DIR, file);
        const stats = fs.statSync(filePath);
        return {
          filename: file,
          sizeBytes: stats.size,
          sizeMB: (stats.size / (1024 * 1024)).toFixed(2),
          createdAt: stats.birthtime || stats.mtime,
          modifiedAt: stats.mtime,
          downloadUrl: `/api/recordings/download?id=${file}`,
          streamUrl: `/api/recordings/stream/${file}`,
          playUrl: `/api/recordings/stream/${file}`,
        };
      })
      .sort((a, b) => b.modifiedAt - a.modifiedAt); // Newest first

    return recordings;
  } catch (err) {
    console.error('[Recorder] Error listing recordings:', err.message);
    return [];
  }
}

module.exports = {
  startRecordingLoop,
  stopRecordingLoop,
  convertHlsToMp4,
  processExistingTempBatches,
  getCurrentSlotName,
  getRecordingsList,
  RECORDINGS_DIR,
  TEMP_DIR,
};
