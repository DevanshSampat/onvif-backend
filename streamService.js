const ffmpeg = require('fluent-ffmpeg');
const fs = require('fs');
const path = require('path');
const recordingService = require('./recordingService');

let activeFfmpegCommand = null;
let currentStreamInfo = null;

const HLS_DIR = path.join(__dirname, 'public', 'hls');
const TEMP_DIR = path.join(__dirname, 'temp');

// Ensure directories exist
function ensureHlsDirectory() {
  if (!fs.existsSync(HLS_DIR)) {
    fs.mkdirSync(HLS_DIR, { recursive: true });
  }
  if (!fs.existsSync(TEMP_DIR)) {
    fs.mkdirSync(TEMP_DIR, { recursive: true });
  }
}

// Clear HLS output directory files before starting
function resetHlsDirectory() {
  ensureHlsDirectory();
  try {
    if (fs.existsSync(HLS_DIR)) {
      console.log('[HLS] Resetting/clearing old HLS directory for new 10-min block...');
      const files = fs.readdirSync(HLS_DIR);
      for (const file of files) {
        try {
          fs.unlinkSync(path.join(HLS_DIR, file));
        } catch (e) {
          // File may be temporarily held
        }
      }
    }
  } catch (err) {
    console.error('Error resetting HLS directory:', err.message);
  }
}

/**
 * Forcefully terminate active HLS FFmpeg process
 */
function killHlsProcessOnly() {
  return new Promise((resolve) => {
    if (activeFfmpegCommand) {
      console.log('[HLS] Forcefully terminating active FFmpeg HLS process...');
      try {
        activeFfmpegCommand.kill('SIGKILL');
      } catch (e) {
        console.error('Error killing HLS process:', e.message);
      }
      activeFfmpegCommand = null;
      currentStreamInfo = null;
    }
    setTimeout(resolve, 300);
  });
}

/**
 * Stop active HLS process & recording loop
 */
async function stopStream() {
  await recordingService.stopRecordingLoop();

  // If stopping active stream, slice remaining segment range into temp before killing process
  const tempHlsDir = sliceSegmentRangeToTemp();
  if (tempHlsDir) {
    const slotName = recordingService.getCurrentSlotName() || `${formatSegmentTimestamp(new Date())}_final.mp4`;
    recordingService.convertHlsToMp4(tempHlsDir, slotName);
  }

  await killHlsProcessOnly();
}

function formatSegmentTimestamp(date) {
  const pad = (n) => String(n).padStart(2, '0');
  const yyyy = date.getFullYear();
  const mm = pad(date.getMonth() + 1);
  const dd = pad(date.getDate());
  const hh = pad(date.getHours());
  const min = pad(date.getMinutes());
  return `${yyyy}-${mm}-${dd}_${hh}-${min}`;
}

let lastTrackedSegmentIndex = 0;

/**
 * Get current active stream segment index range and reset/set initial index
 */
function resetTrackedSegmentIndex() {
  lastTrackedSegmentIndex = 0;
}

/**
 * Extract HLS segment index from filename (e.g. stream12.ts -> 12)
 */
function getSegmentIndexFromFilename(filename) {
  const match = filename.match(/stream(\d+)\.ts$/);
  return match ? parseInt(match[1], 10) : null;
}

/**
 * Slice TS segments from lastTrackedSegmentIndex to newest available segment into a temp HLS folder
 */
function sliceSegmentRangeToTemp() {
  ensureHlsDirectory();
  const playlistPath = path.join(HLS_DIR, 'stream.m3u8');

  if (!fs.existsSync(playlistPath)) {
    console.log('[HLS Slice] No active stream.m3u8 found to slice.');
    return null;
  }

  const files = fs.readdirSync(HLS_DIR);
  const tsFiles = [];

  for (const file of files) {
    const idx = getSegmentIndexFromFilename(file);
    if (idx !== null) {
      tsFiles.push({ filename: file, index: idx });
    }
  }

  if (tsFiles.length === 0) {
    console.log('[HLS Slice] No .ts segment files found in HLS directory.');
    return null;
  }

  // Sort by segment index ascending
  tsFiles.sort((a, b) => a.index - b.index);

  const newestIndex = tsFiles[tsFiles.length - 1].index;
  const startIndex = lastTrackedSegmentIndex;

  // Filter segments in range [startIndex, newestIndex]
  const targetSegments = tsFiles.filter((item) => item.index >= startIndex && item.index <= newestIndex);

  if (targetSegments.length === 0) {
    console.log(`[HLS Slice] No new segments found between stream${startIndex}.ts and stream${newestIndex}.ts.`);
    return null;
  }

  const tempBatchName = `hls_batch_${Date.now()}`;
  const tempHlsDir = path.join(TEMP_DIR, tempBatchName);
  fs.mkdirSync(tempHlsDir, { recursive: true });

  console.log(`[HLS Slice] Slicing segments stream${targetSegments[0].index}.ts to stream${newestIndex}.ts into ${tempBatchName}`);

  // Construct stream.m3u8 in temp directory for the targeted segment range
  const tempPlaylistPath = path.join(tempHlsDir, 'stream.m3u8');
  const playlistLines = [
    '#EXTM3U',
    '#EXT-X-VERSION:3',
    '#EXT-X-TARGETDURATION:2',
    '#EXT-X-MEDIA-SEQUENCE:0',
  ];

  for (const seg of targetSegments) {
    const srcFile = path.join(HLS_DIR, seg.filename);
    const destFile = path.join(tempHlsDir, seg.filename);
    try {
      fs.copyFileSync(srcFile, destFile);
      playlistLines.push('#EXTINF:1.000000,');
      playlistLines.push(seg.filename);
    } catch (e) {
      console.error(`[HLS Slice] Failed to copy segment ${seg.filename}:`, e.message);
    }
  }

  playlistLines.push('#EXT-X-ENDLIST');
  fs.writeFileSync(tempPlaylistPath, playlistLines.join('\n'));

  // Update last tracked index for the next 10-minute slice
  lastTrackedSegmentIndex = newestIndex + 1;
  console.log(`[HLS Slice] Updated lastTrackedSegmentIndex to ${lastTrackedSegmentIndex}`);

  return tempHlsDir;
}

/**
 * Select the optimal H.264 video encoder based on host OS
 */
function getPrimaryVideoEncoder() {
  if (process.platform === 'darwin') {
    return {
      name: 'h264_videotoolbox',
      options: [
        '-c:v h264_videotoolbox',
        '-b:v 2M',
        '-pix_fmt yuv420p',
      ],
    };
  }

  // Windows & Linux: libx264 ultrafast zerolatency for real-time low-latency transcoding
  return {
    name: 'libx264',
    options: [
      '-c:v libx264',
      '-preset ultrafast',
      '-tune zerolatency',
      '-pix_fmt yuv420p',
      '-b:v 2M',
    ],
  };
}

/**
 * Spawn and monitor an FFmpeg HLS transcoding process
 */
function runHlsStreamWithEncoder(rtspUrl, playlistPath, encoder, canFallback = true) {
  return new Promise((resolve, reject) => {
    let resolved = false;
    let checkInterval = null;
    let timeoutTimer = null;

    const cleanup = () => {
      if (checkInterval) {
        clearInterval(checkInterval);
        checkInterval = null;
      }
      if (timeoutTimer) {
        clearTimeout(timeoutTimer);
        timeoutTimer = null;
      }
    };

    console.log(`[HLS] Spawning FFmpeg with encoder: ${encoder.name}...`);

    // FFmpeg options: event playlist type preserves all segments for the full 10-min block
    const command = ffmpeg(rtspUrl)
      .inputOptions([
        '-analyzeduration 2000000',
        '-probesize 2000000',
      ])
      .outputOptions([
        ...encoder.options,
        '-c:a aac',
        '-b:a 128k',
        '-hls_time 1',
        '-hls_list_size 0',
        '-hls_flags omit_endlist+discont_start',
        '-hls_playlist_type event',
        '-start_number 0',
      ])
      .output(playlistPath);

    command.on('start', (cmdline) => {
      console.log(`[HLS] FFmpeg HLS process started (${encoder.name}).`);
      currentStreamInfo = {
        rtspUrl,
        startTime: new Date(),
        playlistUrl: '/hls/stream.m3u8',
        encoder: encoder.name,
      };
    });

    command.on('error', (err) => {
      // Ignore SIGKILL/SIGINT exit errors when intentionally stopping/resetting
      if (err.message.includes('SIGKILL') || err.message.includes('SIGINT')) {
        return;
      }

      console.error(`[HLS] FFmpeg process error with ${encoder.name}:`, err.message);

      if (!resolved && !fs.existsSync(playlistPath)) {
        cleanup();
        if (canFallback && encoder.name !== 'libx264') {
          console.log('[HLS] Retrying with libx264 software encoder fallback...');
          const fallbackEncoder = {
            name: 'libx264',
            options: [
              '-c:v libx264',
              '-preset ultrafast',
              '-tune zerolatency',
              '-pix_fmt yuv420p',
              '-b:v 2M',
            ],
          };
          runHlsStreamWithEncoder(rtspUrl, playlistPath, fallbackEncoder, false)
            .then(resolve)
            .catch(reject);
          resolved = true;
          return;
        }

        resolved = true;
        reject(new Error(`FFmpeg error (${encoder.name}): ${err.message}`));
      } else {
        if (activeFfmpegCommand === command) {
          activeFfmpegCommand = null;
          currentStreamInfo = null;
        }
      }
    });

    activeFfmpegCommand = command;
    command.run();

    // Check periodically for playlist file creation
    checkInterval = setInterval(() => {
      if (fs.existsSync(playlistPath)) {
        cleanup();
        if (!resolved) {
          resolved = true;
          resolve({
            status: 'active',
            playlistUrl: '/hls/stream.m3u8',
            hlsDir: HLS_DIR,
          });
        }
      }
    }, 500);

    // Timeout fallback after 35 seconds (camera needs headroom on cold boot)
    timeoutTimer = setTimeout(() => {
      cleanup();
      if (!resolved) {
        resolved = true;
        if (activeFfmpegCommand && fs.existsSync(playlistPath)) {
          resolve({
            status: 'starting',
            playlistUrl: '/hls/stream.m3u8',
            hlsDir: HLS_DIR,
          });
        } else {
          reject(new Error('Stream initialization timed out. Please check RTSP URL connection.'));
        }
      }
    }, 35000);
  });
}

/**
 * Start RTSP to HLS transcode process with event playlist type
 */
async function startHlsProcess(rtspUrl) {
  await killHlsProcessOnly();
  ensureHlsDirectory();

  const playlistPath = path.join(HLS_DIR, 'stream.m3u8');
  console.log(`[HLS] Starting fresh HLS stream transcode from: ${rtspUrl.replace(/:[^:@]+@/, ':****@')}`);

  const primaryEncoder = getPrimaryVideoEncoder();
  return runHlsStreamWithEncoder(rtspUrl, playlistPath, primaryEncoder, true);
}

/**
 * Start stream entrypoint (initializes HLS + recording loop)
 */
async function startStream(rtspUrl, options = {}) {
  await stopStream();
  resetHlsDirectory();
  resetTrackedSegmentIndex();

  let targetUrl = rtspUrl;
  if (options.channel !== undefined) {
    if (options.channel === 1 || options.channel === '1') {
      targetUrl = targetUrl.replace('/channel0', '/channel1').replace('channel=0', 'channel=1');
    } else if (options.channel === 0 || options.channel === '0') {
      targetUrl = targetUrl.replace('/channel1', '/channel0').replace('channel=1', 'channel=0');
    }
  }

  // Trigger 10-minute interval MP4 recording manager
  recordingService.startRecordingLoop(targetUrl).catch((err) => {
    console.error('Failed to start recording loop:', err.message);
  });

  return await startHlsProcess(targetUrl);
}

function getStreamStatus() {
  return {
    active: !!activeFfmpegCommand,
    info: currentStreamInfo,
  };
}

module.exports = {
  startStream,
  stopStream,
  sliceSegmentRangeToTemp,
  getStreamStatus,
  ensureHlsDirectory,
  resetHlsDirectory,
};
