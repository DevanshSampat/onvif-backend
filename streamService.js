const ffmpeg = require('fluent-ffmpeg');
const fs = require('fs');
const path = require('path');
const recordingService = require('./recordingService');

let activeFfmpegCommand = null;
let currentStreamInfo = null;
let currentActiveRtspUrl = null;
let isIntentionallyStopped = false;
let watchdogInterval = null;
let watchdogStartTimer = null;
let lastMtime = 0;
let stallCount = 0;

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
 * Stop playlist watchdog monitor
 */
function stopWatchdog() {
  if (watchdogStartTimer) {
    clearTimeout(watchdogStartTimer);
    watchdogStartTimer = null;
  }
  if (watchdogInterval) {
    clearInterval(watchdogInterval);
    watchdogInterval = null;
  }
  stallCount = 0;
  lastMtime = 0;
}

/**
 * Start 2-second heartbeat watchdog after a 60s warmup delay
 */
function startWatchdog(playlistPath) {
  stopWatchdog();
  console.log('[HLS Watchdog] Watchdog scheduler initialized; monitoring will activate in 60 seconds...');

  watchdogStartTimer = setTimeout(() => {
    if (isIntentionallyStopped || !activeFfmpegCommand) return;

    console.log('[HLS Watchdog] Warmup period elapsed. Active m3u8 heartbeat monitoring started.');
    lastMtime = fs.existsSync(playlistPath) ? fs.statSync(playlistPath).mtimeMs : 0;
    stallCount = 0;

    watchdogInterval = setInterval(() => {
      if (isIntentionallyStopped || !activeFfmpegCommand) return;

      if (!fs.existsSync(playlistPath)) {
        stallCount++;
      } else {
        try {
          const mtime = fs.statSync(playlistPath).mtimeMs;
          if (mtime === lastMtime) {
            stallCount++;
          } else {
            lastMtime = mtime;
            stallCount = 0;
          }
        } catch (e) {
          stallCount++;
        }
      }

      if (stallCount >= 15) {
        console.error(`[HLS Watchdog] ALERT: stream.m3u8 has NOT updated in ${stallCount * 2}s (Stream Stalled/Frozen)! Restarting FFmpeg stream...`);
        stallCount = 0;
        autoRestartStream();
      }
    }, 2000);
  }, 60000);
}

/**
 * Automatically attempt restarting stream on failure or stall
 */
async function autoRestartStream() {
  if (isIntentionallyStopped || !currentActiveRtspUrl) return;
  console.log('[HLS Watchdog] Attempting automatic stream recovery...');
  try {
    await killHlsProcessOnly();
    const playlistPath = path.join(HLS_DIR, 'stream.m3u8');
    const primaryEncoder = getPrimaryVideoEncoder();
    await runHlsStreamWithEncoder(currentActiveRtspUrl, playlistPath, primaryEncoder, true);
    console.log('[HLS Watchdog] Stream successfully auto-restarted!');
  } catch (err) {
    console.error('[HLS Watchdog] Auto-restart attempt failed:', err.message);
    setTimeout(() => {
      if (!isIntentionallyStopped && !activeFfmpegCommand) {
        autoRestartStream();
      }
    }, 5000);
  }
}

/**
 * Forcefully terminate active HLS FFmpeg process
 */
function killHlsProcessOnly() {
  return new Promise((resolve) => {
    stopWatchdog();
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
  isIntentionallyStopped = true;
  stopWatchdog();
  currentActiveRtspUrl = null;
  if (chunkPurgeInterval) {
    clearInterval(chunkPurgeInterval);
    chunkPurgeInterval = null;
  }
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
let lastProcessedSegmentIndex = 0;
let chunkPurgeInterval = null;

/**
 * Get current active stream segment index range and reset/set initial index
 */
function resetTrackedSegmentIndex() {
  lastTrackedSegmentIndex = 0;
  lastProcessedSegmentIndex = 0;
  startChunkPurgeWatcher();
}

/**
 * Continuously purge old segments from public/hls as soon as there are > 5 newer chunks available
 */
function purgeProcessedSegments() {
  if (!fs.existsSync(HLS_DIR)) return;

  try {
    const files = fs.readdirSync(HLS_DIR);
    const tsFiles = [];

    for (const file of files) {
      const idx = getSegmentIndexFromFilename(file);
      if (idx !== null) {
        tsFiles.push({ filename: file, index: idx });
      }
    }

    if (tsFiles.length <= 5) return;

    // Sort by segment index ascending
    tsFiles.sort((a, b) => a.index - b.index);
    const newestIndex = tsFiles[tsFiles.length - 1].index;
    const safeDeleteMaxIndex = newestIndex - 5;

    // Delete processed segments that are below or equal to lastProcessedSegmentIndex AND <= safeDeleteMaxIndex
    for (const seg of tsFiles) {
      if (seg.index <= lastProcessedSegmentIndex && seg.index <= safeDeleteMaxIndex) {
        const filePath = path.join(HLS_DIR, seg.filename);
        try {
          fs.unlinkSync(filePath);
        } catch (e) {}
      }
    }
  } catch (err) {
    // Silent catch for directory access during stream start/stop
  }
}

/**
 * Start 2-second interval background watcher to purge processed chunks dynamically as new ones arrive
 */
function startChunkPurgeWatcher() {
  if (chunkPurgeInterval) clearInterval(chunkPurgeInterval);
  chunkPurgeInterval = setInterval(purgeProcessedSegments, 2000);
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
    '#EXT-X-TARGETDURATION:15',
    '#EXT-X-MEDIA-SEQUENCE:0',
  ];

  for (const seg of targetSegments) {
    const srcFile = path.join(HLS_DIR, seg.filename);
    const destFile = path.join(tempHlsDir, seg.filename);
    try {
      fs.copyFileSync(srcFile, destFile);
      playlistLines.push('#EXTINF:12.000000,');
      playlistLines.push(seg.filename);
    } catch (e) {
      console.error(`[HLS Slice] Failed to copy segment ${seg.filename}:`, e.message);
    }
  }

  playlistLines.push('#EXT-X-ENDLIST');
  fs.writeFileSync(tempPlaylistPath, playlistLines.join('\n'));

  // Mark all segments in this batch as processed and update last tracked segment index
  lastProcessedSegmentIndex = newestIndex;
  lastTrackedSegmentIndex = newestIndex + 1;

  // Immediately run purge check
  purgeProcessedSegments();

  console.log(`[HLS Slice] Marked segments up to stream${newestIndex}.ts as processed. Purging as >5 new chunks arrive.`);

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
 * Calculate the next segment start number based on existing stream files in public/hls
 */
function getNextStartNumber() {
  ensureHlsDirectory();
  try {
    const files = fs.readdirSync(HLS_DIR);
    let maxIdx = -1;
    for (const file of files) {
      const idx = getSegmentIndexFromFilename(file);
      if (idx !== null && idx > maxIdx) {
        maxIdx = idx;
      }
    }
    return maxIdx >= 0 ? maxIdx + 1 : 0;
  } catch (e) {
    return 0;
  }
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

    const startNumber = getNextStartNumber();
    console.log(`[HLS] Spawning FFmpeg with encoder: ${encoder.name} (start_number: ${startNumber})...`);

    // FFmpeg options: hls_list_size 5 makes the livestream unseekable (real-time edge window)
    const command = ffmpeg(rtspUrl)
      .inputOptions([
        '-rtsp_transport udp',
        '-timeout 5000000',
        '-reorder_queue_size 0',
        '-analyzeduration 2000000',
        '-probesize 2000000',
      ])
      .outputOptions([
        ...encoder.options,
        '-c:a aac',
        '-b:a 128k',
        '-force_key_frames', 'expr:gte(t,n_forced*12)',
        '-hls_time 12',
        '-hls_list_size 5',
        '-hls_flags omit_endlist+discont_start',
        `-start_number ${startNumber}`,
      ])
      .output(playlistPath);

    const lastStderrLines = [];

    command.on('start', (cmdline) => {
      console.log(`[HLS] FFmpeg HLS process started (${encoder.name}).`);
      currentStreamInfo = {
        rtspUrl,
        startTime: new Date(),
        playlistUrl: '/hls/stream.m3u8',
        encoder: encoder.name,
      };
      startWatchdog(playlistPath);
    });

    command.on('stderr', (stderrLine) => {
      lastStderrLines.push(stderrLine);
      if (lastStderrLines.length > 15) {
        lastStderrLines.shift();
      }
      if (stderrLine.includes('error') || stderrLine.includes('Failed') || stderrLine.includes('timeout') || stderrLine.includes('Server returned') || stderrLine.includes('Connection refused')) {
        console.warn(`[FFmpeg stderr] ${stderrLine}`);
      }
    });

    command.on('end', () => {
      console.log('[HLS] FFmpeg process ended/closed.');
      if (lastStderrLines.length > 0) {
        console.warn(`[FFmpeg Last Log Lines before exit]:\n${lastStderrLines.slice(-5).join('\n')}`);
      }
      if (activeFfmpegCommand === command) {
        activeFfmpegCommand = null;
        currentStreamInfo = null;
      }
      if (!isIntentionallyStopped && currentActiveRtspUrl) {
        console.log('[HLS Auto-Reconnect] FFmpeg exited unexpectedly, attempting auto-restart...');
        autoRestartStream();
      }
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
        if (!isIntentionallyStopped && currentActiveRtspUrl) {
          console.log('[HLS Auto-Reconnect] FFmpeg process error, attempting auto-restart...');
          autoRestartStream();
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
  isIntentionallyStopped = false;
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

  currentActiveRtspUrl = targetUrl;

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
