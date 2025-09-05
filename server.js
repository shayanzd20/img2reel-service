// server.js (ESM)
import express from 'express';
import multer from 'multer';
import { v4 as uuidv4 } from 'uuid';
import path from 'path';
import fs, { createWriteStream } from 'fs';
import ffmpeg from 'fluent-ffmpeg';
import { pipeline } from 'stream/promises';
import axios from 'axios';

import {
  MAX_IMAGE_BYTES,
  DOWNLOAD_TIMEOUT_MS,
  MAX_REDIRECTS,
  VIDEO_CODEC,
  VIDEO_CRF,
  VIDEO_PRESET,
  VIDEO_MAXRATE_KBPS,
  VIDEO_BUFSIZE_KBPS,
  VIDEO_KEYINT,
  AUDIO_BR_KBPS,
  DEFAULT_WIDTH,
  DEFAULT_HEIGHT,
  PORT,
  VIDEO_DIR,
} from './config.js';

const app = express();
const upload = multer({ dest: '/tmp' });
const fsp = fs.promises;

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// Ensure persistent dir exists
if (!fs.existsSync(VIDEO_DIR)) fs.mkdirSync(VIDEO_DIR, { recursive: true });

// Serve generated files statically under /videos
app.use('/videos', express.static(VIDEO_DIR, {
  setHeaders: (res) => res.setHeader('Content-Type', 'video/mp4'),
}));

app.get('/health', (_, res) => res.json({ ok: true, memoryUsage: process.memoryUsage() }));

// ---------- Helpers ----------
const ALLOWED_CONTENT_TYPES = new Set(['image/jpeg', 'image/jpg', 'image/png']);
const ALLOWED_EXTS = new Set(['.jpg', '.jpeg', '.png']);

function pickExtFromCT(ct) {
  if (!ct) return null;
  const c = ct.toLowerCase();
  if (c.includes('jpeg') || c.includes('jpg')) return '.jpg';
  if (c.includes('png')) return '.png';
  return null;
}

function pickExtFromURL(url) {
  try {
    const ext = path.extname(new URL(url).pathname).toLowerCase();
    return ALLOWED_EXTS.has(ext) ? ext : null;
  } catch {
    return null;
  }
}

function absoluteUrl(req, relativePath) {
  const proto = req.headers['x-forwarded-proto'] || req.protocol;
  const host = req.headers['x-forwarded-host'] || req.get('host');
  return `${proto}://${host}${relativePath}`;
}

async function clearVideoDir() {
  try {
    await fsp.mkdir(VIDEO_DIR, { recursive: true });
    const entries = await fsp.readdir(VIDEO_DIR, { withFileTypes: true });
    const deletions = entries
      .filter((d) => d.isFile() && d.name.toLowerCase().endsWith('.mp4'))
      .map((d) => fsp.unlink(path.join(VIDEO_DIR, d.name)).catch(() => { }));
    await Promise.all(deletions);
  } catch (err) {
    console.error('clearVideoDir failed:', err);
  }
}

function parseParams(q) {
  return {
    duration: Math.min(Math.max(parseInt(q.duration || '20', 10), 1), 90),
    fps: Math.min(Math.max(parseInt(q.fps || '30', 10), 1), 60),
    width: parseInt(q.width || DEFAULT_WIDTH, 10),
    height: parseInt(q.height || DEFAULT_HEIGHT, 10),
  };
}

// ---------- Downloaders ----------
async function downloadPngOrJpgStream(url) {

  const controller = new AbortController();
  const signal = controller.signal;
  let res;
  try {
    res = await axios.get(url, {
      responseType: 'stream',
      maxRedirects: MAX_REDIRECTS,
      timeout: DOWNLOAD_TIMEOUT_MS,
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        Accept: 'image/jpeg,image/png,image/*;q=0.8',
      },
      signal,
      maxBodyLength: Infinity,
      transitional: { clarifyTimeoutError: true },
      validateStatus: (s) => s >= 200 && s < 400,
    });
  } catch (error) {
    throw new Error(`Failed to fetch the image: ${error.message || String(error)}`);
  }

  const headers = res.headers || {};
  const rawCT = String(headers['content-type'] || '').toLowerCase();
  const contentType = rawCT.split(';')[0].trim();

  if (!ALLOWED_CONTENT_TYPES.has(contentType)) {
    const byExtOnly = pickExtFromURL(url);
    if (!byExtOnly) {
      if (res.data?.destroy) res.data.destroy();
      throw new Error(`Only PNG or JPG URLs are allowed (got content-type="${rawCT || 'unknown'}").`);
    }
  }

  const byCT = pickExtFromCT(rawCT);
  const byExt = pickExtFromURL(url);
  const ext = byCT || byExt;
  if (!ext) {
    if (res.data?.destroy) res.data.destroy();
    throw new Error('Only PNG or JPG URLs are allowed.');
  }

  const contentLengthHeader = headers['content-length'];
  const contentLength = contentLengthHeader ? parseInt(String(contentLengthHeader), 10) : NaN;
  if (Number.isFinite(contentLength) && contentLength > MAX_IMAGE_BYTES) {
    if (res.data?.destroy) res.data.destroy();
    throw new Error(`Image too large: ${contentLength} bytes (limit ${MAX_IMAGE_BYTES}).`);
  }

  const filePath = path.join('/tmp', `${uuidv4()}${ext}`);
  const out = createWriteStream(filePath, { flags: 'wx' });

  let downloaded = 0;
  const source = res.data;
  source.on('data', (chunk) => {
    downloaded += chunk.length;
    if (downloaded > MAX_IMAGE_BYTES) {
      controller.abort();
      source.destroy(new Error(`Image exceeds max size of ${MAX_IMAGE_BYTES} bytes.`));
    }
  });

  try {
    await pipeline(source, out);
    return filePath;
  } catch (err) {
    try { await fsp.unlink(filePath); } catch { }
    throw new Error(`Error downloading image: ${err?.message || String(err)}`);
  }
}

async function downloadPngOrJpgByBuffer(url) {
  try {
    const res = await axios.get(url, {
      responseType: 'arraybuffer',
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
        Accept: 'image/jpeg,image/png,image/*,*/*;q=0.8',
      },
      timeout: DOWNLOAD_TIMEOUT_MS,
      maxRedirects: MAX_REDIRECTS,
      validateStatus: (s) => s >= 200 && s < 300,
    });

    const ct = String(res.headers['content-type'] || '').toLowerCase();
    const byCT = pickExtFromCT(ct);
    const byExt = pickExtFromURL(url);
    const ext = byCT || byExt;

    if (!ext || (byCT && !ALLOWED_CONTENT_TYPES.has(ct))) {
      throw new Error(`Only PNG or JPG URLs are allowed (got content-type="${ct || 'unknown'}").`);
    }

    if (res.data?.byteLength && res.data.byteLength > MAX_IMAGE_BYTES) {
      throw new Error(`Image too large: ${res.data.byteLength} bytes (limit ${MAX_IMAGE_BYTES}).`);
    }

    const filePath = path.join('/tmp', `${uuidv4()}${ext}`);
    fs.writeFileSync(filePath, Buffer.from(res.data));
    return filePath;
  } catch (error) {
    console.error(`Error downloading image: ${error.message || error}`);
    throw error;
  }
}

// ---------- Encoders ----------
function imageToVideo(inPath, { duration, fps, width, height }) {
  const id = uuidv4();
  const filename = `reel-${id}.mp4`;
  const outPath = path.join(VIDEO_DIR, filename);

  const vf = [
    `scale=${width}:${height}:force_original_aspect_ratio=decrease`,
    `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black`,
    `fps=${fps}`,
  ].join(',');

  return new Promise((resolve, reject) => {
    try {
      const cmd = ffmpeg()
        .addInput(inPath).inputOptions(['-loop 1'])
        .videoFilters(vf)
        .fps(fps)
        .videoCodec('libx264')
        .outputOptions([
          `-t ${duration}`,
          '-pix_fmt yuv420p',
          '-movflags +faststart',
          '-shortest',
        ])
        .addInput('anullsrc=channel_layout=stereo:sample_rate=44100')
        .inputOptions(['-f lavfi'])
        .audioCodec('aac').audioBitrate('128k')
        .save(outPath);

      cmd.on('end', () => resolve({ id, filename, outPath }));
      cmd.on('error', reject);
    } catch (error) {
      reject('Error starting ffmpeg: ' + error);
    }
  });
}

async function imageToVideoCompressedWithIntro(mainImagePath, opts, introImagePath = null, introDuration = 0) {
  const id = uuidv4();
  const filename = `reel-${id}.mp4`;
  const finalOut = path.join(VIDEO_DIR, filename);

  const tmpIntro = introImagePath ? path.join('/tmp', `intro-${uuidv4()}.mp4`) : null;
  const tmpMain = path.join('/tmp', `main-${uuidv4()}.mp4`);

  // 1) build main clip using existing function logic (but write to tmpMain)
  await new Promise((resolve, reject) => {
    const { duration, fps, width, height } = opts;
    const vf = [
      `scale=${width}:${height}:force_original_aspect_ratio=decrease`,
      `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black`,
      `fps=${fps}`,
    ].join(',');

    const codec = VIDEO_CODEC;
    const vOpts = [
      `-t ${duration}`,
      '-pix_fmt yuv420p',
      '-movflags +faststart',
      `-crf ${VIDEO_CRF}`,
      `-preset ${VIDEO_PRESET}`,
      '-tune stillimage',
      `-g ${VIDEO_KEYINT}`,
      `-keyint_min ${VIDEO_KEYINT}`,
      `-maxrate ${VIDEO_MAXRATE_KBPS}k`,
      `-bufsize ${VIDEO_BUFSIZE_KBPS}k`,
      '-shortest',
      '-threads 1',
    ];
    if (codec === 'libx265') vOpts.push('-tag:v hvc1');

    ffmpeg()
      .input(mainImagePath).inputOptions(['-loop 1'])
      .input('anullsrc=channel_layout=mono:sample_rate=44100')
      .inputFormat('lavfi')
      .videoFilters(vf)
      .fps(opts.fps)
      .videoCodec(codec)
      .outputOptions(vOpts)
      .audioCodec('aac')
      .audioChannels(1)
      .audioBitrate(`${AUDIO_BR_KBPS}k`)
      .on('end', resolve)
      .on('error', reject)
      .save(tmpMain);
  });

  // 2) if intro requested, build intro clip
  if (introImagePath && introDuration > 0) {
    await makeStillClip(introImagePath, tmpIntro, {
      duration: introDuration,
      fps: opts.fps,
      width: opts.width,
      height: opts.height,
    });

    // 3) concat intro + main into finalOut
    await concatMp4s([tmpIntro, tmpMain], finalOut);
    try { await fsp.unlink(tmpIntro); } catch { }
  } else {
    // no intro: just move main => finalOut
    await fsp.copyFile(tmpMain, finalOut);
  }

  try { await fsp.unlink(tmpMain); } catch { }
  return { id, filename, outPath: finalOut };
}

function imageToVideoCompressed(inPath, { duration, fps, width, height }) {
  console.log('inPath in imageToVideoCompressed :>> ', inPath);
  if (!fs.existsSync(inPath)) {
    return Promise.reject(new Error(`Input file does not exist: ${inPath}`));
  }
  const id = uuidv4();
  const filename = `reel-${id}.mp4`;
  const outPath = path.join(VIDEO_DIR, filename);

  const vf = [
    `scale=${width}:${height}:force_original_aspect_ratio=decrease`,
    `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black`,
    `fps=${fps}`,
  ].join(',');

  const codec = VIDEO_CODEC;
  const vOpts = [
    `-t ${duration}`,
    '-pix_fmt yuv420p',
    '-movflags +faststart',
    `-crf ${VIDEO_CRF}`,
    `-preset ${VIDEO_PRESET}`,
    '-tune stillimage',
    `-g ${VIDEO_KEYINT}`,
    `-keyint_min ${VIDEO_KEYINT}`,
    `-maxrate ${VIDEO_MAXRATE_KBPS}k`,
    `-bufsize ${VIDEO_BUFSIZE_KBPS}k`,
    '-shortest',
    '-threads 1'
  ];
  if (codec === 'libx265') vOpts.push('-tag:v hvc1'); // iOS/Safari friendliness

  return new Promise((resolve, reject) => {
    try {
      if (!inPath || !fs.existsSync(inPath)) {
        return reject(new Error(`Invalid input file: ${inPath}`));
      }

      const cmd = ffmpeg()
        // still image (video) input
        .input(inPath)
        .inputOptions(['-loop 1'])
        // generated silent audio input via lavfi
        .input('anullsrc=channel_layout=mono:sample_rate=44100')
        .inputFormat('lavfi')
        // video settings
        .videoFilters(vf)
        .fps(fps)
        .videoCodec(codec)
        .outputOptions(vOpts)
        // audio settings
        .audioCodec('aac')
        .audioChannels(1)
        .audioBitrate(`${AUDIO_BR_KBPS}k`)
        .on('start', (cmdline) => {
          console.log('[ffmpeg start]', cmdline);
        })
        .on('stderr', (line) => {
          // helpful while debugging
          console.log('[ffmpeg stderr]', line);
        })
        .save(outPath);

      cmd.on('end', () => resolve({ id, filename, outPath }));
      cmd.on('error', (err) => reject(err));
    } catch (error) {
      reject(new Error('Error starting ffmpeg: ' + error.message || error));
    }
  });
}

// --- add near your encoders section ---

async function makeStillClip(inPath, outPath, { duration, fps, width, height }) {
  const vf = [
    `scale=${width}:${height}:force_original_aspect_ratio=decrease`,
    `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black`,
    `fps=${fps}`,
  ].join(',');

  const codec = VIDEO_CODEC;
  const vOpts = [
    `-t ${duration}`,
    '-pix_fmt yuv420p',
    '-movflags +faststart',
    `-crf ${VIDEO_CRF}`,
    `-preset ${VIDEO_PRESET}`,
    '-tune stillimage',
    `-g ${VIDEO_KEYINT}`,
    `-keyint_min ${VIDEO_KEYINT}`,
    `-maxrate ${VIDEO_MAXRATE_KBPS}k`,
    `-bufsize ${VIDEO_BUFSIZE_KBPS}k`,
    '-shortest',
    '-threads 1',
  ];
  if (codec === 'libx265') vOpts.push('-tag:v hvc1');

  return new Promise((resolve, reject) => {
    ffmpeg()
      .input(inPath)
      .inputOptions(['-loop 1'])
      .input('anullsrc=channel_layout=mono:sample_rate=44100')
      .inputFormat('lavfi')
      .videoFilters(vf)
      .fps(fps)
      .videoCodec(codec)
      .outputOptions(vOpts)
      .audioCodec('aac')
      .audioChannels(1)
      .audioBitrate(`${AUDIO_BR_KBPS}k`)
      .on('end', resolve)
      .on('error', reject)
      .save(outPath);
  });
}

async function concatMp4s(inputFiles, outPath) {
  // Use FFmpeg concat demuxer with a temp list file
  const listPath = path.join('/tmp', `concat-${uuidv4()}.txt`);
  const listBody = inputFiles.map(p => `file '${p.replace(/'/g, "'\\''")}'`).join('\n');
  await fsp.writeFile(listPath, listBody, 'utf8');

  return new Promise((resolve, reject) => {
    ffmpeg()
      .input(listPath)
      .inputOptions(['-f concat', '-safe 0'])
      .outputOptions(['-c copy', '-movflags +faststart'])
      .on('end', async () => {
        try { await fsp.unlink(listPath); } catch { }
        resolve();
      })
      .on('error', async (err) => {
        try { await fsp.unlink(listPath); } catch { }
        reject(err);
      })
      .save(outPath);
  });
}


// ---------- Routes ----------
// 1) Buffer download + basic encode
app.post('/image-to-video-buffer', upload.single('file'), async (req, res) => {
  const q = { ...req.query, ...req.body };
  const { duration, fps, width, height } = parseParams(q);

  try {
    let inPath;
    if (q.url) {
      inPath = await downloadPngOrJpgByBuffer(q.url);
    } else if (req.file) {
      const ext = path.extname(req.file.originalname || '').toLowerCase();
      if (!ALLOWED_EXTS.has(ext)) throw new Error('Only PNG or JPG files are allowed.');
      inPath = req.file.path;
    } else {
      return res.status(400).json({ error: 'Provide ?url=PNG/JPG or multipart "file"' });
    }

    await clearVideoDir();
    const { id, filename } = await imageToVideo(inPath, { duration, fps, width, height });
    fs.unlink(inPath, () => { }); // cleanup

    const relPath = `/videos/${filename}`;
    return res.json({ ok: true, id, filename, duration, fps, width, height, url: absoluteUrl(req, relPath), path: relPath });
  } catch (e) {
    console.error('Error in POST /image-to-video-buffer:', e);
    return res.status(500).json({ ok: false, error: e.message || String(e) });
  }
});

// 2) Streamed download + basic encode (memory-safe)
app.post('/image-to-video-stream', upload.single('file'), async (req, res) => {
  const q = { ...req.query, ...req.body };
  const { duration, fps, width, height } = parseParams(q);

  try {
    if (!q.url) return res.status(400).json({ error: 'Provide ?url=PNG/JPG via ?url=...' });

    const inPath = await downloadPngOrJpgStream(q.url);
    await clearVideoDir();
    const { id, filename } = await imageToVideo(inPath, { duration, fps, width, height });
    fs.unlink(inPath, () => { }); // cleanup

    const relPath = `/videos/${filename}`;
    return res.json({ ok: true, id, filename, duration, fps, width, height, url: absoluteUrl(req, relPath), path: relPath });
  } catch (e) {
    console.error('Error in POST /image-to-video-stream:', e);
    return res.status(500).json({ ok: false, error: e.message || String(e) });
  }
});

// 3) Streamed download + compressed encode
app.post('/image-to-video-stream-compressed', upload.single('file'), async (req, res) => {
  const q = { ...req.query, ...req.body };
  const { duration, fps, width, height } = parseParams(q);

  const introUrl = q.introUrl;           // NEW
  const introDuration = Math.min(Math.max(parseInt(q.introDuration || '0', 10), 0), 1); // e.g., cap at 20s

  try {
    if (!q.url) return res.status(400).json({ error: 'Provide ?url=PNG/JPG via ?url=...' });

    const mainPath = await downloadPngOrJpgStream(q.url);
    let introPath = null;
    if (introUrl) {
      introPath = await downloadPngOrJpgStream(introUrl);
    }
    await clearVideoDir(); // TODO: I should check whether I need it again or not
    const { id, filename } = await imageToVideoCompressedWithIntro(
      mainPath,
      { duration, fps, width, height },
      introPath,
      introDuration
    );

    fs.unlink(mainPath, () => { }); // cleanup
    if (introPath) fs.unlink(introPath, () => { });

    const relPath = `/videos/${filename}`;
    return res.json({
      ok: true,
      id, filename, duration, fps, width, height,
      url: absoluteUrl(req, relPath), path: relPath
    });
  } catch (e) {
    console.error('Error in POST /image-to-video-stream-compressed:', e);
    return res.status(500).json({ ok: false, error: e.message || String(e) });
  }
});

// Backward-compat simple endpoints (optional):
app.post('/image-to-video', async (req, res) => res.redirect(307, '/image-to-video-stream'));
app.get('/image-to-video', async (req, res) => res.status(405).json({ error: 'Use POST /image-to-video-stream' }));

// ---------- Start ----------
app.listen(PORT, () => {
  console.log(`img2reel listening on :${PORT}`);
  console.log('NODE_OPTIONS:', process.execArgv);
});
