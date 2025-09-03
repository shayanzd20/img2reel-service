# img2reel

Create short MP4 videos from PNG/JPG images.
Memory-safe streaming downloads, optional compressed output, and static hosting of generated files.

## Endpoints

- `POST /image-to-video-buffer` — downloads the image **into memory** (simple, but less memory safe).
- `POST /image-to-video-stream` — downloads the image **as a stream** with a hard byte cap (recommended).
- `POST /image-to-video-stream-compressed` — **streamed download** + **compressed encoding** (CRF/preset).
- `GET /health` — health check (`{ ok: true }`).
- `GET /videos/<filename>` — static hosting for generated MP4 files.

All `/image-to-video*` endpoints accept the same query/body parameters:

| Param      | Type   | Default | Range | Notes                                           |
| ---------- | ------ | ------- | ----- | ----------------------------------------------- |
| `url`      | string | —       | —     | Public PNG/JPG URL (required if no file upload) |
| `duration` | int    | 20      | 1–90  | Video duration in seconds                       |
| `fps`      | int    | 30      | 1–60  | Frames per second                               |
| `width`    | int    | 1080    | —     | Output width                                    |
| `height`   | int    | 1920    | —     | Output height                                   |

You can also upload a file instead of `url` using multipart with form field name `file`.

---

## Quick start

```bash
# 1) install
npm ci

# 2) create data dir (if not already created by the server)
mkdir -p ./data/videos

# 3) run
NODE_OPTIONS="--max-old-space-size=512" \
VIDEO_DIR="$PWD/data/videos" \
node server.js
```

Health check:

```bash
curl -s http://localhost:3001/health
# => {"ok":true}
```

---

## Environment variables (config)

These are read from `config.js`. Override as needed:

```bash
# Download safety
export MAX_IMAGE_BYTES=$((25*1024*1024))   # default 25 MB
export DOWNLOAD_TIMEOUT_MS=15000
export MAX_REDIRECTS=3

# Output size / compression
export VIDEO_CODEC=libx264                 # or libx265 if your ffmpeg supports it
export VIDEO_CRF=26                        # 18(best quality)..30(smallest)
export VIDEO_PRESET=slow                   # ultrafast..veryslow
export VIDEO_MAXRATE_KBPS=2500
export VIDEO_BUFSIZE_KBPS=5000
export VIDEO_KEYINT=240                    # GOP size
export AUDIO_BR_KBPS=64                    # mono

# Dimensions + paths
export TARGET_WIDTH=1080
export TARGET_HEIGHT=1920
export VIDEO_DIR="$PWD/data/videos"
export PORT=3001
```

> Tip: For very small files try `VIDEO_CRF=28` and `VIDEO_PRESET=veryslow`.
> For \~30–50% smaller files (if supported), set `VIDEO_CODEC=libx265`.

---

## cURL examples

### 1) Buffer download + basic encode

Download the image into memory, then encode.

**From URL**

```bash
curl -X POST "http://localhost:3001/image-to-video-buffer" \
  --data-urlencode "url=https://picsum.photos/200/300" \
  --data-urlencode "duration=20" \
  --data-urlencode "fps=30" \
  --data-urlencode "width=1080" \
  --data-urlencode "height=1920"
```

**From file upload**

```bash
curl -X POST "http://localhost:3001/image-to-video-buffer?duration=20&fps=30&width=1080&height=1920" \
  -F "file=@./local-image.jpg"
```

**Response**

```json
{
  "ok": true,
  "id": "b3c3f2d6-....",
  "filename": "reel-b3c3f2d6-....mp4",
  "duration": 20,
  "fps": 30,
  "width": 1080,
  "height": 1920,
  "url": "http://localhost:3001/videos/reel-b3c3f2d6-....mp4",
  "path": "/videos/reel-b3c3f2d6-....mp4"
}
```

---

### 2) Streamed download + basic encode (recommended)

Stream the image directly to disk with a strict byte cap (low memory usage).

```bash
curl -X POST "http://localhost:3001/image-to-video-stream" \
  --data-urlencode "url=https://picsum.photos/200/300" \
  --data-urlencode "duration=20" \
  --data-urlencode "fps=30" \
  --data-urlencode "width=1080" \
  --data-urlencode "height=1920"
```

---

### 3) Streamed download + **compressed** encode

Like #2 but uses CRF/preset (and optional HEVC) to shrink file size.

```bash
# Example with defaults (libx264, CRF 26, preset slow)
curl -X POST "http://localhost:3001/image-to-video-stream-compressed" \
  --data-urlencode "url=https://picsum.photos/200/300" \
  --data-urlencode "duration=20" \
  --data-urlencode "fps=30" \
  --data-urlencode "width=1080" \
  --data-urlencode "height=1920"
```

To switch to HEVC (if your ffmpeg supports it):

```bash
VIDEO_CODEC=libx265 \
curl -X POST "http://localhost:3001/image-to-video-stream-compressed" \
  --data-urlencode "url=https://picsum.photos/200/300"
```

To make files even smaller:

```bash
VIDEO_CRF=28 VIDEO_PRESET=veryslow \
curl -X POST "http://localhost:3001/image-to-video-stream-compressed" \
  --data-urlencode "url=https://picsum.photos/200/300"
```

---

## Static file access

The response includes a public URL under `/videos/...`. You can fetch or download it:

```bash
curl -o reel.mp4 "http://localhost:3001/videos/reel-<id>.mp4"
```

---

## Docker (optional)

**Dockerfile (alpine + ffmpeg)**

```dockerfile
FROM node:20-alpine

# ffmpeg (alpine package)
RUN apk add --no-cache ffmpeg

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .

ENV PORT=3001 \
    VIDEO_DIR=/app/data/videos \
    TARGET_WIDTH=1080 \
    TARGET_HEIGHT=1920

RUN mkdir -p $VIDEO_DIR
EXPOSE 3001
CMD ["node", "server.js"]
```

**Build & run**

```bash
docker build -t img2reel:latest .
docker run --rm -p 3001:3001 \
  -e NODE_OPTIONS="--max-old-space-size=512" \
  -e VIDEO_CODEC=libx264 \
  -e VIDEO_CRF=26 \
  -e VIDEO_PRESET=slow \
  -v $PWD/data/videos:/app/data/videos \
  img2reel:latest
```

---

## Notes & limits

- **Accepted inputs:** PNG/JPG via `url` or multipart file (`file`).
- **Memory safety:** Use `/image-to-video-stream*` for strict memory caps. The server enforces `MAX_IMAGE_BYTES` during download and aborts oversized streams.
- **Timeouts/redirects:** Controlled by `DOWNLOAD_TIMEOUT_MS` and `MAX_REDIRECTS`.
- **Compression:** `image-to-video-stream-compressed` uses CRF/preset; HEVC (`libx265`) yields smaller files but requires compatible ffmpeg and may have device compatibility trade-offs.
- **Housekeeping:** The server clears older `.mp4` files in `VIDEO_DIR` before generating a new one (current implementation removes all `.mp4` files).

---

## Troubleshooting

- `Only PNG or JPG URLs are allowed`
  The remote server didn’t provide a valid `content-type`, and the URL path didn’t end with a valid image extension. Try a direct image link or file upload.

- `Image too large`
  Increase `MAX_IMAGE_BYTES` if you trust the source, or downscale the image.

- `ffmpeg not found / codec not supported`
  Ensure ffmpeg is installed and supports your chosen codec (`libx264` is widely available; `libx265` may require a different build).

---

## Debugging with VS Code

To debug the application using Visual Studio Code, create a `.vscode/launch.json` file with the following configuration:

```json
{
  "version": "0.2.0",
  "configurations": [
    {
      "type": "node",
      "request": "launch",
      "name": "Launch App",
      "skipFiles": ["<node_internals>/**"],
      "program": "${workspaceFolder}/server.js", // change to your entry file
      "env": {
        "NODE_ENV": "development",
        "PORT": "3001"
      },
      "cwd": "${workspaceFolder}",
      "console": "integratedTerminal"
    },
    {
      "type": "node",
      "request": "attach",
      "name": "Attach to Process",
      "processId": "${command:PickProcess}",
      "restart": true
    }
  ]
}
```

This configuration allows you to either launch the app directly or attach to an existing Node.js process for debugging. Make sure to adjust the `program` field to point to your entry file if it's not `server.js`.
