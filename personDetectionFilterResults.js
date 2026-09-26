const fs = require('fs');
const path = require('path');
const jpeg = require('jpeg-js');
const tf = require('@tensorflow/tfjs');
require('@tensorflow/tfjs-backend-wasm');
const cocoSsd = require('@tensorflow-models/coco-ssd');

const ALERTS_DIR = path.join(__dirname, 'human_detection_alerts');
const fileMap = {};
let scores = {};

if (fs.existsSync('person_detection_scores.json')) {
  scores = JSON.parse(fs.readFileSync('person_detection_scores.json'));
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

async function checkScores() {
  console.log('====================================================');
  console.log('Human Detection Person Score Checker');
  console.log('====================================================');
  console.log('Loading COCO-SSD AI model (WASM backend)...');
  await tf.setBackend('wasm');
  const model = await cocoSsd.load();
  console.log('AI Model loaded successfully.\n');

  if (!fs.existsSync(ALERTS_DIR)) {
    console.log(`Directory not found: ${ALERTS_DIR}`);
    return;
  }

  const files = fs.readdirSync(ALERTS_DIR)
    .filter((file) => file.endsWith('.jpg'))
    .sort();

  if (files.length === 0) {
    console.log(`No alert image files (.jpg) found in ${ALERTS_DIR}`);
    return;
  }

  console.log(`Found ${files.length} alert image(s) in human_detection_alerts/\n`);

  for (const file of files) {
    const filePath = path.join(ALERTS_DIR, file);
    try {
      const jpegBuffer = fs.readFileSync(filePath);
      const rawImageData = jpeg.decode(jpegBuffer, { useTtf: false, formatAsRGBA: false });

      if (isImageDistorted(rawImageData)) {
        console.log(`Image ${file} is distorted (stream artifact/noise detected). Filtering out.`);
        fileMap[file] = { score: 0, width: 0, height: 0 };
        continue;
      }

      if (scores[file]) {
        fileMap[file] = scores[file];
        continue;
      }

      const numChannels = 3;
      const values = new Int32Array(rawImageData.width * rawImageData.height * numChannels);
      for (let i = 0; i < rawImageData.data.length; i++) {
        values[i] = rawImageData.data[i];
      }

      const imageTensor = tf.tensor3d(values, [rawImageData.height, rawImageData.width, numChannels], 'int32');
      const predictions = await model.detect(imageTensor);
      imageTensor.dispose();

      const personDetections = predictions.filter((p) => p.class === 'person');

      console.log(`Image: ${file}`);
      let score = 0;
      if (personDetections.length > 0) {
        let width = 0;
        let height = 0;
        personDetections.forEach((p, idx) => {
          console.log(`  └─ Person #${idx + 1}: Score = ${(p.score * 100).toFixed(2)}% (raw confidence: ${p.score.toFixed(4)})`);
          score += p.score;
          width += p.bbox[2];
          height += p.bbox[3];
        });
        width = width / personDetections.length;
        height = height / personDetections.length;
        if (width < 350 || height < 500) fileMap[file] = { score: 0, width: 0, height: 0 };
        else fileMap[file] = { score: score / personDetections.length, width: width / personDetections.length, height: height / personDetections.length };
      } else {
        const otherDetections = predictions.map((p) => `${p.class} (${(p.score * 100).toFixed(1)}%)`).join(', ');
        console.log(`  └─ No person detected. Other objects: [${otherDetections || 'none'}]`);
        fileMap[file] = { score: 0, width: 0, height: 0 };
      }
      console.log('----------------------------------------------------');
    } catch (err) {
      console.error(`Error analyzing ${file}:`, err.message);
    }
  }

  Object.keys(fileMap).forEach(key => {
    if (fileMap[key].score < 0.7) {
      fs.unlinkSync(path.join(ALERTS_DIR, key));
      delete fileMap[key];
      console.log(`Deleted ${key}`);
    }
  })

  const checkIfFilesSavedInSameTimeRange = (fileName1, fileName2) => {
    if (!fileName1 || !fileName2) return false;
    const range1 = fileName1.substring(0, fileName1.indexOf('_frame_'));
    const range2 = fileName2.substring(0, fileName2.indexOf('_frame_'));
    if (range1 === range2) {
      const frameNumber1 = parseInt(fileName1.substring(fileName1.indexOf('_frame_') + '_frame_'.length).split('.')[0]);
      const frameNumber2 = parseInt(fileName2.substring(fileName2.indexOf('_frame_') + '_frame_'.length).split('.')[0]);
      return Math.abs(frameNumber1 - frameNumber2) < 20;
    }
    return false;
  }

  let fileNames = Object.keys(fileMap).sort((a, b) => a.localeCompare(b));
  let lastFileName = '';
  for (let i = 0; i < fileNames.length; i++) {
    if (checkIfFilesSavedInSameTimeRange(lastFileName, fileNames[i])) {
      if (fileMap[fileNames[i]].score > fileMap[lastFileName].score) {
        fs.unlinkSync(path.join(ALERTS_DIR, lastFileName));
        delete fileMap[lastFileName];
        console.log(`Deleted ${lastFileName}`);
      } else {
        fs.unlinkSync(path.join(ALERTS_DIR, fileNames[i]));
        delete fileMap[fileNames[i]];
        console.log(`Deleted ${fileNames[i]}`);
        continue;
      }
    }
    lastFileName = fileNames[i];
  }


  const dataToSave = {};
  fileNames = Object.keys(fileMap).sort((a, b) => a.localeCompare(b));
  fileNames.forEach(key => { dataToSave[key] = fileMap[key] });
  fs.writeFileSync('person_detection_scores.json', JSON.stringify(dataToSave, null, 4));
  console.log(`\nFile list saved to person_detection_scores.json`);
}

checkScores();
