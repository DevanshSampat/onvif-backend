const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

// Read credentials if available
let rtspUrl = process.argv[2];

if (!rtspUrl) {
  try {
    const credsPath = path.join(__dirname, 'credentials.json');
    if (fs.existsSync(credsPath)) {
      const creds = JSON.parse(fs.readFileSync(credsPath, 'utf8'));
      // Default to mainstream channel0; can be overridden via command line arg
      rtspUrl = `rtsp://${encodeURIComponent(creds.user)}:${encodeURIComponent(creds.pass)}@192.168.29.102:5543/6555b24083f3b61b028c2778330b5726/live/channel0`;
    }
  } catch (e) { }
}

if (!rtspUrl) {
  console.error('Usage: node monitor_udp_loss.js <rtsp_url>');
  process.exit(1);
}

// Mask password in console output
const safeUrl = rtspUrl.replace(/:([^@:]+)@/, ':****@');
console.log('====================================================');
console.log('       RTSP UDP Packet Loss & Jitter Monitor        ');
console.log('====================================================');
console.log(`Connecting to: ${safeUrl}`);
console.log('Monitoring RTP/UDP sequence numbers in real-time...\n');

// Spawn ffmpeg with debug log level to expose RTP packet sequence numbers and drops
const ffmpegArgs = [
  '-rtsp_transport', 'udp',
  '-loglevel', 'debug',
  '-buffer_size', '10485760',
  '-max_delay', '1000000',
  '-reorder_queue_size', '1000',
  '-analyzeduration', '2000000',
  '-probesize', '2000000',
  '-i', rtspUrl,
  '-f', 'null',
  '-'
];


const child = spawn('ffmpeg', ffmpegArgs, { stdio: ['ignore', 'pipe', 'pipe'] });

let totalRtpPackets = 0;
let lostPacketsCount = 0;
let corruptMacroblockEvents = 0;
let lastSeq = null;
let startTime = Date.now();
let lastPrintTime = Date.now();

// Print real-time dashboard every 2 seconds
const statsInterval = setInterval(() => {
  const elapsedSec = ((Date.now() - startTime) / 1000).toFixed(1);
  const lossRate = totalRtpPackets > 0
    ? ((lostPacketsCount / (totalRtpPackets + lostPacketsCount)) * 100).toFixed(2)
    : '0.00';

  process.stdout.write(
    `\r[${elapsedSec}s] Packets Recv: ${totalRtpPackets} | Packets Lost: ${lostPacketsCount} (${lossRate}%) | Corrupt Slices: ${corruptMacroblockEvents}   `
  );
}, 2000);

let stderrBuffer = '';

child.stderr.on('data', (chunk) => {
  stderrBuffer += chunk.toString();
  const lines = stderrBuffer.split('\n');
  stderrBuffer = lines.pop(); // Keep partial line

  for (const line of lines) {
    // 1. Detect RTP packet arrivals and sequence numbers
    const seqMatch = line.match(/seq:\s*(\d+)/i) || line.match(/seq=(\d+)/i);
    if (seqMatch) {
      const seq = parseInt(seqMatch[1], 10);
      totalRtpPackets++;

      if (lastSeq !== null) {
        // RTP sequence numbers are 16-bit unsigned (0 to 65535)
        const expectedSeq = (lastSeq + 1) & 0xFFFF;
        if (seq !== expectedSeq) {
          let diff = (seq - expectedSeq) & 0xFFFF;
          if (diff > 0 && diff < 3000) { // Reasonable loss gap
            lostPacketsCount += diff;
            const timestamp = new Date().toLocaleTimeString();
            console.log(
              `\n[${timestamp}] ⚠️ PACKET LOSS: Dropped ${diff} packet(s)! Expected seq #${expectedSeq}, got seq #${seq}`
            );
          }
        }
      }
      lastSeq = seq;
    } else if (line.includes('RTP: PT=') || line.includes('RTP packet') || line.includes('nal_unit_type')) {
      totalRtpPackets++;
    }

    // 2. FFmpeg explicit loss / drop log lines
    if (line.includes('RTP: missed') || line.includes('packets lost') || line.includes('missed packets')) {
      const match = line.match(/(\d+)\s+packets?\s+lost/i) || line.match(/missed\s+(\d+)/i);
      const lost = match ? parseInt(match[1], 10) : 1;
      lostPacketsCount += lost;
      console.log(`\n[${new Date().toLocaleTimeString()}] ⚠️ RTP STREAM LOSS: ${line.trim()}`);
    }

    // 3. Detect H.264 macroblock / slice corruption caused by lost packets
    if (
      line.includes('concealing') ||
      line.includes('corrupt decoded frame') ||
      line.includes('error while decoding MB') ||
      line.includes('out of range') ||
      line.includes('missing picture in access unit')
    ) {
      corruptMacroblockEvents++;
      console.log(`\n[${new Date().toLocaleTimeString()}] 💥 DECODER GLITCH: ${line.trim()}`);
    }
  }
});

child.on('close', (code) => {
  clearInterval(statsInterval);
  const total = totalRtpPackets + lostPacketsCount;
  const rate = total > 0 ? ((lostPacketsCount / total) * 100).toFixed(2) : 0;
  console.log('\n\n====================================================');
  console.log('                  FINAL SUMMARY                     ');
  console.log('====================================================');
  console.log(`Total Received Packets: ${totalRtpPackets}`);
  console.log(`Total Dropped Packets:  ${lostPacketsCount}`);
  console.log(`Packet Loss Rate:       ${rate}%`);
  console.log(`Corrupted Frame Events: ${corruptMacroblockEvents}`);
  console.log(`Exited with code:       ${code}`);
});

process.on('SIGINT', () => {
  console.log('\nStopping monitor...');
  child.kill('SIGINT');
});
