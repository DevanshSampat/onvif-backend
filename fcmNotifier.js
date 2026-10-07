const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const axios = require('axios');
const fs = require('fs');

const ALERT_URL = 'http://localhost:9090/camera-alert';
const RESUME_URL = 'http://localhost:9090/camera-alert/resume-tv';

async function sendResumeTVPlaybackNotification() {
  try {
    console.log(`[FCM Notifier] Sending resume TV playback notification`);
    await axios.get(RESUME_URL, { timeout: 10000 });
    console.log(`[FCM Notifier] Resume TV playback notification successfully sent`);
  } catch (err) {
    console.error('[FCM Notifier] Failed to send resume TV playback notification:', err.response?.data || err.message);
    throw err;
  }
}

async function sendCameraAlertNotification(fileName) {
  try {
    let deviceName = 'Camera';
    if (fs.existsSync('credentials.json')) {
      try {
        const credentials = JSON.parse(fs.readFileSync('credentials.json', 'utf8'));
        deviceName = credentials.device || credentials.deviceName || 'Camera';
      } catch (e) {}
    }
    console.log(`[FCM Notifier] Sending camera-alert for ${fileName} (device: ${deviceName})...`);
    await axios.post(ALERT_URL, { fileName, deviceName }, { timeout: 10000 });
    console.log(`[FCM Notifier] Camera alert successfully sent for ${fileName}`);
  } catch (err) {
    console.error('[FCM Notifier] Failed to send camera alert:', err.response?.data || err.message);
    throw err;
  }
}

module.exports = {
  sendCameraAlertNotification,
  sendResumeTVPlaybackNotification,
};
