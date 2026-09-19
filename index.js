const express = require('express');
const cors = require('cors');
const path = require('path');
const onvifService = require('./onvifService');
const streamService = require('./streamService');
const recordingService = require('./recordingService');
const fs = require('fs');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 5001;

// Middleware
app.use(cors());
app.use(express.json());

// Reset HLS stream directory & process any existing temp recording batches before start
streamService.resetHlsDirectory();
recordingService.processExistingTempBatches();
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

app.get('/', (req, res) => res.json({ message: 'ONVIF CCTV Backend Server running' }));

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
    fs.writeFileSync("credentials.json", JSON.stringify({
      xaddr,
      user,
      pass
    }, null, 4));
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * Start streaming RTSP video (transcoding to HLS + 10-min interval recording)
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
 * Stop active video stream & recording loop
 */
app.post('/api/stream/stop', async (req, res) => {
  try {
    await streamService.stopStream();
    res.json({ success: true, message: 'Stream and recording stopped' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * List all downloadable MP4 stream recordings (kept for 24h)
 */
app.get('/api/recordings', (req, res) => {
  try {
    const recordings = recordingService.getRecordingsList();
    res.json({ success: true, count: recordings.length, recordings });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * Download a specific recording MP4 file using query parameter ?id=filename (or /download/:filename for fallback)
 */
app.get('/api/recordings/download', (req, res) => {
  const filenameParam = req.query.id || req.query.filename;
  if (!filenameParam) {
    return res.status(400).json({ success: false, error: 'id query parameter is required' });
  }
  const filename = path.basename(filenameParam);
  const filePath = path.join(recordingService.RECORDINGS_DIR, filename);

  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ success: false, error: 'Recording file not found or expired' });
  }

  res.download(filePath, filename);
});

app.get('/api/recordings/download/:filename', (req, res) => {
  const filename = path.basename(req.params.filename);
  const filePath = path.join(recordingService.RECORDINGS_DIR, filename);

  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ success: false, error: 'Recording file not found or expired' });
  }

  res.download(filePath, filename);
});

/**
 * Play/stream a specific recording MP4 file in browser video player via /api/recordings/stream
 */
const handleStreamRecording = (req, res) => {
  const filenameParam = req.params.filename || req.query.id || req.query.filename;
  if (!filenameParam) {
    return res.status(400).json({ success: false, error: 'id query parameter or filename path is required' });
  }
  const filename = path.basename(filenameParam);
  const filePath = path.join(recordingService.RECORDINGS_DIR, filename);

  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ success: false, error: 'Recording file not found' });
  }

  res.sendFile(filePath);
};

app.get('/api/recordings/stream/:filename', handleStreamRecording);
app.get('/api/recordings/stream', handleStreamRecording);

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

  if (fs.existsSync("credentials.json")) {
    const credentials = JSON.parse(fs.readFileSync("credentials.json"));
    axios.post(`http://localhost:${PORT}/api/connect`, credentials)
      .then((response) => {
        axios.post(`http://localhost:${PORT}/api/stream/start`, { rtspUrl: response.data.data.streamUrl });
      })
      .catch((err) => {
        console.error("Auto-connect failed:", err.message);
      });
  }
});
