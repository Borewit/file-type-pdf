import sax from 'sax';
import type { ITokenizer, IReadChunkOptions } from 'strtok3';
import type { Detector, FileTypeResult } from 'file-type';
import { PdfTokenizerReader } from './PdfTokenizerReader.js';
import { textDecode } from '@borewit/text-codec';

type DictValue = true | string;
type Dict = Record<string, DictValue>;

type ProbeContext = {
	debug: boolean;
	log: (...args: unknown[]) => void;
};

type SubtypeProbe = {
	name: string;
	onDict?: (ctx: ProbeContext, dictText: string, dict: Dict) => FileTypeResult | undefined;
	onCreatorTool?: (ctx: ProbeContext, creatorTool: string) => FileTypeResult | undefined;
	onStreamText?: (ctx: ProbeContext, streamText: string, objectInfo: Dict) => FileTypeResult | undefined;
};

const OBJ_REGEX = /^\s*(\d+)\s+(\d+)\s+obj\b/;

const PDF_TYPE: Readonly<FileTypeResult> = Object.freeze({ ext: "pdf", mime: "application/pdf" });
const AI_TYPE: Readonly<FileTypeResult> = Object.freeze({ ext: "ai", mime: "application/illustrator" });

const encoder = new TextEncoder();

function indexOfBytes(hay: Uint8Array, needle: Uint8Array): number {
	if (needle.length === 0) return 0;
	outer: for (let i = 0; i <= hay.length - needle.length; i++) {
		for (let j = 0; j < needle.length; j++) {
			if (hay[i + j] !== needle[j]) continue outer;
		}
		return i;
	}
	return -1;
}

async function peekPdfHeader(tokenizer: ITokenizer): Promise<{ isPdf: boolean; headerOffset: number }> {
	const buf = new Uint8Array(1024);
	let n = 0;

	try {
		const opts: IReadChunkOptions = { length: buf.length, mayBeLess: true };
		n = await tokenizer.peekBuffer(buf, opts);
	} catch {
		return { isPdf: false, headerOffset: -1 };
	}

	if (!n) return { isPdf: false, headerOffset: -1 };

	const hay = buf.subarray(0, n);
	const idx = indexOfBytes(hay, encoder.encode("%PDF-"));
	if (idx === -1) return { isPdf: false, headerOffset: -1 };

	return { isPdf: true, headerOffset: idx };
}

async function skipBytes(tokenizer: ITokenizer, n: number): Promise<void> {
	if (n <= 0) return;

	const tmp = new Uint8Array(Math.min(64 * 1024, n));
	let left = n;

	while (left > 0) {
		const len = Math.min(tmp.length, left);
		const opts: IReadChunkOptions = { length: len };
		const read = await tokenizer.readBuffer(tmp, opts);
		if (!read) throw new Error("Unexpected EOF while skipping bytes");
		left -= read;
	}
}

function parseDictFromRaw(raw: string): Dict {
	const dictRegex = /\/(\w+)(?:\s+([^/>\n\r]+))?/g;
	const info: Dict = {};
	let match: RegExpExecArray | null = dictRegex.exec(raw);

	while (match !== null) {
		const key = match[1]!;
		const value = match[2] ? match[2].trim() : true;
		info[key] = value;

		match = dictRegex.exec(raw);
	}

	return info;
}

function normalizeFilters(filterValue: DictValue | undefined): string[] {
	if (!filterValue || filterValue === true) return [];
	const names = String(filterValue).match(/FlateDecode|ASCII85Decode|LZWDecode|RunLengthDecode/g);
	return names ? [...new Set(names)] : [];
}

async function inflateFlateDecode(data: Uint8Array): Promise<Uint8Array> {
	try {
		return await inflateWithFormat("deflate", data);
	} catch {
		return await inflateWithFormat("deflate-raw", data);
	}
}

async function inflateWithFormat(format: "deflate" | "deflate-raw", data: Uint8Array): Promise<Uint8Array> {
	// Normalize input so TS sees an ArrayBuffer-backed Uint8Array (not ArrayBufferLike/SharedArrayBuffer).
	const normalized = new Uint8Array(data.byteLength);
	normalized.set(data);

	const ds = new DecompressionStream(format);

	// Use the most permissive stream element type and cast pipeThrough to avoid DOM lib generic friction.
	const input = new ReadableStream<any>({
		start(controller) {
			controller.enqueue(normalized); // Uint8Array is a valid chunk at runtime
			controller.close();
		},
	});

	const out = input.pipeThrough(ds as any);

	const ab = await new Response(out as any).arrayBuffer();
	return new Uint8Array(ab);
}

async function decodeStreamBytes(objectInfo: Dict, rawBytes: Uint8Array): Promise<Uint8Array> {
	const filters = normalizeFilters(objectInfo.Filter);
	if (!filters.length) return rawBytes;

	let out = rawBytes;

	for (const f of filters) {
		if (f === "FlateDecode") {
			out = await inflateFlateDecode(out);
		} else {
			// Unsupported filters, return raw stream
			return rawBytes;
		}
	}

	return out;
}

async function readDictionaryBlock(
	reader: PdfTokenizerReader,
	firstLine: string
): Promise<{ dictText: string | null; streamInline: boolean }> {
	let raw = firstLine;

	while (!raw.includes(">>")) {
		const next = await reader.readLine();
		if (next === null) break;
		raw += `\n${next}`;
	}

	const start = raw.indexOf("<<");
	const end = raw.indexOf(">>", start + 2);
	if (start === -1 || end === -1) return { dictText: null, streamInline: false };

	const dictText = raw.slice(start + 2, end).trim();
	const after = raw.slice(end + 2).trim();
	const streamInline = after === "stream" || after.startsWith("stream ");

	return { dictText, streamInline };
}

class XmlHandler {
	private saxParser: sax.SAXParser;
	private readingCreatorTool = false;
	private onCreatorTool?: (value: string) => void;

	constructor(opts: { onCreatorTool?: (value: string) => void } = {}) {
		this.onCreatorTool = opts.onCreatorTool;
		this.saxParser = sax.parser(true, { xmlns: true });

		this.saxParser.onerror = (e: Error) => {
			if (e.message.startsWith("Invalid character entity")) {
				(this.saxParser as unknown as { error: unknown }).error = null;
				this.saxParser.resume();
				return;
			}
			throw e;
		};

		this.saxParser.onopentag = (node: unknown) => {
			const tag = node as sax.QualifiedTag;

			const isCreatorTool =
				tag.uri === "http://ns.adobe.com/xap/1.0/" && tag.local === "CreatorTool";

			// Fallback by name, in case xmlns typing/runtime differs
			const nameMatch =
				typeof tag.name === "string" &&
				(tag.name === "xap:CreatorTool" ||
					tag.name.endsWith(":CreatorTool") ||
					tag.name === "CreatorTool");

			this.readingCreatorTool = isCreatorTool || nameMatch;
		};

		this.saxParser.ontext = (text: string) => {
			if (!this.readingCreatorTool) return;
			this.onCreatorTool?.(text);
			this.readingCreatorTool = false;
		};

		this.saxParser.onclosetag = () => {
			this.readingCreatorTool = false;
		};
	}

	write(text: string): void {
		this.saxParser.write(text);
	}

	close(): void {
		this.saxParser.close();
	}
}

function createIllustratorProbe(): SubtypeProbe {
	return {
		name: "adobe-illustrator",
		onDict: (_ctx, dictText, dict) => {
			if (dict.Illustrator === true) return AI_TYPE;
			if (dictText.includes("/Illustrator")) return AI_TYPE;

			const creator = dict.Creator;
			const producer = dict.Producer;

			if (creator && creator !== true && String(creator).includes("Illustrator")) return AI_TYPE;
			if (producer && producer !== true && String(producer).includes("Illustrator")) return AI_TYPE;

			if (dictText.includes("Adobe Illustrator")) return AI_TYPE;
			return undefined;
		},
		onCreatorTool: (_ctx, creatorTool) => {
			if (creatorTool.toLowerCase().includes("illustrator")) return AI_TYPE;
			return undefined;
		},
		onStreamText: (_ctx, streamText) => {
			if (streamText.includes("Adobe Illustrator")) return AI_TYPE;
			return undefined;
		},
	};
}

const subtypeProbes: SubtypeProbe[] = [createIllustratorProbe()];

/**
 * File-type detector plugin:
 * - returns undefined if NOT a PDF (and does not advance tokenizer.position in that case)
 * - returns PDF_TYPE for PDF
 * - returns subtype result when a probe matches (e.g. AI_TYPE)
 */
async function _detectPdf(
	tokenizer: ITokenizer,
	opts: { debug?: boolean; maxScanLines?: number } = {}
): Promise<FileTypeResult | undefined> {
	const debug = !!opts.debug;
	const maxScanLines = opts.maxScanLines ?? 50_000;

	const log = (...args: unknown[]) => {
		if (debug) console.log(...args);
	};
	const ctx: ProbeContext = { debug, log };

	// NOT PDF => PEEK ONLY, do not advance
	const { isPdf, headerOffset } = await peekPdfHeader(tokenizer);
	if (!isPdf) return undefined;

	// Confirmed PDF => ok to advance
	log(`[PDF] Detected %PDF- header at +${headerOffset} (abs=${tokenizer.position + headerOffset})`);
	if (headerOffset > 0) await skipBytes(tokenizer, headerOffset);

	const reader = new PdfTokenizerReader(tokenizer, { debug });

	// pushback so we don't lose a line when probing for "stream"
	let pendingLine: string | null = null;
	const readLine = async (): Promise<string | null> => {
		if (pendingLine !== null) {
			const l = pendingLine;
			pendingLine = null;
			return l;
		}
		return await reader.readLine();
	};

	const creatorToolListeners = subtypeProbes
		.map(p => p.onCreatorTool)
		.filter((fn): fn is NonNullable<SubtypeProbe["onCreatorTool"]> => typeof fn === "function");

	log("[ROOT] Start parsing (PDF)");

	let state = 0; // ROOT=0, OBJ=10
	let scannedLines = 0;

	while (scannedLines++ < maxScanLines) {
		const line = await readLine();
		if (line === null) break;

		if (state === 0) {
			const m = OBJ_REGEX.exec(line);
			if (m) {
				log(`Found object: ${m[1]} Generation: ${m[2]}`);
				state = 10;
			}
			continue;
		}

		if (state === 10) {
			if (line.trim() === "endobj") {
				log("[OBJ] => [ROOT]");
				state = 0;
				continue;
			}

			if (!line.includes("<<")) continue;

			const { dictText, streamInline } = await readDictionaryBlock(reader, line);
			if (!dictText) continue;

			log(`[OBJ] Dictionary content: ${dictText.replace(/\s+/g, " ")}`);
			log(streamInline ? "[OBJ] Stream keyword detected: stream" : "[OBJ] No stream keyword present on this line.");

			const objectInfo = parseDictFromRaw(dictText);

			// Dict probes
			for (const probe of subtypeProbes) {
				if (!probe.onDict) continue;
				const hit = probe.onDict(ctx, dictText, objectInfo);
				if (hit) return hit;
			}

			// Stream check with pushback
			let hasStream = streamInline;
			if (!hasStream) {
				const nextLine = await readLine();
				if (nextLine === null) break;

				if (nextLine.trim() === "stream") {
					hasStream = true;
				} else {
					pendingLine = nextLine;
				}
			}

			if (!hasStream) continue;

			// Length may be indirect like "12 0 R", skip if not numeric
			const lenVal = objectInfo.Length;
			if (!lenVal || lenVal === true) continue;

			const streamLength = parseInt(lenVal, 10);
			if (!Number.isFinite(streamLength) || streamLength < 0) continue;

			log(`[OBJ] => [STREAM] Start read stream of ${streamLength} bytes`);

			await reader.consumeStreamEol();
			const rawBytes = await reader.readBytes(streamLength);
			if (!rawBytes) break;

			const decodedBytes = await decodeStreamBytes(objectInfo, rawBytes);
			const streamText = textDecode(decodedBytes, 'utf-8');

			// Stream probes
			for (const probe of subtypeProbes) {
				if (!probe.onStreamText) continue;
				const hit = probe.onStreamText(ctx, streamText, objectInfo);
				if (hit) return hit;
			}

			// XMP CreatorTool
			const looksLikeXmp =
				objectInfo.Type === "Metadata" ||
				objectInfo.Type === "/Metadata" ||
				objectInfo.Subtype === "XML" ||
				objectInfo.Subtype === "/XML" ||
				objectInfo.XML === true;

			if (looksLikeXmp && creatorToolListeners.length) {
				log("[STREAM] XML metadata detected, feeding SAX");

				const xml = new XmlHandler({
					onCreatorTool: (v: string) => {
						log(`CreatorTool=${v}`);
						for (const fn of creatorToolListeners) {
							const hit = fn(ctx, v);
							if (hit) throw hit;
						}
					},
				});

				try {
					xml.write(streamText);
					xml.close();
				} catch (e: unknown) {
					if (e && typeof e === "object" && "ext" in e && "mime" in e) {
						return e as FileTypeResult;
					}
					throw e;
				}
			}

			log("[STREAM] => [OBJ]");
		}
	}

	log("[ROOT] Done parsing (PDF)");
	return PDF_TYPE;
}

export const detectPdf: Detector = {
	id: 'cfbf',
	detect: async (tokenizer: ITokenizer):  Promise<FileTypeResult | undefined> => {
		return _detectPdf(tokenizer);
	}
};
