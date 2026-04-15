/**
 * Mock of S3 AWS Client
 */

import {open} from 'fs/promises';
import {dirname, join} from 'path';
import {fileURLToPath} from 'url';
import type {ReadStream} from 'fs';

import initDebug from 'debug';

const debug = initDebug('tokenizer:inflate:s3');

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturePath = join(__dirname, 'fixture');

function openFile(name: string) {
	const path = join(fixturePath, name);
	return open(path);
}

function extractRange(rangeStr: string): [number, number] {
	const match = /bytes=(\d+)-(\d+)/.exec(rangeStr);
	if (!match) {
		throw new Error('Invalid range format');
	}

	const start = Number.parseInt(match[1], 10);
	const end = Number.parseInt(match[2], 10);
	return [start, end];
}

interface GetObjectInput {
	Key?: string;
	Range?: string;
}

interface GetObjectCommandLike {
	constructor: {
		name: string;
	};
	input: GetObjectInput;
}

interface MockGetObjectResponse {
	ContentType: 'application/octet-stream';
	ContentRange: string;
	Body: ReadStream;
}

export class MockS3Client {
	public numberReads = 0;
	public bytesRead = 0;

	public async send(command: GetObjectCommandLike): Promise<MockGetObjectResponse> {
		if (command.constructor.name === 'GetObjectCommand') {
			const params = command.input;
			const range: [number, number] = params.Range ? extractRange(params.Range) : [-1, -1];

			const size = range[1] - range[0] + 1;
			++this.numberReads;
			this.bytesRead += size;
			debug(`Reading ${size} bytes at offset=${range[0]}`);

			if (params.Key) {
				const fileHandle = await openFile(params.Key);
				const stat = await fileHandle.stat();
				const stream = fileHandle.createReadStream({start: range[0], end: range[1]});

				stream.addListener('close', () => {
					void fileHandle.close();
				});

				return {
					ContentType: 'application/octet-stream',
					ContentRange: `bytes ${range.join('-')}/${stat.size}`,
					Body: stream,
				};
			}

			throw new Error('Missing key');
		}

		throw new Error('Unsupported command');
	}

	public stats(): {bytesRead: number; numberReads: number} {
		return {
			bytesRead: this.bytesRead,
			numberReads: this.numberReads,
		};
	}
}
