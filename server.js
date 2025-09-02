const express = require('express');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs');
const ffmpeg = require('fluent-ffmpeg');

const app = express();
const upload = multer({ dest: '/tmp' });
const fsp = fs.promises;

const DEFAULT_WIDTH = parseInt(process.env.TARGET_WIDTH || '1080', 10);
const DEFAULT_HEIGHT = parseInt(process.env.TARGET_HEIGHT || '1920', 10);
const PORT = process.env.PORT || 3001;

// Ensure persistent dir exists (will be mounted via Render disk)
const VIDEO_DIR = process.env.VIDEO_DIR || '/app/data/videos';
fs.mkdirSync(VIDEO_DIR, { recursive: true });

// Serve generated files statically under /videos
app.use('/videos', express.static(VIDEO_DIR, {
  setHeaders: (res) => res.setHeader('Content-Type', 'video/mp4')
}));

app.get('/health', (_, res) => res.json({ ok: true }));

// --- helpers ---------------------------------------------------------------

const ALLOWED_CONTENT_TYPES = new Set(['image/jpeg', 'image/jpg', 'image/png']);
const ALLOWED_EXTS = new Set(['.jpg', '.jpeg', '.png']);

function pickExtFromCT(ct) {
  if (!ct) return null;
  ct = ct.toLowerCase();
  if (ct.includes('jpeg') || ct.includes('jpg')) return '.jpg';
  if (ct.includes('png')) return '.png';
  return null;
}

function pickExtFromURL(url) {
  try {
    const ext = path.extname(new URL(url).pathname).toLowerCase();
    return ALLOWED_EXTS.has(ext) ? ext : null;
  } catch { return null; }
}

/** download remote PNG/JPG to /tmp and return path */
async function downloadPngOrJpg(url) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`Fetch failed: ${res.status} ${res.statusText}`);

  const ct = (res.headers.get('content-type') || '').toLowerCase();
  const byCT = pickExtFromCT(ct);
  const byExt = pickExtFromURL(url);
  const ext = byCT || byExt;

  if (!ext || (byCT && !ALLOWED_CONTENT_TYPES.has(ct))) {
    throw new Error(`Only PNG or JPG URLs are allowed (got content-type="${ct || 'unknown'}").`);
  }

  const filePath = path.join('/tmp', `${uuidv4()}${ext}`);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(filePath, buf);
  return filePath;
}

/** run ffmpeg and SAVE result (unique filename), then return its public path */
function imageToVideo(inPath, { duration, fps, width, height }) {
  const id = uuidv4();
  const filename = `reel-${id}.mp4`;
  const outPath = path.join(VIDEO_DIR, filename);

  // Keep aspect ratio, center on WxH, black background
  const vf = [
    `scale=${width}:${height}:force_original_aspect_ratio=decrease`,
    `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black`
  ].join(',');

  return new Promise((resolve, reject) => {
    const cmd = ffmpeg()
      .addInput(inPath).inputOptions(['-loop 1'])
      .videoFilters(vf).fps(fps)
      .videoCodec('libx264')
      .outputOptions([
        `-t ${duration}`,
        '-pix_fmt yuv420p',
        '-movflags +faststart',
        '-shortest'
      ])
      .addInput('anullsrc=channel_layout=stereo:sample_rate=44100')
      .inputOptions(['-f lavfi'])
      .audioCodec('aac').audioBitrate('128k')
      .save(outPath);

    cmd.on('end', () => resolve({ id, filename, outPath }));
    cmd.on('error', reject);
  });
}

/** build absolute URL from request + relative path */
function absoluteUrl(req, relativePath) {
  const proto = req.headers['x-forwarded-proto'] || req.protocol;
  const host = req.headers['x-forwarded-host'] || req.get('host');
  return `${proto}://${host}${relativePath}`;
}

// Delete all .mp4 files in VIDEO_DIR
async function clearVideoDir() {
    try {
      await fsp.mkdir(VIDEO_DIR, { recursive: true });
      const entries = await fsp.readdir(VIDEO_DIR, { withFileTypes: true });
      const deletions = entries
        .filter(d => d.isFile() && d.name.toLowerCase().endsWith('.mp4'))
        .map(d => fsp.unlink(path.join(VIDEO_DIR, d.name)).catch(() => {}));
      await Promise.all(deletions);
    } catch (err) {
      console.error('clearVideoDir failed:', err);
      // proceed anyway (don’t fail the request just because cleanup failed)
    }
  }
  

// --- route -----------------------------------------------------------------

/**
 * POST /image-to-video
 * EITHER:
 *   - ?url=https://... (PNG/JPG only)
 *   - or form-data file field "file" (PNG/JPG only)
 * Optional query: duration (1–90), fps (1–60), width, height
 * Returns JSON with the public URL to the saved MP4.
 */
app.post('/image-to-video', upload.single('file'), async (req, res) => {
  const duration = Math.min(Math.max(parseInt(req.query.duration || '20', 10), 1), 90);
  const fps = Math.min(Math.max(parseInt(req.query.fps || '30', 10), 1), 60);
  const width = parseInt(req.query.width || DEFAULT_WIDTH, 10);
  const height = parseInt(req.query.height || DEFAULT_HEIGHT, 10);

  try {
    let inPath;

    if (req.query.url) {
      inPath = await downloadPngOrJpg(req.query.url);
    } else if (req.file) {
      const ext = path.extname(req.file.originalname || '').toLowerCase();
      if (!ALLOWED_EXTS.has(ext)) throw new Error('Only PNG or JPG files are allowed.');
      inPath = req.file.path;
    } else {
      return res.status(400).json({ error: 'Provide ?url=PNG/JPG or multipart "file"' });
    }

    // ✅ Remove all previous videos first
    await clearVideoDir();

    const { id, filename } = await imageToVideo(inPath, { duration, fps, width, height });
    fs.unlink(inPath, () => {}); // cleanup input

    const relPath = `/videos/${filename}`;
    const url = absoluteUrl(req, relPath);

    return res.json({
      ok: true,
      id,
      filename,
      duration,
      fps,
      width,
      height,
      url,          // <-- public URL
      path: relPath // relative API path
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ ok: false, error: e.message || String(e) });
  }
});

app.listen(PORT, () => console.log(`img2reel listening on :${PORT}`));
