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

export default {
	async fetch(request, env) {
		const reqUrl = new URL(request.url);
		const sourceUrlStr = getParam(reqUrl, "url");
		if (!sourceUrlStr) {
			return new Response(
				"Missing required query parameter: url",
				{ status: 400 }
			);
		}
		if (!isValidHttpUrl(sourceUrlStr)) {
			return new Response("Invalid url. Only http/https supported.", { status: 400 });
		}

		const dispositionParam = (getParam(reqUrl, "disposition") || "inline").toLowerCase();
		const disposition = dispositionParam === "attachment" ? "attachment" : "inline";
		const explicitFilename = getParam(reqUrl, "filename");

		const key = await sha256Hex(sourceUrlStr);

		const cached = await env.FILES.get(key);
		if (cached) {
			const headers = new Headers();
			const ct = (cached.httpMetadata && cached.httpMetadata.contentType) || "application/octet-stream";
			headers.set("Content-Type", ct);
			headers.set("ETag", cached.etag);
			headers.set("Accept-Ranges", "bytes");
			if (typeof cached.size === "number") {
				headers.set("Content-Length", String(cached.size));
			}

			const cdMeta = cached.httpMetadata && cached.httpMetadata.contentDisposition;
			const fromMeta = cdMeta && cdMeta.split("filename=") && cdMeta.split("filename=")[1];
			const metaFilename = fromMeta ? fromMeta.replace(/\"/g, "") : null;
			const filename = explicitFilename || metaFilename || null;
			headers.set("Content-Disposition", buildContentDisposition(disposition, filename));

			return new Response(cached.body, { status: 200, headers });
		}

		const sourceUrl = new URL(sourceUrlStr);
		const originResp = await fetch(sourceUrl.toString(), {
			cf: { cacheTtl: 0, cacheEverything: false }
		});
		if (!originResp.ok || !originResp.body) {
			return new Response(originResp.body || originResp.statusText, {
				status: originResp.status,
				headers: originResp.headers
			});
		}

		const contentType = originResp.headers.get("content-type") || undefined;
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
		const fallbackFilename = explicitFilename || inferFilenameFromUrl(sourceUrl);
		headers.set("Content-Disposition", buildContentDisposition(disposition, fallbackFilename));
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
