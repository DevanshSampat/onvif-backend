const ffmpeg = require('fluent-ffmpeg');
const fs = require('fs');
const path = require('path');
const jpeg = require('jpeg-js');
const tf = require('@tensorflow/tfjs');
require('@tensorflow/tfjs-backend-wasm');
const cocoSsd = require('@tensorflow-models/coco-ssd');
const { sendCameraAlertNotification } = require('./fcmNotifier');

const ALERTS_DIR = path.join(__dirname, 'human_detection_alerts');
const ALERTS_PROCESSING_DIR = path.join(__dirname, 'alerts_processing');
const HLS_DIR = path.join(__dirname, 'public', 'hls');

const ONE_MINUTE_MS = 60 * 1000;

let model = null;
let lastProcessedTsIndex = null;
let lastPersonDetectionTimestamp = 0;

function ensureDirs() {
  if (!fs.existsSync(ALERTS_DIR)) {
    fs.mkdirSync(ALERTS_DIR, { recursive: true });
  }
  if (!fs.existsSync(ALERTS_PROCESSING_DIR)) {
    fs.mkdirSync(ALERTS_PROCESSING_DIR, { recursive: true });
  }
}

async function loadModel() {
  if (!model) {
    console.log('[Alert Worker Process] Loading COCO-SSD AI model with WASM backend in isolated process...');
    await tf.setBackend('wasm');
    model = await cocoSsd.load();
    console.log('[Alert Worker Process] COCO-SSD AI model loaded successfully.');
  }
  return model;
}

function isImageDistorted(rawImageData) {
  const w = rawImageData.width;
  const h = rawImageData.height;
  const data = rawImageData.data;

  let noisyRowsCount = 0;
  for (let y = 0; y < h; y++) {
    let diff = 0;
    for (let x = 0; x < w - 1; x++) {
      const idx = (y * w + x) * 3;
      diff += Math.abs(data[idx] - data[idx + 3]) + Math.abs(data[idx + 1] - data[idx + 4]) + Math.abs(data[idx + 2] - data[idx + 5]);
    }
    if ((diff / w) > 45) {
      noisyRowsCount++;
    }
  }

  // Distorted if over 5% of total image height contains corrupt macroblock noise bands
  return (noisyRowsCount / h) > 0.05;
}

async function analyzeFrameForPerson(imagePath) {
  try {
    const net = await loadModel();
    const jpegBuffer = fs.readFileSync(imagePath);
    const rawImageData = jpeg.decode(jpegBuffer, { useTtf: false, formatAsRGBA: false });

    // Distortion check as in personDetectionFilterResults.js
    if (isImageDistorted(rawImageData)) {
      console.log(`[Alert Worker Process] Frame ${path.basename(imagePath)} is distorted (stream artifact/noise). Filtering out.`);
      return { detected: false, score: 0 };
    }

    const numChannels = 3;
    const values = new Int32Array(rawImageData.width * rawImageData.height * numChannels);
    for (let i = 0; i < rawImageData.data.length; i++) {
      values[i] = rawImageData.data[i];
    }

    const imageTensor = tf.tensor3d(values, [rawImageData.height, rawImageData.width, numChannels], 'int32');
    const predictions = await net.detect(imageTensor);
    imageTensor.dispose();

    const personDetections = predictions.filter((p) => p.class === 'person');

    if (personDetections.length > 0) {
      let scoreSum = 0;
      let widthSum = 0;
      let heightSum = 0;

      personDetections.forEach((p) => {
        scoreSum += p.score;
        widthSum += p.bbox[2];
        heightSum += p.bbox[3];
      });

      const avgScore = scoreSum / personDetections.length;
      const avgWidth = widthSum / personDetections.length;
      const avgHeight = heightSum / personDetections.length;

      // Apply score (>= 0.7) and bbox dimensions (width >= 350, height >= 500) filters
      if (avgScore >= 0.7 && avgWidth >= 350 && avgHeight >= 500) {
        return { detected: true, score: avgScore, width: avgWidth, height: avgHeight };
      }
    }

    return { detected: false, score: 0 };
  } catch (err) {
    console.error(`[Alert Worker Process] Error analyzing frame ${path.basename(imagePath)}:`, err.message);
    return { detected: false, score: 0 };
  }
}

function extractFramesFromTs(tsFilePath, outputDir) {
  return new Promise((resolve, reject) => {
    const outputPattern = path.join(outputDir, 'frame_%04d.jpg');

    ffmpeg(tsFilePath)
      .outputOptions([
        '-vf fps=1',
        '-q:v 2',
      ])
      .output(outputPattern)
      .on('end', () => resolve())
      .on('error', (err) => reject(err))
      .run();
  });
}

function clearProcessingDir() {
  if (fs.existsSync(ALERTS_PROCESSING_DIR)) {
    const files = fs.readdirSync(ALERTS_PROCESSING_DIR);
    for (const file of files) {
      try {
        fs.unlinkSync(path.join(ALERTS_PROCESSING_DIR, file));
      } catch (e) {}
    }
  }
}

function getFormattedAlertFilename(d = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  const year = d.getFullYear();
  const month = pad(d.getMonth() + 1);
  const day = pad(d.getDate());
  const hours = pad(d.getHours());
  const minutes = pad(d.getMinutes());
  let baseName = `${year}-${month}-${day}_${hours}-${minutes}`;
  let filename = `${baseName}.jpg`;
  let counter = 1;
  while (fs.existsSync(path.join(ALERTS_DIR, filename))) {
    filename = `${baseName}_${counter}.jpg`;
    counter++;
  }
  return filename;
}

async function processTsFile(tsFilename) {
  ensureDirs();
  const tsFilePath = path.join(HLS_DIR, tsFilename);

  if (!fs.existsSync(tsFilePath)) {
    return false;
  }

  console.log(`[Alert Worker Process] Processing TS segment: ${tsFilename}`);
  clearProcessingDir();

  try {
    await extractFramesFromTs(tsFilePath, ALERTS_PROCESSING_DIR);

    const frameFiles = fs.readdirSync(ALERTS_PROCESSING_DIR)
      .filter((f) => f.endsWith('.jpg'))
      .sort();

    console.log(`[Alert Worker Process] Extracted ${frameFiles.length} frames from ${tsFilename} (1s interval).`);

    for (const frameFile of frameFiles) {
      const framePath = path.join(ALERTS_PROCESSING_DIR, frameFile);
      const result = await analyzeFrameForPerson(framePath);

      if (result.detected) {
        const now = Date.now();
        if (now - lastPersonDetectionTimestamp > ONE_MINUTE_MS) {
          const alertFilename = getFormattedAlertFilename(new Date(now));
          const alertFilePath = path.join(ALERTS_DIR, alertFilename);
          fs.copyFileSync(framePath, alertFilePath);
          console.log(`[Human Detection ALERT] Valid person detected in ${tsFilename} (${frameFile})! Score: ${(result.score * 100).toFixed(1)}%. Saved alert: human_detection_alerts/${alertFilename}`);
          lastPersonDetectionTimestamp = now;

          // Send FCM camera alert API request
          sendCameraAlertNotification(alertFilename).catch((err) => {
            console.error('[Alert Worker Process] Error sending camera alert notification:', err.message);
          });
        } else {
          console.log(`[Alert Worker Process] Person detected in ${tsFilename} (${frameFile}), but rate-limited (< 1 min since last alert). Updating timestamp silently.`);
          lastPersonDetectionTimestamp = now;
        }
      }
    }
    return true;
  } catch (err) {
    console.error(`[Alert Worker Process] Error processing TS segment ${tsFilename}:`, err.message);
    return false;
  } finally {
    clearProcessingDir();
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runWorkerLoop() {
  ensureDirs();
  console.log('[Alert Worker Process] Background TS watcher process started.');

  while (true) {
    try {
      if (!fs.existsSync(HLS_DIR)) {
        await sleep(5000);
        continue;
      }

      // Query directory once on initial startup to discover current TS index
      if (lastProcessedTsIndex === null) {
        const files = fs.readdirSync(HLS_DIR);
        const indices = files
          .map((f) => {
            const match = f.match(/stream(\d+)\.ts$/);
            return match ? parseInt(match[1], 10) : null;
          })
          .filter((idx) => idx !== null)
          .sort((a, b) => a - b);

        if (indices.length > 0) {
          // Set to lowest index minus 1 so stream processing starts at lowest available segment
          lastProcessedTsIndex = indices[0] - 1;
          console.log(`[Alert Worker Process] Initial directory scan completed. Starting from segment index stream${lastProcessedTsIndex + 1}.ts`);
        } else {
          // No TS files found yet, wait for next cycle
          await sleep(5000);
          continue;
        }
      }

      // Process sequential TS files without re-reading directory contents
      let nextIndex = lastProcessedTsIndex + 1;
      let nextFilename = `stream${nextIndex}.ts`;

      while (fs.existsSync(path.join(HLS_DIR, nextFilename))) {
        await processTsFile(nextFilename);
        lastProcessedTsIndex = nextIndex;
        nextIndex = lastProcessedTsIndex + 1;
        nextFilename = `stream${nextIndex}.ts`;
      }
    } catch (err) {
      console.error('[Alert Worker Process] Error in TS worker loop:', err.message);
    }

    await sleep(5000);
  }
}

runWorkerLoop();

