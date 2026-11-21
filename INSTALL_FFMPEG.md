# Installing and Verifying FFmpeg for the 24/7 Cloud Recording Worker

This guide provides step-by-step instructions for installing **FFmpeg** (`ffmpeg` and `ffprobe`) on a cloud Linux server (Ubuntu/Debian) and verifying that the binaries are properly configured for the BroadcastQA Studio 24/7 recording engine (`server/recordingEngine.ts` and `worker.ts`).

---

## 1. Prerequisites & Sizing Recommendations

Before installing FFmpeg on your cloud server (VPS, EC2, DigitalOcean Droplet, Hetzner, GCP Compute Engine, etc.), ensure you have:

- **Operating System:** Ubuntu 22.04 LTS / 24.04 LTS or Debian 11 / 12 (64-bit)
- **Access:** SSH access with `sudo` privileges
- **Network:** Outbound access to your authorized broadcast stream endpoints (HTTPS `443`, HTTP `80`, RTMP `1935`, RTSP `554`) and your S3/R2 object storage endpoint (`443`)
- **Hardware Baseline:**
  - The recording engine uses stream-copy (`-c copy`) when possible, which keeps CPU usage very low (~2–5% of 1 vCPU per channel).
  - Allocate at least **2 vCPU / 4 GB RAM** for 5–15 concurrent 24/7 channels, and **40+ GB SSD** for temporary segment staging before verified upload to Cloudflare R2 / Amazon S3.

---

## 2. Option A: Install FFmpeg on Ubuntu / Debian (Recommended)

Connect to your cloud server over SSH and run the following commands.

### Step 1: Update package index and install FFmpeg + CA certificates
Installing `ca-certificates` is required so FFmpeg can validate HTTPS/TLS certificates on HLS (`.m3u8`) streams.

```bash
sudo apt-get update
sudo apt-get install -y ffmpeg ca-certificates
```

### Step 2: Confirm installation paths
The recording worker invokes `ffmpeg` and `ffprobe` via the system `PATH`. Confirm both binaries exist in a standard location (typically `/usr/bin/ffmpeg` and `/usr/bin/ffprobe`):

```bash
which ffmpeg
which ffprobe
```

Expected output:
```text
/usr/bin/ffmpeg
/usr/bin/ffprobe
```

---

## 3. Option B: Install Newer Static FFmpeg Binaries (Optional)

If your server runs an older LTS release and you need a newer FFmpeg release (e.g., for modern HLS/HEVC streams), you can install static Linux builds into `/usr/local/bin`:

```bash
# Install curl and xz-utils if not present
sudo apt-get update && sudo apt-get install -y curl xz-utils ca-certificates

# Download static amd64 build (use arm64 build on ARM servers)
cd /tmp
curl -L -o ffmpeg-release-amd64-static.tar.xz \
  https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-amd64-static.tar.xz

# Extract and install binaries into /usr/local/bin
mkdir -p /tmp/ffmpeg-static
tar -xJf ffmpeg-release-amd64-static.tar.xz -C /tmp/ffmpeg-static --strip-components=1

sudo install -m 0755 /tmp/ffmpeg-static/ffmpeg /usr/local/bin/ffmpeg
sudo install -m 0755 /tmp/ffmpeg-static/ffprobe /usr/local/bin/ffprobe

# Clean up temporary files
rm -rf /tmp/ffmpeg-static /tmp/ffmpeg-release-amd64-static.tar.xz
```

Verify that `/usr/local/bin` takes precedence in `PATH`:
```bash
which ffmpeg ffprobe
```

---

## 4. Option C: Docker Deployment (Pre-Installed Automatically)

The repository's `Dockerfile` already installs `ffmpeg` and `ca-certificates` inside the container image for both the web server and the standalone recording worker (`worker.ts`).

To build and verify inside Docker:
```bash
docker compose up -d --build
docker compose exec worker ffmpeg -version
docker compose exec worker ffprobe -version
```

---

## 5. Verify `ffmpeg` and `ffprobe` Capabilities

Run the following checks on the server to confirm the binaries are complete and ready for 24/7 segmented recording.

### 5.1 Check binary versions
```bash
ffmpeg -version | head -n 3
ffprobe -version | head -n 3
```
Both commands must exit with status `0` and print version and configuration headers.

### 5.2 Verify required network protocols
The recording engine ingests HLS/HTTP(S), RTSP, and RTMP streams. Verify protocol support:
```bash
ffmpeg -hide_banner -protocols | grep -E "https|hls|rtmp|rtsp"
```
Confirm `http`, `https`, `hls`, `rtmp`, and `rtsp` appear in the output.

### 5.3 Verify required muxers and codecs
The worker writes segmented `.mp4` files with fast-start metadata (`movflags +faststart`). Verify support:
```bash
ffmpeg -hide_banner -muxers | grep -E "segment|mp4"
ffmpeg -hide_banner -decoders | grep -E "h264|aac"
```

### 5.4 Test `ffprobe` on an authorized stream URL
Replace `<AUTHORIZED_STREAM_URL>` with a permitted stream URL from your broadcast source:
```bash
ffprobe -v error \
  -select_streams v:0 \
  -show_entries stream=codec_name,width,height \
  -of json \
  "<AUTHORIZED_STREAM_URL>"
```
A valid response returns JSON containing `codec_name`, `width`, and `height`.

### 5.5 Test local segmented MP4 writing (dry run without external network)
Run a 5-second synthetic color-bar test to verify FFmpeg can write valid segmented `.mp4` files on disk:
```bash
mkdir -p /tmp/ffmpeg-test
ffmpeg -hide_banner -loglevel error \
  -f lavfi -i testsrc=duration=5:size=1280x720:rate=25 \
  -f lavfi -i sine=frequency=1000:duration=5 \
  -c:v libx264 -preset ultrafast -c:a aac \
  -f segment -segment_time 5 -reset_timestamps 1 \
  -segment_format_options movflags=+faststart \
  /tmp/ffmpeg-test/test_%03d.mp4

ffprobe -v error -show_format -show_streams /tmp/ffmpeg-test/test_000.mp4
rm -rf /tmp/ffmpeg-test
```
If `ffprobe` outputs valid `mp4` format and stream metadata with exit code `0`, FFmpeg is fully functional.

---

## 6. Configure Systemd / Process Manager `PATH` for the Recording Worker

When running the Node.js server (`npm start`) or standalone worker (`npm run worker`) under **systemd** or **PM2**, non-interactive service shells sometimes use a minimal `PATH`. Explicitly include `/usr/local/bin` and `/usr/bin` in your service definition.

### Example `systemd` unit (`/etc/systemd/system/broadcastqa-worker.service`)
```ini
[Unit]
Description=BroadcastQA 24/7 Cloud Recording Worker
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=broadcastqa
WorkingDirectory=/opt/broadcastqa
EnvironmentFile=/opt/broadcastqa/.env
Environment="PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
ExecStart=/usr/bin/npm run worker
Restart=always
RestartSec=5
LimitNOFILE=65535

[Install]
WantedBy=multi-user.target
```

Reload and start the worker service:
```bash
sudo systemctl daemon-reload
sudo systemctl enable --now broadcastqa-worker
sudo systemctl status broadcastqa-worker
```

### Verify staging directory write permissions
Ensure the service user owns the SQLite data and temporary recording staging directory (default `./data/recordings` inside the app working directory):
```bash
sudo mkdir -p /opt/broadcastqa/data/recordings
sudo chown -R broadcastqa:broadcastqa /opt/broadcastqa/data
```

---

## 7. Verify Worker Integration via API and UI

### 7.1 Backend Health Endpoint
Once the server is running on port `3000`, query `/api/recording/health`:
```bash
curl -s http://localhost:3000/api/recording/health
```

Confirm `"available": true` and a valid version string:
```json
{
  "worker": {
    "workerId": "cloud-worker-01",
    "hostname": "your-vps-hostname",
    "pid": 1234,
    "activeRecordingCount": 0,
    "uptimeSeconds": 42
  },
  "ffmpeg": {
    "available": true,
    "version": "ffmpeg version 6.1.1 ..."
  },
  "cloudStorageConfigured": true,
  "cloudStorageProvider": "cloudflare_r2"
}
```

### 7.2 Web Interface Verification
1. Open the web application in Google Chrome.
2. Navigate to **24/7 Recording Monitor** in the left sidebar.
3. Confirm the top worker status strip shows **FFmpeg Engine: Ready** along with the detected version.
4. Click **Configure Stream** on any channel, enter an authorized stream URL, and click **Probe** to verify live `ffprobe` detection of codec and resolution before starting 24/7 recording.

---

## 8. Troubleshooting

| Symptom | Cause | Fix |
| :--- | :--- | :--- |
| `/api/recording/health` returns `"ffmpeg": { "available": false }` | `ffmpeg` is not installed or not in the worker process `PATH` | Run `which ffmpeg`, install via `apt-get install -y ffmpeg`, and add `/usr/local/bin:/usr/bin` to your systemd/PM2 `PATH`. |
| `Probe` fails with `Protocol not found` or TLS/SSL errors | Missing `ca-certificates` or minimal FFmpeg build without HTTPS | Run `sudo apt-get install -y ca-certificates && sudo update-ca-certificates`. |
| Recording stops immediately with `Permission denied` | Worker user cannot write to `./data/recordings` | Run `sudo chown -R <service-user>:<service-user> /path/to/app/data`. |
| RTSP/RTMP streams time out on cloud VPS | Cloud firewall / security group blocks outbound ports `554` or `1935` | Allow outbound TCP/UDP on ports `80`, `443`, `554`, and `1935` in your cloud provider's firewall rules. |
| Segments record locally but fail to upload to cloud | S3 / Cloudflare R2 credentials not configured or invalid | Open **Storage Management**, verify endpoint/bucket/keys, click **Test S3/R2 Connection**, then click **Retry Failed Uploads**. |
