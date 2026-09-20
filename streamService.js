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

// Completely delete and recreate HLS output directory before starting
function resetHlsDirectory() {
  try {
    if (fs.existsSync(HLS_DIR)) {
      console.log('[HLS] Resetting/deleting old HLS directory for new 10-min block...');
      fs.rmSync(HLS_DIR, { recursive: true, force: true });
    }
  } catch (err) {
    console.error('Error resetting HLS directory:', err.message);
  }
  ensureHlsDirectory();
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
  await killHlsProcessOnly();

  // If stopping active stream, archive current HLS folder to MP4 before deleting
  const tempHlsDir = archiveHlsFolderToTemp();
  if (tempHlsDir) {
    const slotName = recordingService.getCurrentSlotName() || `${formatSegmentTimestamp(new Date())}_final.mp4`;
    recordingService.convertHlsToMp4(tempHlsDir, slotName);
  }
}

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
 * Archive current public/hls directory to temp directory
 */
function archiveHlsFolderToTemp() {
  ensureHlsDirectory();
  const playlistPath = path.join(HLS_DIR, 'stream.m3u8');

  if (!fs.existsSync(playlistPath)) {
    console.log('[HLS Archive] No active stream.m3u8 found to archive.');
    resetHlsDirectory();
    return null;
  }

  const tempBatchName = `hls_batch_${Date.now()}`;
  const tempHlsDir = path.join(TEMP_DIR, tempBatchName);

  try {
    console.log(`[HLS Archive] Archiving current HLS stream to temp -> ${tempBatchName}`);
    fs.renameSync(HLS_DIR, tempHlsDir);
  } catch (err) {
    console.error('[HLS Archive] Failed to rename HLS directory, copying files instead:', err.message);
    try {
      fs.mkdirSync(tempHlsDir, { recursive: true });
      const files = fs.readdirSync(HLS_DIR);
      for (const file of files) {
        fs.copyFileSync(path.join(HLS_DIR, file), path.join(tempHlsDir, file));
      }
    } catch (copyErr) {
      console.error('[HLS Archive] Copy failed:', copyErr.message);
    }
  }

  resetHlsDirectory();
  return tempHlsDir;
}

/**
 * Archive active HLS directory to temp and immediately restart HLS stream for new 10-min block
 */
async function archiveHlsToTempAndRestart(rtspUrl) {
  console.log('[HLS] 10-minute boundary reached: Force killing active HLS process & archiving HLS folder to temp...');
  await killHlsProcessOnly();

  const tempHlsDir = archiveHlsFolderToTemp();

  // Restart fresh HLS process immediately for next 10-min block
  await startHlsProcess(rtspUrl);

  return tempHlsDir;
}

/**
 * Start RTSP to HLS transcode process with event playlist type (keeping ALL segment files on disk for full 10 mins)
 */
async function startHlsProcess(rtspUrl) {
  await killHlsProcessOnly();
  ensureHlsDirectory();

  const playlistPath = path.join(HLS_DIR, 'stream.m3u8');
  console.log(`[HLS] Starting fresh HLS stream transcode from: ${rtspUrl.replace(/:[^:@]+@/, ':****@')}`);

  return new Promise((resolve, reject) => {
    let resolved = false;

    // FFmpeg options: DO NOT delete segments during 10-min event stream so full 10 mins are preserved on disk
    const command = ffmpeg(rtspUrl)
      .inputOptions([
        '-analyzeduration 2000000',
        '-probesize 2000000',
      ])
      .outputOptions([
        '-c:v h264_videotoolbox',  // Use macOS hardware acceleration for fast HEVC -> H264 transcoding
        '-b:v 2M',
        '-c:a aac',                 // Transcode audio to AAC for HLS audio playback
        '-b:a 128k',
        '-hls_time 1',
        '-hls_list_size 0',         // 0 keeps all segment entries in playlist for full 10 minutes
        '-hls_flags omit_endlist+discont_start', // DO NOT use delete_segments (so all 600s .ts files remain intact)
        '-hls_playlist_type event',
        '-start_number 0',
      ])
      .output(playlistPath);

    command.on('error', (err) => {
      // Ignore SIGKILL exit errors when resetting
      if (!err.message.includes('SIGKILL') && !err.message.includes('SIGINT')) {
        console.error('[HLS] FFmpeg process error with h264_videotoolbox:', err.message);
        if (!resolved && !fs.existsSync(playlistPath)) {
          console.log('[HLS] Retrying with libx264 software encoder...');
          startSoftwareFallbackStream(rtspUrl, playlistPath, resolve, reject);
          resolved = true;
        }
      }
    });

    command.on('start', (cmdline) => {
      console.log('[HLS] FFmpeg HLS process started.');
      currentStreamInfo = {
        rtspUrl,
        startTime: new Date(),
        playlistUrl: '/hls/stream.m3u8',
      };
    });

    activeFfmpegCommand = command;
    command.run();

    // Check periodically for playlist file creation
    const checkInterval = setInterval(() => {
      if (fs.existsSync(playlistPath)) {
        clearInterval(checkInterval);
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

    // Timeout fallback after 12 seconds
    setTimeout(() => {
      clearInterval(checkInterval);
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
    }, 12000);
  });
}

/**
 * Start stream entrypoint (initializes HLS + recording loop)
 */
async function startStream(rtspUrl, options = {}) {
  await stopStream();
  resetHlsDirectory();

  // Trigger 10-minute interval MP4 recording manager
  recordingService.startRecordingLoop(rtspUrl).catch((err) => {
    console.error('Failed to start recording loop:', err.message);
  });

  return await startHlsProcess(rtspUrl);
}

function startSoftwareFallbackStream(rtspUrl, playlistPath, resolve, reject) {
  const fallbackCommand = ffmpeg(rtspUrl)
    .outputOptions([
      '-c:v libx264',
      '-preset ultrafast',
      '-tune zerolatency',
      '-pix_fmt yuv420p',
      '-c:a aac',
      '-b:a 128k',
      '-hls_time 1',
      '-hls_list_size 0',
      '-hls_flags omit_endlist+discont_start',
      '-hls_playlist_type event',
      '-start_number 0',
    ])
    .output(playlistPath);

  fallbackCommand.on('error', (err) => {
    if (!err.message.includes('SIGKILL') && !err.message.includes('SIGINT')) {
      console.error('Software fallback FFmpeg error:', err.message);
    }
  });

  activeFfmpegCommand = fallbackCommand;
  fallbackCommand.run();
  resolve({ status: 'active', playlistUrl: '/hls/stream.m3u8' });
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
  archiveHlsToTempAndRestart,
  getStreamStatus,
  ensureHlsDirectory,
  resetHlsDirectory,
};
