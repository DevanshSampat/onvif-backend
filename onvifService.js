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
 * Build a clean TCP-compatible RTSP stream URL from the ONVIF device profiles.
 * Injects credentials into the URL so FFmpeg can authenticate.
 */
function getRtspStreamUrlFromDevice(device, user, pass) {
  const profiles = device.getProfileList();
  if (!profiles || profiles.length === 0) {
    throw new Error('No profiles available on device');
  }

  // Use the first profile's stream URI (highest quality, usually channel 0 / main stream)
  const profile = profiles[0];

  // Try accessing the stream URI from profile structure
  let rtspUrl = null;
  if (profile && profile.stream && profile.stream.rtsp) {
    rtspUrl = profile.stream.rtsp;
  } else if (profile && profile.StreamUri) {
    rtspUrl = profile.StreamUri;
  } else {
    // Fallback: use getUdpStreamUrl and clean it
    rtspUrl = device.getUdpStreamUrl();
  }

  if (!rtspUrl || !rtspUrl.startsWith('rtsp://')) {
    throw new Error(`Invalid RTSP URL obtained: ${rtspUrl}`);
  }

  // Inject credentials if provided and not already embedded
  if (user && pass && !rtspUrl.includes('@')) {
    const encodedUser = encodeURIComponent(user);
    const encodedPass = encodeURIComponent(pass);
    rtspUrl = rtspUrl.replace('rtsp://', `rtsp://${encodedUser}:${encodedPass}@`);
  }

  return rtspUrl;
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
  
  // Build a clean TCP-compatible RTSP URL from the device's profile
  // Prefer getRtspStreamUrl() which strips UDP-specific hints;
  // fall back to getUdpStreamUrl() and then strip the transport param.
  let streamUrl = '';
  try {
    streamUrl = getRtspStreamUrlFromDevice(device, user, pass);
    console.log('[ONVIF] Resolved RTSP stream URL (TCP-compatible).');
  } catch (e) {
    console.log('[ONVIF] Failed to build RTSP URL from profiles, falling back to UDP URL:', e.message);
    try {
      streamUrl = device.getUdpStreamUrl();
    } catch (e2) {
      console.log('[ONVIF] getUdpStreamUrl also failed:', e2.message);
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
 * Re-fetch a fresh RTSP stream URL from the already-connected ONVIF device.
 * Always injects credentials into the URL so FFmpeg can authenticate.
 */
async function getFreshStreamUrl({ xaddr, user = '', pass = '' }) {
  const deviceKey = `${xaddr}-${user}`;
  let device = connectedDevices.get(deviceKey);

  if (!device) {
    device = new onvif.OnvifDevice({ xaddr, user, pass });
    await device.init();
    connectedDevices.set(deviceKey, device);
  }

  let streamUrl = '';
  try {
    streamUrl = getRtspStreamUrlFromDevice(device, user, pass);
    console.log('[ONVIF] Fresh RTSP stream URL obtained (with credentials).');
  } catch (e) {
    // Fallback: get raw URL and inject credentials manually
    try {
      streamUrl = device.getUdpStreamUrl();
    } catch (e2) {
      throw new Error('Could not resolve stream URL from device: ' + e2.message);
    }
    // Inject credentials if not already present
    if (streamUrl && user && pass && !streamUrl.includes('@')) {
      const encodedUser = encodeURIComponent(user);
      const encodedPass = encodeURIComponent(pass);
      streamUrl = streamUrl.replace('rtsp://', `rtsp://${encodedUser}:${encodedPass}@`);
      console.log('[ONVIF] Injected credentials into fallback stream URL.');
    }
  }

  if (!streamUrl) {
    throw new Error('No stream URL could be resolved from the ONVIF device.');
  }

  return streamUrl;
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
  getFreshStreamUrl,
  movePTZ,
  fetchSnapshot,
};
