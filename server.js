import express from 'express';
import multer from 'multer';
import { v4 as uuidv4 } from 'uuid';
import path from 'path';
import fs from 'fs';
// Removed unused 'fetch' import
import ffmpeg from 'fluent-ffmpeg';
import axios from 'axios';

const app = express();
const upload = multer({ dest: '/tmp' });
const fsp = fs.promises;

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

const DEFAULT_WIDTH = parseInt(process.env.TARGET_WIDTH || '1080', 10);
const DEFAULT_HEIGHT = parseInt(process.env.TARGET_HEIGHT || '1920', 10);
const PORT = process.env.PORT || 3001;

// Ensure persistent dir exists (will be mounted via Render disk)
const VIDEO_DIR = process.env.VIDEO_DIR || '/app/data/videos';
if (!fs.existsSync(VIDEO_DIR)) {
    fs.mkdirSync(VIDEO_DIR, { recursive: true });
}
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

  try {
    const res = await axios.get(url, {
      responseType: 'arraybuffer',
      headers: { 
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
        'Accept': 'image/jpeg,image/png,image/*,*/*;q=0.8'
      }
    });
    console.log(`Fetching URL: ${url}`);
    if (res.status!==200) throw new Error(`Fetch failed: --- res.status:${res.status} --- res.statusText: ${res.statusText}`);

    const ct = (res.headers.get('content-type') || '').toLowerCase();
    const byCT = pickExtFromCT(ct);
    const byExt = pickExtFromURL(url);
    const ext = byCT || byExt;

    if (!ext || (byCT && !ALLOWED_CONTENT_TYPES.has(ct))) {
      throw new Error(`Only PNG or JPG URLs are allowed (got content-type="${ct || 'unknown'}").`);
    }

    const filePath = path.join('/tmp', `${uuidv4()}${ext}`);
    const buf = Buffer.from(res.data);
    fs.writeFileSync(filePath, buf);
    return filePath;
  } catch (error) {
    console.error(`Error downloading image: ${error.message || error}`);
    throw error;
  }
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
    try {
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
    } catch (error) {
      reject("Error starting ffmpeg: " + error);
    }
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
// POST /image-to-video
app.post('/image-to-video', upload.single('file'), async (req, res) => {
  console.log('Incoming host:', req.get('host'), 'proto:', req.protocol);
  const q = { ...req.query, ...req.body };       // merge body + query
  const duration = Math.min(Math.max(parseInt(q.duration || '20', 10), 1), 90);
  const fps = Math.min(Math.max(parseInt(q.fps || '30', 10), 1), 60);
  const width = parseInt(q.width || DEFAULT_WIDTH, 10);
  const height = parseInt(q.height || DEFAULT_HEIGHT, 10);

  try {
    let inPath;

    if (q.url) {
      inPath = await downloadPngOrJpg(q.url);
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
    console.error("Error in POST /image-to-video:", e);
    return res.status(500).json({ ok: false, error: e.message || String(e) });
  }
});

// GET /image-to-video
app.get('/image-to-video', async (req, res) => {
  console.log('Incoming host:', req.get('host'), 'proto:', req.protocol);
  const q = req.query; // use query parameters for GET
  const duration = Math.min(Math.max(parseInt(q.duration || '20', 10), 1), 90);
  const fps = Math.min(Math.max(parseInt(q.fps || '30', 10), 1), 60);
  const width = parseInt(q.width || DEFAULT_WIDTH, 10);
  const height = parseInt(q.height || DEFAULT_HEIGHT, 10);

  try {
    if (!q.url) {
      return res.status(400).json({ error: 'Provide ?url=PNG/JPG' });
    }

    const inPath = await downloadPngOrJpg(q.url);

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
    console.error("Error in GET /image-to-video:", e);
    return res.status(500).json({ ok: false, error: e.message || String(e) });
  }
});

app.listen(PORT, () => console.log(`img2reel listening on :${PORT}`));
