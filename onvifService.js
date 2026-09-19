const onvif = require('node-onvif');
const http = require('http');
const https = require('https');
const url = require('url');

// Store active camera connections in memory
const connectedDevices = new Map();

/**
 * Discover ONVIF devices on the local network via WS-Discovery
 */
async function discoverDevices(timeout = 3000) {
  try {
    const devices = await onvif.startProbe();
    return devices.map((d) => ({
      urn: d.urn,
      name: d.name || 'ONVIF Camera',
      xaddr: d.xaddrs ? d.xaddrs[0] : '',
      xaddrs: d.xaddrs || [],
      scopes: d.scopes || [],
    }));
  } catch (error) {
    console.error('ONVIF Discovery Error:', error.message);
    return [];
  }
}

/**
 * Connect and authenticate with an ONVIF device
 */
async function connectDevice({ xaddr, user = '', pass = '' }) {
  if (!xaddr) {
    throw new Error('Device xaddr (URL) is required');
  }

  const deviceKey = `${xaddr}-${user}`;
  let device = connectedDevices.get(deviceKey);

  if (!device) {
    device = new onvif.OnvifDevice({
      xaddr: xaddr,
      user: user,
      pass: pass,
    });

    await device.init();
    connectedDevices.set(deviceKey, device);
  }

  // Extract info & profile details
  const information = device.getInformation();
  const profiles = device.getProfileList();
  
  // Get RTSP Stream URI
  let streamUrl = '';
  try {
    streamUrl = device.getUdpStreamUrl();
  } catch (e) {
    console.log('Failed to get UDP stream url, fallback to profile:', e.message);
  }

  if (!streamUrl && profiles && profiles.length > 0) {
    try {
      streamUrl = await device.getStreamUrl();
    } catch (e) {
      console.log('Failed to get general stream url:', e.message);
    }
  }

  // Get Snapshot URI
  let snapshotUrl = '';
  try {
    snapshotUrl = device.getSnapshotUrl();
  } catch (e) {
    // Snapshot URL might not be present in all profiles
  }

  return {
    xaddr,
    information,
    profiles: profiles.map((p) => ({
      name: p.name,
      token: p.token,
      video: p.video,
      audio: p.audio,
    })),
    streamUrl,
    snapshotUrl,
  };
}

/**
 * Execute PTZ commands (Pan, Tilt, Zoom)
 */
async function movePTZ({ xaddr, user = '', pass = '', action, speed = 0.5 }) {
  const deviceKey = `${xaddr}-${user}`;
  let device = connectedDevices.get(deviceKey);

  if (!device) {
    device = new onvif.OnvifDevice({
      xaddr: xaddr,
      user: user,
      pass: pass,
    });
    await device.init();
    connectedDevices.set(deviceKey, device);
  }

  const speedVal = parseFloat(speed) || 0.5;

  let velocity = { x: 0, y: 0, z: 0 };

  switch (action) {
    case 'up':
      velocity.y = speedVal;
      break;
    case 'down':
      velocity.y = -speedVal;
      break;
    case 'left':
      velocity.x = -speedVal;
      break;
    case 'right':
      velocity.x = speedVal;
      break;
    case 'up-left':
      velocity.x = -speedVal;
      velocity.y = speedVal;
      break;
    case 'up-right':
      velocity.x = speedVal;
      velocity.y = speedVal;
      break;
    case 'down-left':
      velocity.x = -speedVal;
      velocity.y = -speedVal;
      break;
    case 'down-right':
      velocity.x = speedVal;
      velocity.y = -speedVal;
      break;
    case 'zoom-in':
      velocity.z = speedVal;
      break;
    case 'zoom-out':
      velocity.z = -speedVal;
      break;
    case 'stop':
      return await device.ptzStop();
    default:
      throw new Error(`Unsupported PTZ action: ${action}`);
  }

  return await device.ptzMove({
    speed: velocity,
    timeout: 1, // Auto stop after 1 second if no stop call sent
  });
}

/**
 * Fetch snapshot image from camera
 */
async function fetchSnapshot({ snapshotUrl, user = '', pass = '' }) {
  if (!snapshotUrl) {
    throw new Error('Snapshot URL not available');
  }

  // Insert credentials into snapshot URL if provided
  let targetUrl = snapshotUrl;
  if (user && pass && targetUrl.startsWith('http')) {
    const parsed = new url.URL(targetUrl);
    parsed.username = user;
    parsed.password = pass;
    targetUrl = parsed.toString();
  }

  return new Promise((resolve, reject) => {
    const client = targetUrl.startsWith('https') ? https : http;
    client
      .get(targetUrl, (res) => {
        if (res.statusCode !== 200) {
          return reject(new Error(`Snapshot fetch failed with status ${res.statusCode}`));
        }

        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const buffer = Buffer.concat(chunks);
          const contentType = res.headers['content-type'] || 'image/jpeg';
          resolve({ buffer, contentType });
        });
      })
      .on('error', (err) => reject(err));
  });
}

module.exports = {
  discoverDevices,
  connectDevice,
  movePTZ,
  fetchSnapshot,
};
