export interface MultipartFilePart {
	field: string;
	filename: string;
	data: ArrayBuffer;
	contentType?: string;
}

export interface MultipartResult {
	body: ArrayBuffer;
	contentType: string;
}

function randomBoundary(): string {
	const rand = Array.from({ length: 16 }, () =>
		Math.floor(Math.random() * 16).toString(16)
	).join("");
	return `----ObsidianRagflowBoundary${rand}`;
}

function concatBuffers(parts: Uint8Array[]): ArrayBuffer {
	const total = parts.reduce((sum, p) => sum + p.byteLength, 0);
	const out = new Uint8Array(total);
	let offset = 0;
	for (const p of parts) {
		out.set(p, offset);
		offset += p.byteLength;
	}
	return out.buffer;
}

/**
 * Build a multipart/form-data body that can be passed to Obsidian's requestUrl()
 * as an ArrayBuffer with the returned Content-Type header.
 */
export function buildMultipart(
	fields: Record<string, string>,
	files: MultipartFilePart[]
): MultipartResult {
	const boundary = randomBoundary();
	const encoder = new TextEncoder();
	const parts: Uint8Array[] = [];

	for (const [name, value] of Object.entries(fields)) {
		parts.push(
			encoder.encode(
				`--${boundary}\r\n` +
					`Content-Disposition: form-data; name="${name}"\r\n\r\n` +
					`${value}\r\n`
			)
		);
	}

	for (const file of files) {
		const contentType = file.contentType ?? "application/octet-stream";
		parts.push(
			encoder.encode(
				`--${boundary}\r\n` +
					`Content-Disposition: form-data; name="${file.field}"; filename="${file.filename}"\r\n` +
					`Content-Type: ${contentType}\r\n\r\n`
			)
		);
		parts.push(new Uint8Array(file.data));
		parts.push(encoder.encode("\r\n"));
	}

	parts.push(encoder.encode(`--${boundary}--\r\n`));

	return {
		body: concatBuffers(parts),
		contentType: `multipart/form-data; boundary=${boundary}`,
	};
}
