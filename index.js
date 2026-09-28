const express = require('express');
const cors = require('cors');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

app.disable('x-powered-by');
app.use(cors({ origin: '*' }));

let FFMPEG = null;
try { FFMPEG = require('ffmpeg-static'); } catch (e) { console.log('ffmpeg-static load fail:', e.message); }

let YTDLP = path.join(__dirname, 'node_modules', '@distube', 'yt-dlp', 'bin', process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp');
if (!fs.existsSync(YTDLP)) YTDLP = 'yt-dlp';
try {
  const y = require('@distube/yt-dlp');
  if (y && y.executablePath) YTDLP = y.executablePath;
} catch (e) {
  console.log('yt-dlp pack check:', e.message);
}
console.log('FFMPEG:', FFMPEG);
console.log('YTDLP :', YTDLP);

function run(cmd, args, cwd, timeoutMs) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { cwd });
    let err = '';
    p.stderr.on('data', d => { err += d; });
    const timer = setTimeout(() => {
      try { p.kill('SIGKILL'); } catch (_) {}
      reject(new Error('timeout after ' + timeoutMs + 'ms'));
    }, timeoutMs);
    p.on('exit', code => {
      clearTimeout(timer);
      code === 0 ? resolve() : reject(new Error('exit ' + code + ': ' + err.slice(-600)));
    });
    p.on('error', err2 => {
      clearTimeout(timer);
      reject(new Error('spawn fail: ' + err2.message));
    });
  });
}

function cleanup(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
}

function safeName(s) {
  return (s || 'audyo').replace(/[^\w\s-]/g, '').trim().slice(0, 80) || 'audyo';
}

app.get('/api/health', (req, res) => {
  res.json({ ok: true, ffmpeg: !!FFMPEG, ytdlp: YTDLP, ts: Date.now() });
});

app.get('/api/tiktok', async (req, res) => {
  const url = (req.query.url || '').trim();
  if (!url || !url.includes('tiktok')) {
    return res.status(400).json({ code: -1, msg: 'Pending URL TikTok!' });
  }
  try {
    const r = await fetch('https://www.tikwm.com/api/?url=' + encodeURIComponent(url));
    const j = await r.json();
    res.json(j);
  } catch (e) {
    res.status(502).json({ code: -1, msg: 'TikWM proxy gagal: ' + e.message });
  }
});

app.get('/api/dl', async (req, res) => {
  const q = (req.query.q || '').trim();
  const type = req.query.type === 'mp4' ? 'mp4' : 'mp3';
  if (!q) {
    return res.status(400).json({ error: 'q param kosong' });
  }
  if (!FFMPEG) {
    return res.status(500).json({ error: 'ffmpeg tidak install — buka health' });
  }
  const id = 'grg-' + crypto.randomBytes(4).toString('hex');
  const dir = path.join(os.tmpdir(), id);
  fs.mkdirSync(dir, { recursive: true });
  const outBase = path.join(dir, 'out');
  const search = 'ytsearch1:' + q;
  const seq = ['-f', 'bestaudio', '-x', '--audio-format', 'mp3',
    '--ffmpeg-location', FFMPEG, '-o', outBase + '.%(ext)s', '--no-playlist', search];
  if (type === 'mp4') {
    seq.length = 0;
    seq.push('-f', 'b[height<=1080]/b', '--merge-output-format', 'mp4',
      '--ffmpeg-location', FFMPEG, '-o', outBase + '.%(ext)s', '--no-playlist', search);
  }
  const t0 = Date.now();
  try {
    await run(YTDLP, seq, dir, type === 'mp3' ? 240000 : 600000);
  } catch (e) {
    cleanup(dir);
    return res.status(502).json({ error: 'yt-dlp gagal: ' + e.message });
  }
  let file = null;
  try {
    const cands = fs.readdirSync(dir).filter(f => !f.endsWith('.part'));
    let best = null;
    for (const c of cands) {
      const full = path.join(dir, c);
      const st = fs.statSync(full);
      if (st.isFile() && (!best || st.size > best.size)) best = { full, size: st.size };
    }
    if (best) file = best;
  } catch (_) {}
  if (!file) {
    cleanup(dir);
    return res.status(502).json({ error: 'File hasil tidak ditemu' });
  }
  res.setHeader('Content-Type', type === 'mp3' ? 'audio/mpeg' : 'video/mp4');
  res.setHeader('Content-Disposition', 'attachment; filename="' + safeName(q) + '.' + type + '"');
  res.setHeader('X-DL-Ms', String(Date.now() - t0));
  const CHUNK = 1 << 20;
  const st = fs.createReadStream(file.full, { chunkSize: CHUNK });
  st.on('error', () => { try { res.end(); } catch (_) {} });
  res.on('close', () => {
    try { st.close(); } catch (_) {}
    cleanup(dir);
  });
  st.pipe(res);
});

app.listen(PORT, () => console.log('API gilangranggaid active :' + PORT));