const express = require('express');
const cors = require('cors');
const path = require('path');
const onvifService = require('./onvifService');
const streamService = require('./streamService');

const app = express();
const PORT = process.env.PORT || 5001;

// Middleware
app.use(cors());
app.use(express.json());

// Serve generated HLS stream files
streamService.ensureHlsDirectory();
app.use('/hls', express.static(path.join(__dirname, 'public', 'hls'), {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.m3u8')) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
    } else if (filePath.endsWith('.ts')) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.setHeader('Content-Type', 'video/mp2t');
    }
  }
}));

app.get('/',(req,res)=> res.json({ message: 'ONVIF CCTV Backend Server running' }))

// API Routes

/**
 * Health check
 */
app.get('/api/health', (req, res) => {
  res.json({
    status: 'online',
    timestamp: new Date().toISOString(),
    stream: streamService.getStreamStatus(),
  });
});

/**
 * Discover ONVIF devices on local network
 */
app.get('/api/discover', async (req, res) => {
  try {
    const devices = await onvifService.discoverDevices();
    res.json({ success: true, count: devices.length, devices });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * Connect to an ONVIF device
 */
app.post('/api/connect', async (req, res) => {
  try {
    const { xaddr, user, pass } = req.body;
    if (!xaddr) {
      return res.status(400).json({ success: false, error: 'xaddr is required' });
    }

    const deviceInfo = await onvifService.connectDevice({ xaddr, user, pass });
    res.json({ success: true, data: deviceInfo });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * Start streaming RTSP video (transcoding to HLS)
 */
app.post('/api/stream/start', async (req, res) => {
  try {
    const { rtspUrl } = req.body;
    if (!rtspUrl) {
      return res.status(400).json({ success: false, error: 'rtspUrl is required' });
    }

    const streamResult = await streamService.startStream(rtspUrl);
    res.json({ success: true, data: streamResult });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * Stop active video stream
 */
app.post('/api/stream/stop', async (req, res) => {
  try {
    await streamService.stopStream();
    res.json({ success: true, message: 'Stream stopped' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * PTZ Control command (Up, Down, Left, Right, Zoom, Stop)
 */
app.post('/api/ptz/move', async (req, res) => {
  try {
    const { xaddr, user, pass, action, speed } = req.body;
    if (!xaddr || !action) {
      return res.status(400).json({ success: false, error: 'xaddr and action are required' });
    }

    const result = await onvifService.movePTZ({ xaddr, user, pass, action, speed });
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * Proxy live snapshot image from camera
 */
app.get('/api/snapshot', async (req, res) => {
  try {
    const { snapshotUrl, user, pass } = req.query;
    if (!snapshotUrl) {
      return res.status(400).json({ success: false, error: 'snapshotUrl query parameter is required' });
    }

    const { buffer, contentType } = await onvifService.fetchSnapshot({ snapshotUrl, user, pass });
    res.setHeader('Content-Type', contentType);
    res.send(buffer);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Start Server
app.listen(PORT, () => {
  console.log(`=================================`);
  console.log(`ONVIF CCTV Backend Server running on http://localhost:${PORT}`);
  console.log(`HLS Stream path: http://localhost:${PORT}/hls/stream.m3u8`);
  console.log(`=================================`);
});
