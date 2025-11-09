## Proxy Cache Worker

A Cloudflare Worker that downloads a file from a URL, caches it in R2, and serves it with either inline or attachment `Content-Disposition` based on query parameters.

### Endpoints

- `GET /?url=ENCODED_URL&disposition=inline|attachment&filename=optional_name`
  - **url**: required, the source file URL (http/https)
  - **disposition**: optional, `inline` (default) or `attachment`
  - **filename**: optional, suggested filename used in `Content-Disposition`

### R2 Caching

- Objects are cached under a key derived from `sha256(url)`.
- Stored with `contentType` when available.

### Setup

1. Install Wrangler:
   ```bash
   npm i -g wrangler
   ```
2. Create the R2 buckets (production and preview):
   ```bash
   wrangler r2 bucket create dorianmariecom-proxy
   wrangler r2 bucket create dorianmariecom-proxy-preview
   ```
3. Publish the worker:
   ```bash
   wrangler deploy
   ```

### Local development

```bash
wrangler dev
```

### Notes

- The worker does not rely on CF cache; it uses R2 as a persistent cache.
- When a file is not yet cached, it streams from origin while simultaneously storing to R2.
- Subsequent requests are served from R2 with accurate `Content-Length` and `ETag`.
