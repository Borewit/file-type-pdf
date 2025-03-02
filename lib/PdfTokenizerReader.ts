// PdfTokenizerReader.ts
import type { ITokenizer, IReadChunkOptions } from "strtok3";

export type PdfTokenizerReaderOptions = {
	chunkSize?: number;
	debug?: boolean;
};

export class PdfTokenizerReader {
	private tokenizer: ITokenizer;
	private buf: Buffer = Buffer.alloc(0);
	private pos = 0;

	private chunkSize: number;
	private eof = false;
	private debug: boolean;

	constructor(tokenizer: ITokenizer, opts: PdfTokenizerReaderOptions = {}) {
		this.tokenizer = tokenizer;
		this.chunkSize = opts.chunkSize ?? 64 * 1024;
		this.debug = !!opts.debug;
	}

	private log(msg: string): void {
		if (this.debug) console.log(msg);
	}

	/**
	 * Logical file position of the next byte that will be consumed by the reader.
	 */
	public getPosition(): number {
		const bufferedRemaining = this.buf.length - this.pos;
		return this.tokenizer.position - bufferedRemaining;
	}

	private async peekMayBeLess(target: Buffer, length: number): Promise<number> {
		const opts: IReadChunkOptions = { length, mayBeLess: true };
		try {
			return await this.tokenizer.peekBuffer(target, opts);
		} catch (e: unknown) {
			if (isEndOfStreamError(e)) return 0;
			throw e;
		}
	}

	private async readMayBeLess(target: Buffer, length: number): Promise<number> {
		const opts: IReadChunkOptions = { length, mayBeLess: true };
		try {
			return await this.tokenizer.readBuffer(target, opts);
		} catch (e: unknown) {
			if (isEndOfStreamError(e)) return 0;
			throw e;
		}
	}

	private compactBuffer(): void {
		if (this.pos > 0) {
			this.buf = this.buf.subarray(this.pos);
			this.pos = 0;
		}
	}

	private async fill(minBytes = 1): Promise<void> {
		if (this.eof) return;

		while (!this.eof && (this.buf.length - this.pos) < minBytes) {
			this.compactBuffer();

			// Peek first, then read exactly what we peeked
			const peekBuf = Buffer.alloc(this.chunkSize);
			const peeked = await this.peekMayBeLess(peekBuf, peekBuf.length);

			if (!peeked) {
				this.eof = true;
				this.log(`[READER] EOF @${this.getPosition()} (peekBuffer returned 0)`);
				break;
			}

			const readBuf = Buffer.alloc(peeked);
			const read = await this.readMayBeLess(readBuf, readBuf.length);

			if (!read) {
				this.eof = true;
				this.log(`[READER] EOF @${this.getPosition()} (readBuffer returned 0)`);
				break;
			}

			const slice = readBuf.subarray(0, read);
			this.buf = this.buf.length ? Buffer.concat([this.buf, slice]) : slice;
		}
	}

	/**
	 * Reads a line terminated by '\n' (supports '\r\n').
	 * Returns the line (latin1) without line ending, or null at EOF.
	 */
	public async readLine(): Promise<string | null> {
		while (true) {
			const idx = this.buf.indexOf(0x0a, this.pos); // '\n'
			if (idx !== -1) {
				let lineBuf = this.buf.subarray(this.pos, idx);
				if (lineBuf.length && lineBuf[lineBuf.length - 1] === 0x0d) {
					lineBuf = lineBuf.subarray(0, lineBuf.length - 1); // drop '\r'
				}
				this.pos = idx + 1;
				return lineBuf.toString("latin1");
			}

			const before = this.buf.length - this.pos;
			await this.fill(before + 1);
			const after = this.buf.length - this.pos;

			if (after === before && this.eof) {
				if (before === 0) return null;
				const tail = this.buf.subarray(this.pos);
				this.pos = this.buf.length;
				return tail.toString("latin1");
			}
		}
	}

	/**
	 * Reads exactly n bytes, or returns null if EOF occurs before n bytes are available.
	 */
	public async readBytes(n: number): Promise<Buffer | null> {
		if (n < 0) throw new Error("readBytes(n): n must be >= 0");
		if (n === 0) return Buffer.alloc(0);

		await this.fill(n);
		const avail = this.buf.length - this.pos;
		if (avail < n) return null;

		const out = this.buf.subarray(this.pos, this.pos + n);
		this.pos += n;
		return out;
	}

	/**
	 * Consume exactly one EOL after the 'stream' keyword if present.
	 */
	public async consumeStreamEol(): Promise<void> {
		await this.fill(1);
		const avail = this.buf.length - this.pos;
		if (avail <= 0) return;

		const b0 = this.buf[this.pos];
		if (b0 === 0x0d) {
			await this.fill(2);
			const avail2 = this.buf.length - this.pos;
			if (avail2 >= 2 && this.buf[this.pos + 1] === 0x0a) this.pos += 2; // \r\n
			else this.pos += 1; // \r
		} else if (b0 === 0x0a) {
			this.pos += 1; // \n
		}
	}
}

function isEndOfStreamError(e: unknown): boolean {
	if (!e || typeof e !== "object") return false;
	const anyE = e as { name?: unknown; message?: unknown };
	const name = typeof anyE.name === "string" ? anyE.name : "";
	const message = typeof anyE.message === "string" ? anyE.message : "";
	return name === "EndOfStreamError" || message.includes("End-Of-Stream");
}
