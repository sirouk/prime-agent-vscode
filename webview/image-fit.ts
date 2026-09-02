/**
 * Image attachment fitting.
 *
 * Two independent facts drove this module into existence. One: the provider
 * measures its 10 MB ceiling on the BASE64 payload, which is ~4/3 larger than
 * the decoded file — a ceiling spoken in decoded bytes passes some images the
 * provider is then guaranteed to 400, and one such image in history bricks
 * the session because the transcript is replayed on every request. Two: the
 * provider downsamples anything beyond ~1568px on the long edge anyway, so
 * scaling down first costs the model nothing.
 *
 * Policy is deliberately conservative: only images that exceed the byte budget
 * are touched (an attached JPEG that already fits is sent bit-identical, and
 * nobody is flattening your animated GIF into frame one unless the provider
 * would otherwise refuse the whole thread). The pure half below is DOM-free
 * and unit-testable; the encoder half degrades to a hard cap with a visible
 * notice wherever a canvas is unavailable.
 */

/** Exact base64 growth: 4 chars per 3 bytes, rounded up. */
export function base64Length(decodedBytes: number): number {
	return decodedBytes <= 0 ? 0 : Math.ceil(decodedBytes / 3) * 4;
}

/** Exact decoded length a base64 string represents. */
export function decodedLength(base64: string): number {
	const trimmed = base64.replace(/=+$/, "");
	return Math.floor((trimmed.length * 3) / 4);
}

/** The provider's hard ceiling, measured on the base64 payload (verified on the wire). */
export const PROVIDER_BASE64_LIMIT = 10_485_760;

/**
 * Decoded budget with deliberate air under the provider ceiling: 7 MiB encodes
 * to 9.79 MB of base64, clear of the 10 MB ceiling. Anything at or under this
 * budget goes out bit-identical; anything over must be shrunk or refused —
 * a rejected image is fixable, a 400 in history makes the whole session
 * unanswerable because the transcript is replayed on every request.
 */
export const MAX_DECODED_IMAGE_BYTES = 7 * 1024 * 1024;

/** Longest edge the provider shows the model; larger is discarded server-side anyway. */
export const PROVIDER_LONG_EDGE = 1568;

/**
 * The provider's total-request budget is a different measure, but a message
 * payload that cannot even be base64-wrapped inside the image ceiling cannot
 * be part of a valid request. Fit targets must always respect this.
 */
export function fitsProvider(decodedBytes: number): boolean {
	return base64Length(decodedBytes) <= PROVIDER_BASE64_LIMIT && decodedBytes <= MAX_DECODED_IMAGE_BYTES;
}

/** Fit a rectangle to within `maxEdge` on the long side, preserving aspect. */
export function fitRect(width: number, height: number, maxEdge: number): { width: number; height: number } {
	const longEdge = Math.max(width, height);
	if (longEdge <= maxEdge) return { width, height };
	const scale = maxEdge / longEdge;
	return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

export type ImageFitPlan =
	| { action: "send" }
	| { action: "resize"; targetWidth: number; targetHeight: number }
	| { action: "reject"; reason: "too-large-unfittable" };

/**
 * What to do with an image before it enters the transcript. Dimensions may be
 * unknown at decision time; an oversized image whose dimensions cannot be read
 * (no canvas) cannot be fitted here, and refusing it beats bricking a thread.
 */
export function planImageFit(decodedBytes: number, width?: number, height?: number): ImageFitPlan {
	const mustShrink = decodedBytes > MAX_DECODED_IMAGE_BYTES || !fitsProvider(decodedBytes);
	if (!mustShrink) return { action: "send" };
	if (typeof width === "number" && typeof height === "number" && width > 0 && height > 0) {
		const { width: targetWidth, height: targetHeight } = fitRect(width, height, PROVIDER_LONG_EDGE);
		return { action: "resize", targetWidth, targetHeight };
	}
	return { action: "reject", reason: "too-large-unfittable" };
}

export interface FittedImage {
	data: string;
	mimeType: string;
	/** True when the payload on the wire differs from what the user attached. */
	resized: boolean;
}

/** Pixel access for the encoder half; resolves null where the DOM cannot (tests). */
function loadImageElement(dataUrl: string): Promise<HTMLImageElement | null> {
	return new Promise((resolve) => {
		if (typeof Image === "undefined") return resolve(null);
		const img = new Image();
		img.onload = () => resolve(img);
		img.onerror = () => resolve(null);
		img.src = dataUrl;
	});
}

function drawToDataUrl(img: CanvasImageSource, width: number, height: number, mimeType: string, quality?: number): { data: string; mimeType: string } | null {
	if (typeof document === "undefined") return null;
	const canvas = document.createElement("canvas");
	canvas.width = width;
	canvas.height = height;
	const ctx = canvas.getContext("2d");
	if (!ctx) return null;
	ctx.drawImage(img, 0, 0, width, height);
	let out: string;
	try {
		out = canvas.toDataURL(mimeType, quality);
	} catch {
		return null;
	}
	const comma = out.indexOf(",");
	if (!out.startsWith("data:") || comma < 0) return null;
	return { mimeType: out.slice(5, comma).replace(";base64", ""), data: out.slice(comma + 1) };
}

/**
 * Fit one attachment under the provider budget. Returns the input unchanged
 * when it already fits, a resized copy when it needed work, and null when no
 * canvas exists or every ladder rung stayed oversized — the caller then
 * applies its hard cap and tells the user.
 */
export async function fitImageDataUrl(input: { data: string; mimeType: string }): Promise<FittedImage | null> {
	const { data, mimeType } = input;
	if (planImageFit(decodedLength(data)).action === "send") return { ...input, resized: false };
	if (typeof document === "undefined") return null;
	const img = await loadImageElement(`data:${mimeType};base64,${data}`);
	if (!img || !img.naturalWidth || !img.naturalHeight) return null;
	const plan = planImageFit(decodedLength(data), img.naturalWidth, img.naturalHeight);
	if (plan.action === "send") return { ...input, resized: false };
	if (plan.action === "reject") return null;
	let width = plan.targetWidth;
	let height = plan.targetHeight;
	const ladder: Array<{ type: string; quality?: number }> = [
		{ type: "image/png" },
		{ type: "image/jpeg", quality: 0.92 },
		{ type: "image/jpeg", quality: 0.82 },
	];
	for (let rung = 0; rung < 6; rung += 1) {
		for (const { type, quality } of ladder) {
			const out = drawToDataUrl(img, width, height, type, quality);
			if (!out) break;
			if (fitsProvider(decodedLength(out.data))) return { data: out.data, mimeType: out.mimeType, resized: true };
		}
		width = Math.floor(width / 2);
		height = Math.floor(height / 2);
		if (Math.max(width, height) < 320) break;
	}
	return null;
}
