# BroadcastQA Studio — Cloud 24/7 Recording & Archive Deployment Guide

## Architecture Overview
- **Web & API Service (`server.ts`)**: Serves the Chrome-compatible web UI and authenticated REST API on port `3000`.
- **Independent Recording Worker (`worker.ts`)**: Runs FFmpeg 24/7 recording pipelines, automatic stream reconnection, segment probing, SHA-256 verification, and retryable S3/R2 uploads completely independent of any browser session.
- **Persistent Database (`data/broadcast_qa.db` + Firebase Firestore)**: Stores channel master list, encrypted stream sources, active recording sessions, verified archive segments, autosave XML entries, QA findings, timestamp matches, and audit logs.
- **Cloud Object Storage (Cloudflare R2 / Amazon S3 / Backblaze B2 / MinIO)**: Stores verified recording segments (`recordings/<channelKey>/<YYYY>/<MM>/<DD>/<segment>.mp4`) and serves playback via secure time-limited presigned URLs.

## Required Environment Variables
Copy `.env.example` to `.env` and configure:
- `STORAGE_ENCRYPTION_KEY`: 32+ character random key used for AES-256-GCM encryption of stream credentials and cloud keys at rest.
- `S3_PROVIDER`: `cloudflare_r2`, `aws_s3`, `backblaze_b2`, `minio`, or `custom_s3`.
- `S3_ENDPOINT`: S3-compatible endpoint URL (e.g., `https://<account-id>.r2.cloudflarestorage.com`).
- `S3_REGION`: `auto` for Cloudflare R2 or AWS region (e.g., `us-east-1`).
- `S3_BUCKET`: Bucket name for cloud video recordings.
- `S3_ACCESS_KEY_ID` & `S3_SECRET_ACCESS_KEY`: Server-side object storage credentials (never exposed in frontend JavaScript).
- `STORAGE_BUDGET_GB`, `STORAGE_WARNING_PCT`, `STORAGE_RETENTION_DAYS`, `STORAGE_COST_PER_GB_USD`.

## Cloud Deployment (Docker Compose)
```bash
cp .env.example .env
# Edit .env with your real S3/R2 credentials and encryption key
docker compose up -d --build
```

Place an HTTPS reverse proxy (Caddy, Nginx + Let's Encrypt, or Cloudflare Tunnel) in front of port `3000` so operators can access the platform securely via Google Chrome from anywhere.

## Scaling Multiple Recording Workers
Deploy additional worker containers pointing at the shared database/storage backend with distinct `RECORDING_WORKER_ID` values (e.g., `cloud-worker-01`, `cloud-worker-02`). Duplicate active sessions for the same channel are prevented automatically.
