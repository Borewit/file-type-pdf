import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe, it} from 'mocha';

import {detectPdf} from '../lib/index.js';
import {fromFile, fromBuffer} from 'strtok3';

import { makeChunkedTokenizerFromS3 } from "@tokenizer/s3";

import {assert} from 'chai';
import {MockS3Client} from "./S3ClientMockup.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function getSamplePath(filename) {
	return path.join(__dirname, 'fixture', filename);
}

async function makeS3Tokenizer(fixture) {
	const s3Client = new MockS3Client();

	return await makeChunkedTokenizerFromS3(s3Client, {
		Bucket: 'mockup',
		Key: fixture
	});
}

describe('PDF detector', () => {

	it('should return undefined on any other file', async () => {
		const samplePath = getSamplePath('other.txt');
		const tokenizer = await fromFile(samplePath);
		try {
			const fileType = await detectPdf.detect(tokenizer);
			assert.isUndefined(fileType);
			assert.strictEqual(tokenizer.position, 0, 'position should be be advanced');
		} finally {
			await tokenizer.close();
		}
	});

	it('should detect a regular PDF file', async () => {
		const samplePath = getSamplePath('fixture.pdf');
		const tokenizer = await fromFile(samplePath);
		try {
			const result = await detectPdf.detect(tokenizer);
			assert.deepEqual(result, {ext: 'pdf', mime: 'application/pdf'});
		} finally {
			await tokenizer.close();
		}
	});

	it('should be able to detect an Adobe Illustrator file', async () => {
		const samplePath = getSamplePath('fixture-normal.ai');
		const tokenizer = await fromFile(samplePath);
		try {
			const result = await detectPdf.detect(tokenizer);
			assert.deepEqual(result, {ext: 'ai', mime: 'application/illustrator'});
		} finally {
			await tokenizer.close();
		}
	});

	it('should handle a tiny PDF file', async () => {
		const samplePath = getSamplePath('tiny.pdf');
		const tokenizer = await fromFile(samplePath);
		try {
			const result = await detectPdf.detect(tokenizer);
			assert.deepEqual(result, {ext: 'pdf', mime: 'application/pdf'});
		} finally {
			await tokenizer.close();
		}
	});

	it("should handle a tiny PDF file read via S3 mockup", async () => {
		const tokenizer = await makeS3Tokenizer('tiny.pdf');
		try {
			const result = await detectPdf.detect(tokenizer);
			assert.deepEqual(result, {ext: 'pdf', mime: 'application/pdf'});
		} finally {
			await tokenizer.close();
		}
	});

	it('should detect a concatenated PDF by its signature only', async () => {
		// Minimal PDF header: %PDF-1.1
		const buffer = new Uint8Array([
			0x25, 0x50, 0x44, 0x46, 0x2D, // %PDF-
			0x31, 0x2E, 0x31            // 1.1
		]);

		const tokenizer = await fromBuffer(buffer);
		try {
			const result = await detectPdf.detect(tokenizer);
			assert.deepEqual(result, { ext: 'pdf', mime: 'application/pdf' });
		} finally {
			await tokenizer.close();
		}
	});

	it('should return undefined for files shorter than the PDF signature', async () => {
		const buffer = new Uint8Array([
			0x00, 0x00, 0x00
		]);

		const tokenizer = await fromBuffer(buffer);
		try {
			const result = await detectPdf.detect(tokenizer);
			assert.isUndefined(result);
		} finally {
			await tokenizer.close();
		}
	});

});
