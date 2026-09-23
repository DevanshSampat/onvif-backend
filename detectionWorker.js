const ffmpeg = require('fluent-ffmpeg');
const fs = require('fs');
const path = require('path');
const jpeg = require('jpeg-js');
const tf = require('@tensorflow/tfjs');
require('@tensorflow/tfjs-backend-wasm');
const cocoSsd = require('@tensorflow-models/coco-ssd');

const ALERTS_DIR = path.join(__dirname, 'human_detection_alerts');
const ALERTS_PROCESSING_DIR = path.join(__dirname, 'alerts_processing');
const RECORDINGS_DIR = path.join(__dirname, 'recordings');
const LAST_PROCESSED_FILE = path.join(__dirname, 'last_processed_alert.txt');
const FIVE_MINUTES_MS = 5 * 60 * 1000;

let model = null;
let lastAlertTime = 0;

function ensureDirs() {
  if (!fs.existsSync(ALERTS_DIR)) {
    fs.mkdirSync(ALERTS_DIR, { recursive: true });
  }
  if (!fs.existsSync(ALERTS_PROCESSING_DIR)) {
    fs.mkdirSync(ALERTS_PROCESSING_DIR, { recursive: true });
  }
}

function getLastProcessedFilename() {
  if (fs.existsSync(LAST_PROCESSED_FILE)) {
    try {
      const content = fs.readFileSync(LAST_PROCESSED_FILE, 'utf8').trim();
      return content || null;
    } catch (err) {
      console.error('[Alert Worker Process] Error reading last_processed_alert.txt:', err.message);
    }
  }
  return null;
}

function setLastProcessedFilename(filename) {
  try {
    fs.writeFileSync(LAST_PROCESSED_FILE, filename, 'utf8');
    console.log(`[Alert Worker Process] Updated last_processed_alert.txt -> ${filename}`);
  } catch (err) {
    console.error('[Alert Worker Process] Error writing last_processed_alert.txt:', err.message);
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

async function detectHumanInImage(imagePath) {
  try {
    const net = await loadModel();
    const jpegBuffer = fs.readFileSync(imagePath);
    const rawImageData = jpeg.decode(jpegBuffer, { useTtf: false, formatAsRGBA: false });

    const numChannels = 3;
    const values = new Int32Array(rawImageData.width * rawImageData.height * numChannels);

    for (let i = 0; i < rawImageData.data.length; i++) {
      values[i] = rawImageData.data[i];
    }

    const imageTensor = tf.tensor3d(values, [rawImageData.height, rawImageData.width, numChannels], 'int32');
    const predictions = await net.detect(imageTensor);

    imageTensor.dispose();

    const personDetections = predictions.filter(
      (p) => p.class === 'person' && p.score >= 0.5
    );

    return personDetections;
  } catch (err) {
    console.error('[Alert Worker Process] Error analyzing frame:', err.message);
    return [];
  }
}

function extractFramesFromMp4(mp4FilePath, outputDir) {
  return new Promise((resolve, reject) => {
    const outputPattern = path.join(outputDir, 'frame_%04d.jpg');

    ffmpeg(mp4FilePath)
      .outputOptions([
        '-vf fps=1/3',
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
      } catch (e) { }
    }
  }
}

async function processRecordFile(mp4Filename) {
  ensureDirs();
  const mp4FilePath = path.join(RECORDINGS_DIR, mp4Filename);

  if (!fs.existsSync(mp4FilePath)) {
    console.log(`[Alert Worker Process] Recorded file ${mp4Filename} not found, skipping.`);
    return;
  }

  console.log(`[Alert Worker Process] Starting human detection on recorded video: ${mp4Filename}`);
  clearProcessingDir();

  try {
    await extractFramesFromMp4(mp4FilePath, ALERTS_PROCESSING_DIR);

    const frameFiles = fs.readdirSync(ALERTS_PROCESSING_DIR)
      .filter((f) => f.endsWith('.jpg'))
      .sort();

    console.log(`[Alert Worker Process] Extracted ${frameFiles.length} frames from ${mp4Filename} for analysis.`);

    const lastDetections = [];

    for (const frameFile of frameFiles) {
      try {
        const framePath = path.join(ALERTS_PROCESSING_DIR, frameFile);
        console.log('[Alert Worker Process] Analyzing ', frameFile);
        const detections = await detectHumanInImage(framePath);

        if (detections.length > 0) {
          const now = Date.now();
          const videoName = path.parse(mp4Filename).name;
          const frameName = path.parse(frameFile).name;
          const alertFilename = `${videoName}_${frameName}.jpg`;
          const alertFilePath = path.join(ALERTS_DIR, alertFilename);
          lastDetections.push({ framePath, alertFilePath, score: detections[0].score })
          lastAlertTime = now;
        } else if (lastDetections.length > 0) {
          const filteredDetections = lastDetections.sort((a, b) => b.score - a.score);
          fs.copyFileSync(filteredDetections[0].framePath, filteredDetections[0].alertFilePath);
          console.log(`[Human Detection ALERT] Person detected in ${mp4Filename}! Saved alert: human_detection_alerts/${path.basename(filteredDetections[0].alertFilePath)}`);
          while (lastDetections.length > 0) lastDetections.pop();
        }
      } catch (error) {
        console.log(`Error processing file : ${error.message}`);
      }
    }
    if (lastDetections.length > 0) {
      const filteredDetections = lastDetections.sort((a, b) => b.score - a.score);
      fs.copyFileSync(filteredDetections[0].framePath, filteredDetections[0].alertFilePath);
      console.log(`[Human Detection ALERT] Person detected in ${mp4Filename}! Saved alert: human_detection_alerts/${path.basename(filteredDetections[0].alertFilePath)}`);
      while (lastDetections.length > 0) lastDetections.pop();
    }
  } catch (err) {
    console.error(`[Alert Worker Process] Error processing recording ${mp4Filename}:`, err.message);
  } finally {
    clearProcessingDir();
    setLastProcessedFilename(mp4Filename);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runWorkerLoop() {
  ensureDirs();
  console.log('[Alert Worker Process] Background worker process started on isolated process.');

  while (true) {
    try {
      if (fs.existsSync(RECORDINGS_DIR)) {
        const files = fs.readdirSync(RECORDINGS_DIR)
          .filter((file) => file.endsWith('.mp4'))
          .sort((a, b) => a.localeCompare(b));

        const lastProcessed = getLastProcessedFilename();
        let nextFile = null;

        if (!lastProcessed) {
          nextFile = files.length > 0 ? files[0] : null;
        } else {
          nextFile = files.find((file) => file > lastProcessed);
        }

        if (nextFile) {
          console.log(`[Alert Worker Process] Immediate next recording to process: ${nextFile}`);
          await processRecordFile(nextFile);
          await sleep(500);
          continue;
        }
      }
    } catch (err) {
      console.error('[Alert Worker Process] Error in worker loop:', err.message);
    }

    await sleep(5000);
  }
}

runWorkerLoop();
