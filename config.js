// config.js
export const MAX_IMAGE_BYTES = parseInt(process.env.MAX_IMAGE_BYTES || String(25 * 1024 * 1024), 10); // 25 MB
export const DOWNLOAD_TIMEOUT_MS = parseInt(process.env.DOWNLOAD_TIMEOUT_MS || '15000', 10);          // 15s
export const MAX_REDIRECTS = parseInt(process.env.MAX_REDIRECTS || '3', 10);

export const VIDEO_CODEC = process.env.VIDEO_CODEC || 'libx264';      // 'libx264' or 'libx265'
export const VIDEO_CRF = parseInt(process.env.VIDEO_CRF || '26', 10); // 18(best) .. 30(smallest)
export const VIDEO_PRESET = process.env.VIDEO_PRESET || 'slow';       // ultrafast..veryslow
export const VIDEO_MAXRATE_KBPS = parseInt(process.env.VIDEO_MAXRATE_KBPS || '2500', 10); // peak cap
export const VIDEO_BUFSIZE_KBPS = parseInt(process.env.VIDEO_BUFSIZE_KBPS || '5000', 10); // VBV buffer
export const VIDEO_KEYINT = parseInt(process.env.VIDEO_KEYINT || '240', 10);              // GOP size
export const AUDIO_BR_KBPS = parseInt(process.env.AUDIO_BR_KBPS || '64', 10);             // 64 kbps mono

export const DEFAULT_WIDTH = parseInt(process.env.TARGET_WIDTH || '1080', 10);
export const DEFAULT_HEIGHT = parseInt(process.env.TARGET_HEIGHT || '1920', 10);
export const PORT = process.env.PORT || 3001;
export const VIDEO_DIR = process.env.VIDEO_DIR || '/app/data/videos';
