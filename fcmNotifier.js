const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const axios = require('axios');
const fs = require('fs');

const USER_TOKEN_FILE = path.join(__dirname, 'userToken.json');
const FCM_ALERT_URL = 'https://streamvilla-fcm.onrender.com/camera-alert';
const FIREBASE_API_KEY = process.env.FIREBASE_API_KEY;
const REFRESH_TOKEN_URL = `https://securetoken.googleapis.com/v1/token?key=${FIREBASE_API_KEY}`;

function loadUserTokens() {
  if (fs.existsSync(USER_TOKEN_FILE)) {
    try {
      const data = fs.readFileSync(USER_TOKEN_FILE, 'utf8');
      return JSON.parse(data);
    } catch (err) {
      console.error('[FCM Notifier] Error reading userToken.json:', err.message);
    }
  }
  return { token: '', refreshToken: '' };
}

function saveUserTokens(tokens) {
  try {
    fs.writeFileSync(USER_TOKEN_FILE, JSON.stringify(tokens, null, 2), 'utf8');
    console.log('[FCM Notifier] Updated userToken.json with new tokens.');
  } catch (err) {
    console.error('[FCM Notifier] Error writing userToken.json:', err.message);
  }
}

async function refreshAccessToken() {
  const tokens = loadUserTokens();
  if (!tokens.refreshToken) {
    throw new Error('No refreshToken found in userToken.json');
  }

  console.log('[FCM Notifier] Refreshing Firebase access token...');
  const response = await axios.post(REFRESH_TOKEN_URL, {
    grant_type: 'refresh_token',
    refresh_token: tokens.refreshToken,
  });

  const { access_token, refresh_token } = response.data;
  tokens.token = access_token;
  if (refresh_token) {
    tokens.refreshToken = refresh_token;
  }
  saveUserTokens(tokens);
  return tokens.token;
}

async function sendCameraAlertNotification(fileName) {
  let tokens = loadUserTokens();

  if (!tokens.token && tokens.refreshToken) {
    try {
      tokens.token = await refreshAccessToken();
    } catch (err) {
      console.error('[FCM Notifier] Initial token refresh failed:', err.message);
    }
  }

  const postAlert = async (bearerToken) => {
    return await axios.post(
      FCM_ALERT_URL,
      { fileName },
      {
        headers: {
          Authorization: `Bearer ${bearerToken}`,
          'Content-Type': 'application/json',
        },
      }
    );
  };

  try {
    console.log(`[FCM Notifier] Sending camera-alert for ${fileName}...`);
    await postAlert(tokens.token);
    console.log(`[FCM Notifier] Camera alert successfully sent for ${fileName}`);
  } catch (err) {
    if (err.response && err.response.status === 401) {
      console.warn('[FCM Notifier] 401 Unauthorized received. Refreshing token and retrying...');
      try {
        const newToken = await refreshAccessToken();
        await postAlert(newToken);
        console.log(`[FCM Notifier] Camera alert successfully sent after token refresh for ${fileName}`);
      } catch (refreshErr) {
        console.error('[FCM Notifier] Retry after token refresh failed:', refreshErr.response?.data || refreshErr.message);
        throw refreshErr;
      }
    } else {
      console.error('[FCM Notifier] Failed to send camera alert:', err.response?.data || err.message);
      throw err;
    }
  }
}

module.exports = {
  sendCameraAlertNotification,
  refreshAccessToken,
  loadUserTokens,
};
