/** Shared composer/host bounds. Large text belongs in a local file, not an RPC prompt. */
import type { TextFileAttachment } from "./protocol.js";

export const MAX_PROMPT_TEXT_CHARS = 200_000;
export const PASTE_FILE_THRESHOLD_CHARS = 32_000;
export const MAX_TEXT_ATTACHMENT_BYTES = 8 * 1024 * 1024;
export const MAX_TEXT_ATTACHMENTS = 4;
export const TEXT_ATTACHMENT_CHUNK_CHARS = 64_000;

/** A UTF-8 file cannot preserve a lone UTF-16 surrogate. Refuse rather than alter it. */
export function hasUnpairedSurrogate(text: string): boolean {
	for (let i = 0; i < text.length; i++) {
		const code = text.charCodeAt(i);
		if (code >= 0xd800 && code <= 0xdbff) {
			const low = text.charCodeAt(++i);
			if (!(low >= 0xdc00 && low <= 0xdfff)) return true;
		} else if (code >= 0xdc00 && code <= 0xdfff) return true;
	}
	return false;
}

/** Bounded webview frames, without splitting a UTF-16 pair at a boundary. */
export function splitTextAttachment(text: string): string[] {
	const chunks: string[] = [];
	for (let start = 0; start < text.length;) {
		let end = Math.min(text.length, start + TEXT_ATTACHMENT_CHUNK_CHARS);
		const last = text.charCodeAt(end - 1);
		if (end < text.length && last >= 0xd800 && last <= 0xdbff) end -= 1;
		chunks.push(text.slice(start, end));
		start = end;
	}
	return chunks;
}

/** UTF-8 size, including replacement encoding for unpaired UTF-16 surrogates. */
export function utf8ByteLength(text: string, ceiling = Number.MAX_SAFE_INTEGER): number {
	let bytes = 0;
	for (let i = 0; i < text.length; i++) {
		const code = text.charCodeAt(i);
		if (code < 0x80) bytes += 1;
		else if (code < 0x800) bytes += 2;
		else if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length && text.charCodeAt(i + 1) >= 0xdc00 && text.charCodeAt(i + 1) <= 0xdfff) {
			bytes += 4;
			i += 1;
		} else bytes += 3;
		if (bytes > ceiling) return bytes;
	}
	return bytes;
}

export function shouldAttachPastedText(text: string): boolean {
	return text.length >= PASTE_FILE_THRESHOLD_CHARS || text.includes("\0");
}

export function formatTextFileSize(bytes: number): string {
	return bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MiB` : bytes >= 1024 ? `${Math.ceil(bytes / 1024)} KiB` : `${bytes} bytes`;
}

/** Data-only references: never @ expansion, a shell command, or inlined file contents. */
export function appendTextFileReferences(text: string, files: readonly TextFileAttachment[]): string {
	const attribute = (value: string): string => value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\r/g, "&#13;").replace(/\n/g, "&#10;");
	for (const file of files) {
		text += `\n\n<attachment file="${attribute(file.path)}" name="${attribute(file.name)}" bytes="${file.byteLength}">\nLocal UTF-8 text file. Use the file-reading tool to read this path, in sections as needed. Its full contents are not included in this prompt.\n</attachment>`;
	}
	return text;
}
