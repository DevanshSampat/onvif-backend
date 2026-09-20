const { fork } = require('child_process');
const path = require('path');
const fs = require('fs');

const ALERTS_DIR = path.join(__dirname, 'human_detection_alerts');
const ALERTS_PROCESSING_DIR = path.join(__dirname, 'alerts_processing');
const LAST_PROCESSED_FILE = path.join(__dirname, 'last_processed_alert.txt');

let workerProcess = null;

function ensureDirs() {
  if (!fs.existsSync(ALERTS_DIR)) {
    fs.mkdirSync(ALERTS_DIR, { recursive: true });
  }
  if (!fs.existsSync(ALERTS_PROCESSING_DIR)) {
    fs.mkdirSync(ALERTS_PROCESSING_DIR, { recursive: true });
  }
}

/**
 * Start worker in an isolated child process so it never blocks the Express main event loop or livestream feed.
 */
function startAlertWorker() {
  if (workerProcess) return;
  ensureDirs();

  const workerScript = path.join(__dirname, 'detectionWorker.js');
  console.log(`[Alert Worker] Launching background detection worker process...`);

  workerProcess = fork(workerScript, [], {
    stdio: 'inherit',
  });

  workerProcess.on('exit', (code, signal) => {
    console.warn(`[Alert Worker] Worker process exited (code ${code} / signal ${signal}). Restarting worker in 5s...`);
    workerProcess = null;
    setTimeout(startAlertWorker, 5000);
  });
}

function getLastProcessedFilename() {
  if (fs.existsSync(LAST_PROCESSED_FILE)) {
    try {
      return fs.readFileSync(LAST_PROCESSED_FILE, 'utf8').trim() || null;
    } catch (e) {}
  }
  return null;
}

/**
 * List all saved alert snapshots
 */
function getAlertsList() {
  ensureDirs();
  try {
    const files = fs.readdirSync(ALERTS_DIR);
    return files
      .filter((file) => file.endsWith('.jpg'))
      .map((file) => {
        const filePath = path.join(ALERTS_DIR, file);
        const stats = fs.statSync(filePath);
        return {
          filename: file,
          sizeBytes: stats.size,
          sizeKB: (stats.size / 1024).toFixed(2),
          createdAt: stats.birthtime || stats.mtime,
          imageUrl: `/human_detection_alerts/${file}`,
          downloadUrl: `/api/alerts/download?id=${file}`,
        };
      })
      .sort((a, b) => b.filename.localeCompare(a.filename));
  } catch (err) {
    console.error('[Alert Processor] Error listing alerts:', err.message);
    return [];
  }
}

module.exports = {
  startAlertWorker,
  getAlertsList,
  getLastProcessedFilename,
  ALERTS_DIR,
  ALERTS_PROCESSING_DIR,
  LAST_PROCESSED_FILE,
};
