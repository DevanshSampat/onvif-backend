const ffmpeg = require('fluent-ffmpeg');
const fs = require('fs');
const path = require('path');

let activeFfmpegCommand = null;
let currentStreamInfo = null;

const HLS_DIR = path.join(__dirname, 'public', 'hls');

// Ensure HLS output directory exists
function ensureHlsDirectory() {
  if (!fs.existsSync(HLS_DIR)) {
    fs.mkdirSync(HLS_DIR, { recursive: true });
  }
}

// Clean old HLS segment and playlist files
function cleanHlsDirectory() {
  ensureHlsDirectory();
  try {
    const files = fs.readdirSync(HLS_DIR);
    for (const file of files) {
      if (file.endsWith('.m3u8') || file.endsWith('.ts') || file.endsWith('.tmp')) {
        try {
          fs.unlinkSync(path.join(HLS_DIR, file));
        } catch (e) {
          // Ignore busy file unlinks
        }
      }
    }
  } catch (err) {
    console.error('Error cleaning HLS directory:', err.message);
  }
}

/**
 * Stop active FFmpeg process
 */
function stopStream() {
  return new Promise((resolve) => {
    if (activeFfmpegCommand) {
      console.log('Stopping active FFmpeg transcoding session...');
      try {
        activeFfmpegCommand.kill('SIGKILL');
      } catch (e) {
        console.error('Error killing FFmpeg process:', e.message);
      }
      activeFfmpegCommand = null;
      currentStreamInfo = null;
    }
    setTimeout(resolve, 500);
  });
}

/**
 * Start RTSP to HLS transcode process using FFmpeg
 */
async function startStream(rtspUrl, options = {}) {
  await stopStream();
  cleanHlsDirectory();

  const playlistPath = path.join(HLS_DIR, 'stream.m3u8');
  console.log(`Starting FFmpeg stream transcode from: ${rtspUrl.replace(/:[^:@]+@/, ':****@')}`);

  return new Promise((resolve, reject) => {
    let resolved = false;

    // FFmpeg options optimized for HEVC/H.264 camera streams, high speed, and low latency
    const command = ffmpeg(rtspUrl)
      .inputOptions([
        '-analyzeduration 2000000',
        '-probesize 2000000',
      ])
      .outputOptions([
        '-c:v h264_videotoolbox',  // Use macOS hardware acceleration for fast HEVC -> H264 transcoding
        '-b:v 2M',
        '-an',                      // Disable audio to avoid PCM_ALAW audio sync stalls
        '-hls_time 1',
        '-hls_list_size 5',
        '-hls_flags delete_segments+omit_endlist',
        '-start_number 0',
      ])
      .output(playlistPath);

    // Fallback if hardware videotoolbox fails (e.g., non-macOS environments)
    command.on('error', (err) => {
      console.error('FFmpeg process error with h264_videotoolbox:', err.message);
      if (!resolved && !fs.existsSync(playlistPath)) {
        console.log('Retrying with libx264 software encoder...');
        startSoftwareFallbackStream(rtspUrl, playlistPath, resolve, reject);
        resolved = true;
      }
    });

    command.on('start', (cmdline) => {
      console.log('FFmpeg process started with command:', cmdline);
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

function startSoftwareFallbackStream(rtspUrl, playlistPath, resolve, reject) {
  const fallbackCommand = ffmpeg(rtspUrl)
    .outputOptions([
      '-c:v libx264',
      '-preset ultrafast',
      '-tune zerolatency',
      '-pix_fmt yuv420p',
      '-an',
      '-hls_time 1',
      '-hls_list_size 5',
      '-hls_flags delete_segments+omit_endlist',
      '-start_number 0',
    ])
    .output(playlistPath);

  fallbackCommand.on('error', (err) => {
    console.error('Software fallback FFmpeg error:', err.message);
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
  getStreamStatus,
  ensureHlsDirectory,
};
