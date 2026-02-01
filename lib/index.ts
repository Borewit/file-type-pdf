import createDebug from 'debug';
import sax from 'sax';
import type {ITokenizer} from 'strtok3';
import type {Detector, FileTypeResult} from 'file-type';
import {PdfTokenizerReader} from './PdfTokenizerReader.js';
import {textDecode} from '@borewit/text-codec';

const log = createDebug('file-type:pdf');

type DictValue = true | string;
type Dict = Record<string, DictValue>;

type ProbeContext = {
	log: (...args: unknown[]) => void;
};

export interface PdfTypeResult extends FileTypeResult {
	archive?: boolean;
}

type SubtypeProbe = {
	name: string;
	onDict?: (ctx: ProbeContext, dictText: string, dict: Dict) => PdfTypeResult | undefined;
	onCreatorTool?: (ctx: ProbeContext, creatorTool: string) => PdfTypeResult | undefined;
	onStreamText?: (ctx: ProbeContext, streamText: string, objectInfo: Dict) => PdfTypeResult | undefined;
};

const OBJ_REGEX = /^\s*(\d+)\s+(\d+)\s+obj\b/;

function isRecoverableXmlEntityError(error: unknown): boolean {
	if (!(error instanceof Error)) return false;

	// Keep matching tolerant across sax-js versions, but scoped to entity-related parse errors.
	return /invalid\s+character\s+entity|entity.*not.*defined|undefined\s+entity/i.test(error.message);
}

function clearSaxParserErrorState(parser: sax.SAXParser): void {
	// sax-js keeps an internal error latch that must be reset before resume().
	(parser as unknown as {error: unknown}).error = null;
}

function restoreTokenizerPosition(tokenizer: ITokenizer, position: number): void {
	(tokenizer as unknown as {position: number}).position = position;
}

const PDF_TYPE: Readonly<PdfTypeResult> = Object.freeze({ext: 'pdf', mime: 'application/pdf'});
const PDFA_TYPE: Readonly<PdfTypeResult> = Object.freeze({ext: 'pdf', mime: 'application/pdf', archive: true});
const AI_TYPE: Readonly<PdfTypeResult> = Object.freeze({ext: 'ai', mime: 'application/illustrator'});

/**
 * Peeks the tokenizer, and returns true if magic signature is found.
 */
async function peekIsPdfHeader(tokenizer: ITokenizer): Promise<boolean> {
	const rawSignature = new Uint8Array(5);
	return await tokenizer.peekBuffer(rawSignature, {mayBeLess: true}) === 5
		&& textDecode(rawSignature, 'ascii') === '%PDF-';
}

function parseDictFromRaw(raw: string): Dict {
	const dictRegex = /\/(\w+)(?:\s+([^/>\n\r]+))?/g;
	const info: Dict = {};

	let match: RegExpExecArray | null = dictRegex.exec(raw);

	while (match !== null) {
		const key = match[1]!;
		info[key] = match[2] ? match[2].trim() : true;

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
		return await inflateWithFormat('deflate', data);
	} catch {
		return await inflateWithFormat('deflate-raw', data);
	}
}

async function inflateWithFormat(format: 'deflate' | 'deflate-raw', data: Uint8Array): Promise<Uint8Array> {
	const normalized = new Uint8Array(data.byteLength);
	normalized.set(data);

	const ds = new DecompressionStream(format);

	const input = new ReadableStream<any>({
		start(controller) {
			controller.enqueue(normalized);
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
		if (f === 'FlateDecode') {
			out = await inflateFlateDecode(out);
		} else {
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

	while (!raw.includes('>>')) {
		const next = await reader.readLine();
		if (next === null) break;
		raw += `\n${next}`;
	}

	const start = raw.indexOf('<<');
	const end = raw.indexOf('>>', start + 2);
	if (start === -1 || end === -1) return {dictText: null, streamInline: false};

	const dictText = raw.slice(start + 2, end).trim();
	const after = raw.slice(end + 2).trim();
	const streamInline = after === 'stream' || after.startsWith('stream ');

	return {dictText, streamInline};
}

class XmlHandler {
	private saxParser: sax.SAXParser;
	private readingCreatorTool = false;
	private readingPdfAIdPart = false;
	private onCreatorTool?: (value: string) => void;
	private onPdfAIdPart?: (value: string) => void;

	constructor(opts: {
		onCreatorTool?: (value: string) => void;
		onPdfAIdPart?: (value: string) => void;
	} = {}) {
		this.onCreatorTool = opts.onCreatorTool;
		this.onPdfAIdPart = opts.onPdfAIdPart;
		this.saxParser = sax.parser(true, {xmlns: true});

		this.saxParser.onerror = (error: unknown) => {
			if (isRecoverableXmlEntityError(error)) {
				clearSaxParserErrorState(this.saxParser);
				this.saxParser.resume();
				return;
			}

			throw error instanceof Error ? error : new Error(String(error));
		};

		this.saxParser.onopentag = (node: unknown) => {
			const tag = node as sax.QualifiedTag;

			const isCreatorTool =
				tag.uri === 'http://ns.adobe.com/xap/1.0/' && tag.local === 'CreatorTool';

			const nameCreatorTool =
				typeof tag.name === 'string'
				&& (tag.name === 'xap:CreatorTool' || tag.name.endsWith(':CreatorTool') || tag.name === 'CreatorTool');

			this.readingCreatorTool = isCreatorTool || nameCreatorTool;

			const isPdfAIdPart =
				tag.uri === 'http://www.aiim.org/pdfa/ns/id/' && tag.local === 'part';

			const namePdfAIdPart =
				typeof tag.name === 'string' && tag.name === 'pdfaid:part';

			this.readingPdfAIdPart = isPdfAIdPart || namePdfAIdPart;
		};

		this.saxParser.ontext = (text: string) => {
			if (this.readingCreatorTool) {
				this.onCreatorTool?.(text);
				this.readingCreatorTool = false;
			}

			if (this.readingPdfAIdPart) {
				this.onPdfAIdPart?.(text);
				this.readingPdfAIdPart = false;
			}
		};

		this.saxParser.onclosetag = () => {
			this.readingCreatorTool = false;
			this.readingPdfAIdPart = false;
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
		name: 'adobe-illustrator',
		onDict: (_ctx, dictText, dict) => {
			if (dict.Illustrator === true) return AI_TYPE;
			if (dictText.includes('/Illustrator')) return AI_TYPE;

			const creator = dict.Creator;
			const producer = dict.Producer;

			if (creator && creator !== true && String(creator).includes('Illustrator')) return AI_TYPE;
			if (producer && producer !== true && String(producer).includes('Illustrator')) return AI_TYPE;

			if (dictText.includes('Adobe Illustrator')) return AI_TYPE;
			return undefined;
		},
		onCreatorTool: (_ctx, creatorTool) => {
			if (creatorTool.toLowerCase().includes('illustrator')) return AI_TYPE;
			return undefined;
		},
		onStreamText: (_ctx, streamText) => {
			if (streamText.includes('Adobe Illustrator')) return AI_TYPE;
			return undefined;
		},
	};
}

const subtypeProbes: SubtypeProbe[] = [createIllustratorProbe()];

/**
 * File-type detector plugin:
 * - returns undefined if NOT a PDF (and does not advance tokenizer.position in that case)
 * - returns subtype result when a probe matches (e.g. AI_TYPE, PDFA_TYPE)
 * - returns undefined when no subtype match is found
 */
async function _detectPdf(
	tokenizer: ITokenizer,
	opts: { maxScanLines?: number } = {}
): Promise<FileTypeResult | undefined> {
	const maxScanLines = opts.maxScanLines ?? 50_000;
	const ctx: ProbeContext = {log};
	const startPosition = tokenizer.position;

	if (!await peekIsPdfHeader(tokenizer)) return undefined;

	log(`[PDF] Detected %PDF- header at abs=${tokenizer.position}`);

	const reader = new PdfTokenizerReader(tokenizer);

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
		.filter((fn): fn is NonNullable<SubtypeProbe['onCreatorTool']> => typeof fn === 'function');

	log('[ROOT] Start parsing (PDF)');

	let state = 0;
	let scannedLines = 0;
	let foundObject = false;

	while (scannedLines++ < maxScanLines) {
		const line = await readLine();
		if (line === null) break;

		if (state === 0) {
			const m = OBJ_REGEX.exec(line);
			if (m) {
				foundObject = true;
				log(`Found object: ${m[1]} Generation: ${m[2]}`);
				state = 10;
			}
			continue;
		}

		if (state === 10) {
			if (line.trim() === 'endobj') {
				log('[OBJ] => [ROOT]');
				state = 0;
				continue;
			}

			if (!line.includes('<<')) continue;

			const {dictText, streamInline} = await readDictionaryBlock(reader, line);
			if (!dictText) continue;

			log(`[OBJ] Dictionary content: ${dictText.replace(/\s+/g, ' ')}`);
			log(streamInline ? '[OBJ] Stream keyword detected: stream' : '[OBJ] No stream keyword present on this line.');

			const objectInfo = parseDictFromRaw(dictText);

			for (const probe of subtypeProbes) {
				if (!probe.onDict) continue;
				const hit = probe.onDict(ctx, dictText, objectInfo);
				if (hit) return hit;
			}

			let hasStream = streamInline;
			if (!hasStream) {
				const nextLine = await readLine();
				if (nextLine === null) break;

				if (nextLine.trim() === 'stream') {
					hasStream = true;
				} else {
					pendingLine = nextLine;
				}
			}

			if (!hasStream) continue;

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

			for (const probe of subtypeProbes) {
				if (!probe.onStreamText) continue;
				const hit = probe.onStreamText(ctx, streamText, objectInfo);
				if (hit) return hit;
			}

			const looksLikeXmp =
				objectInfo.Type === 'Metadata'
				|| objectInfo.Type === '/Metadata'
				|| objectInfo.Subtype === 'XML'
				|| objectInfo.Subtype === '/XML'
				|| objectInfo.XML === true;

			if (looksLikeXmp) {
				log('[STREAM] XML metadata detected, feeding SAX');

				const xml = new XmlHandler({
					onCreatorTool: (v: string) => {
						log(`CreatorTool=${v}`);
						for (const fn of creatorToolListeners) {
							const hit = fn(ctx, v);
							if (hit) throw hit;
						}
					},
					onPdfAIdPart: (v: string) => {
						const part = v.trim();
						log(`pdfaid:part=${part}`);
						if (/^[1-4]$/.test(part)) throw PDFA_TYPE;
					},
				});

				try {
					xml.write(streamText);
					xml.close();
				} catch (e: unknown) {
					if (e && typeof e === 'object' && e !== null && 'ext' in e && 'mime' in e) {
						return e as PdfTypeResult;
					}

					log('[STREAM] Ignoring malformed XML metadata', e);
				}
			}
			log('[STREAM] => [OBJ]');
		}
	}

	log('[ROOT] Done parsing (PDF)');
	if (!foundObject) {
		restoreTokenizerPosition(tokenizer, startPosition);
		return undefined;
	}

	return PDF_TYPE;
}

export const detectPdf: Detector = {
	id: 'pdf',
	detect: async (tokenizer: ITokenizer): Promise<PdfTypeResult | undefined> => _detectPdf(tokenizer),
};
