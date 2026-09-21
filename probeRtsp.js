/**
 * Probe script: find a working direct RTSP URL for the CP-E45Q camera.
 * Run: node probeRtsp.js
 */
const { execFile } = require('child_process');
const credentials = require('./credentials.json');

const host = new URL(credentials.xaddr).hostname;
const user = credentials.user;
const pass = credentials.pass;

const candidates = [
  `rtsp://${user}:${pass}@${host}:554/`,
  `rtsp://${user}:${pass}@${host}:554/live`,
  `rtsp://${user}:${pass}@${host}:554/livestream/1`,
  `rtsp://${user}:${pass}@${host}:554/h264`,
  `rtsp://${user}:${pass}@${host}:554/stream1`,
  `rtsp://${user}:${pass}@${host}:554/cam/realmonitor?channel=1&subtype=0`,
  `rtsp://${user}:${pass}@${host}:554/channel0`,
  `rtsp://${user}:${pass}@${host}:8554/`,
  `rtsp://${user}:${pass}@${host}:8554/live`,
  `rtsp://${user}:${pass}@${host}:5543/`,
  `rtsp://${user}:${pass}@${host}:5543/live`,
  `rtsp://${user}:${pass}@${host}:5543/channel0`,
  `rtsp://${user}:${pass}@${host}:5543/live/channel0`,
];

console.log(`Probing camera at ${host}...\n`);

async function probe(url) {
  return new Promise((resolve) => {
    const displayUrl = url.replace(/:([^:@]+)@/, ':****@');
    process.stdout.write(`Testing: ${displayUrl} ... `);
    const args = [
      '-rtsp_transport', 'tcp',
      '-analyzeduration', '1000000',
      '-probesize', '500000',
      '-i', url,
      '-t', '3',
      '-c', 'copy',
      '-f', 'null', '-'
    ];
    execFile('ffmpeg', args, { timeout: 10000 }, (err, stdout, stderr) => {
      if (!err || (stderr && stderr.includes('Video:'))) {
        console.log('WORKS');
        resolve({ url, works: true });
      } else {
        const reason = stderr.includes('Connection refused') ? 'Connection refused'
          : stderr.includes('401') ? 'Auth failed'
          : stderr.includes('404') ? 'Not found'
          : stderr.includes('timed out') || stderr.includes('Operation timed out') ? 'Timed out'
          : 'Failed';
        console.log(reason);
        resolve({ url, works: false });
      }
    });
  });
}

(async () => {
  for (const url of candidates) {
    const result = await probe(url);
    if (result.works) {
      console.log('\nWorking URL:', result.url);
      break;
    }
  }
})();
