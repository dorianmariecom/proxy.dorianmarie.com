function getParam(url, name) {
  const v = url.searchParams.get(name);
  return v && v.trim() !== "" ? v : null;
}

async function sha256Hex(input) {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", data);
  const bytes = new Uint8Array(digest);
  let hex = "";
  for (let i = 0; i < bytes.length; i++) {
    const h = bytes[i].toString(16).padStart(2, "0");
    hex += h;
  }
  return hex;
}

function inferFilenameFromUrl(u) {
  const pathname = u.pathname;
  if (!pathname) return null;
  const parts = pathname.split("/").filter(Boolean);
  if (parts.length === 0) return null;
  return parts[parts.length - 1] || null;
}

function getFileExtension(filename, contentType) {
  // Try to get extension from filename first
  if (filename) {
    const lastDot = filename.lastIndexOf(".");
    if (lastDot > 0 && lastDot < filename.length - 1) {
      return filename.substring(lastDot);
    }
  }

  // Fallback to content type
  if (contentType) {
    const typeMap = {
      "image/jpeg": ".jpg",
      "image/jpg": ".jpg",
      "image/png": ".png",
      "image/gif": ".gif",
      "image/webp": ".webp",
      "image/svg+xml": ".svg",
      "image/bmp": ".bmp",
      "image/ico": ".ico",
      "image/x-icon": ".ico"
    };
    return typeMap[contentType.toLowerCase()] || ".jpg";
  }

  return ".jpg"; // Default extension
}

function sanitizeUrlForFilename(url) {
  // Extract meaningful parts from URL: hostname and pathname
  const hostname = url.hostname.replace(/^www\./, ""); // Remove www. prefix
  const pathname = url.pathname;

  // Combine hostname and pathname, then sanitize
  let combined = hostname + pathname;

  // Remove protocol, query params, and hash
  // Keep only alphanumeric, hyphens, and underscores
  combined = combined
    .replace(/[^a-zA-Z0-9\-_]/g, "-") // Replace non-alphanumeric with hyphens
    .replace(/-+/g, "-") // Collapse multiple hyphens
    .replace(/^-|-$/g, ""); // Remove leading/trailing hyphens

  // Limit length to 40 characters
  if (combined.length > 40) {
    combined = combined.substring(0, 40);
  }

  return combined || "image"; // Fallback if empty
}

function generateRandomFilename(sourceUrl, extension) {
  // Generate a random 16-character hex string (8 bytes)
  const randomBytes = new Uint8Array(8);
  crypto.getRandomValues(randomBytes);
  const randomHex = Array.from(randomBytes)
    .map(b => b.toString(16).padStart(2, "0"))
    .join("");

  // Get sanitized URL part
  const sanitizedUrl = sanitizeUrlForFilename(sourceUrl);

  // Combine: sanitized-url-randomhex.extension
  return `${sanitizedUrl}-${randomHex}${extension}`;
}

function buildContentDisposition(disposition, filename) {
  if (!filename) return disposition;
  const sanitized = filename.replace(/[\r\n"]+/g, "");
  return `${disposition}; filename="${sanitized}"`;
}

function isValidHttpUrl(s) {
  try {
    const u = new URL(s);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

// CDN subdomain prefixes: when image is on these, use main site as Referer (e.g. www.leboncoin.fr for img.leboncoin.fr)
const CDN_SUBDOMAIN_PREFIXES = [
  "img.", "static.", "media.", "cdn.", "assets.", "images.", "image.",
  "lvdneng.", "vdneng.", "cdn1.", "cdn2."
];

function getRefererForUrl(sourceUrl) {
  const hostname = sourceUrl.hostname || "";
  const origin = sourceUrl.origin;

  const isCdnSubdomain = CDN_SUBDOMAIN_PREFIXES.some(
    (prefix) => hostname.startsWith(prefix)
  );
  const parts = hostname.split(".");
  // Use main site (www.<root>) when image is on a CDN subdomain and we have at least 2 labels for root (e.g. leboncoin.fr)
  if (isCdnSubdomain && parts.length >= 2) {
    const rootDomain = parts.slice(1).join(".");
    return `https://www.${rootDomain}/`;
  }
  return origin ? `${origin}/` : null;
}

function jsonError(message, status = 400) {
  return new Response(
    JSON.stringify({ error: message }),
    {
      status,
      headers: {
        "Content-Type": "application/json"
      }
    }
  );
}

export default {
  async fetch(request, env) {
    const reqUrl = new URL(request.url);
    const sourceUrlStr = getParam(reqUrl, "url");
    if (!sourceUrlStr) {
      return jsonError("Missing required query parameter: url", 400);
    }
    if (!isValidHttpUrl(sourceUrlStr)) {
      return jsonError("Invalid url. Only http/https supported.", 400);
    }

    const dispositionParam = (getParam(reqUrl, "disposition") || "inline").toLowerCase();
    const disposition = dispositionParam === "attachment" ? "attachment" : "inline";
    const explicitFilename = getParam(reqUrl, "filename");

    const key = await sha256Hex(sourceUrlStr);

    const cached = await env.FILES.get(key);
    if (cached) {
      const headers = new Headers();
      const ct = (cached.httpMetadata && cached.httpMetadata.contentType) || "application/octet-stream";
      if (!ct.toLowerCase().startsWith("image/")) {
        return jsonError("Only images are allowed", 415);
      }
      headers.set("Content-Type", ct);
      headers.set("ETag", cached.etag);
      headers.set("Accept-Ranges", "bytes");
      if (typeof cached.size === "number") {
        headers.set("Content-Length", String(cached.size));
      }

      const cdMeta = cached.httpMetadata && cached.httpMetadata.contentDisposition;
      const fromMeta = cdMeta && cdMeta.split("filename=") && cdMeta.split("filename=")[1];
      const metaFilename = fromMeta ? fromMeta.replace(/\"/g, "") : null;
      const originalFilename = explicitFilename || metaFilename || null;
      const extension = getFileExtension(originalFilename, ct);
      // For cached files, we need to reconstruct the source URL or use a default
      // Since we don't have the original URL in cache, we'll use a generic approach
      const sourceUrl = new URL(sourceUrlStr);
      const filename = explicitFilename || generateRandomFilename(sourceUrl, extension);
      headers.set("Content-Disposition", buildContentDisposition(disposition, filename));

      return new Response(cached.body, { status: 200, headers });
    }

    const sourceUrl = new URL(sourceUrlStr);
    // Use browser-like headers so CDNs (leboncoin, antikobjet, rosselcdn, etc.) don't return 403 Forbidden
    const fetchHeaders = new Headers({
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      Accept:
        "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
      "Sec-Fetch-Dest": "image",
      "Sec-Fetch-Mode": "no-cors",
      "Sec-Fetch-Site": "cross-site"
    });
    // Many CDNs expect Referer to be the main site (e.g. www.leboncoin.fr for img.leboncoin.fr, www.rosselcdn.net for lvdneng.rosselcdn.net)
    const referer = getRefererForUrl(sourceUrl);
    if (referer) fetchHeaders.set("Referer", referer);

    const originResp = await fetch(sourceUrl.toString(), {
      headers: fetchHeaders,
      cf: { cacheTtl: 0, cacheEverything: false }
    });
    if (!originResp.ok || !originResp.body) {
      const errorMessage = originResp.statusText || `Failed to fetch resource: ${originResp.status}`;
      return jsonError(errorMessage, originResp.status);
    }

    const contentType = originResp.headers.get("content-type") || "";
    if (!contentType.toLowerCase().startsWith("image/")) {
      const isHtml = contentType.toLowerCase().includes("text/html");
      const msg = isHtml
        ? "Only images are allowed; this URL may require login (e.g. Facebook/Instagram) or returns a page instead of an image."
        : "Only images are allowed";
      return jsonError(msg, 415);
    }
    const contentLengthHeader = originResp.headers.get("content-length");

    let bodyForClient;
    let valueForR2;

    if (contentLengthHeader && !Number.isNaN(Number(contentLengthHeader))) {
      // We can stream to client and R2 using a FixedLengthStream
      const [streamForClient, streamForR2Raw] = originResp.body.tee();
      const { readable, writable } = new FixedLengthStream(Number(contentLengthHeader));
      streamForR2Raw.pipeTo(writable).catch(() => {});
      bodyForClient = streamForClient;
      valueForR2 = readable;
    } else {
      // Unknown length: buffer once, use for both R2 and client
      const buf = await originResp.arrayBuffer();
      valueForR2 = buf;
      bodyForClient = new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(buf));
          controller.close();
        }
      });
    }

    await env.FILES.put(key, valueForR2, {
      httpMetadata: {
        contentType
      }
    });

    const headers = new Headers(originResp.headers);
    const originalFilename = explicitFilename || inferFilenameFromUrl(sourceUrl);
    const extension = getFileExtension(originalFilename, contentType || null);
    const filename = explicitFilename || generateRandomFilename(sourceUrl, extension);
    headers.set("Content-Disposition", buildContentDisposition(disposition, filename));
    // Adjust Content-Length: keep if origin provided and we streamed; if we buffered, set to exact length
    if (!(contentLengthHeader && !Number.isNaN(Number(contentLengthHeader)))) {
      // In the buffered case, bodyForClient is a single chunk stream; set length explicitly
      // We cannot directly know buf length here without storing it; safer to omit to avoid mismatch
      headers.delete("Content-Length");
    }

    return new Response(bodyForClient, {
      status: originResp.status,
      headers
    });
  }
};
