import path from 'node:path';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {describe, it} from 'mocha';

import {detectPdf} from '../lib/index.js';
import {fromBuffer, fromFile} from 'strtok3';

import {makeChunkedTokenizerFromS3} from '@tokenizer/s3';

import {assert} from 'chai';
import {MockS3Client} from './S3ClientMockup.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function getSamplePath(filename: string) {
	return path.join(__dirname, 'fixture', filename);
}

async function makeS3Tokenizer(fixture: string) {
	const s3Client = new MockS3Client();

	return makeChunkedTokenizerFromS3(s3Client, {
		Bucket: 'mockup',
		Key: fixture,
	});
}

describe('PDF detector', () => {
	it('should return undefined on any other file', async () => {
		const samplePath = getSamplePath('other.txt');
		const tokenizer = await fromFile(samplePath);
		try {
			const fileType = await detectPdf.detect(tokenizer);
			assert.isUndefined(fileType);
			assert.strictEqual(tokenizer.position, 0, 'position should not be advanced');
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

	it('should handle a tiny PDF file read via S3 mockup', async () => {
		const tokenizer = await makeS3Tokenizer('tiny.pdf');
		try {
			const result = await detectPdf.detect(tokenizer);
			assert.deepEqual(result, {ext: 'pdf', mime: 'application/pdf'});
		} finally {
			await tokenizer.close();
		}
	});

	it('should be able to detect PDF/A', async () => {
		const samplePath = getSamplePath('archive.pdf');
		const tokenizer = await fromFile(samplePath);
		try {
			const fileType = await detectPdf.detect(tokenizer);
			assert.deepEqual(fileType, {ext: 'pdf', mime: 'application/pdf', archive: true});
		} finally {
			await tokenizer.close();
		}
	});

	it('should handle bad XML', async () => {
		const samplePath = getSamplePath('file-type-pdf-issue-28-malformed-xmp.pdf');
		const tokenizer = await fromFile(samplePath);
		try {
			const fileType = await detectPdf.detect(tokenizer);
			assert.deepEqual(fileType, {ext: 'pdf', mime: 'application/pdf'});
		} finally {
			await tokenizer.close();
		}
	});

	it('should return undefined and preserve tokenizer position for header-only PDF signature', async () => {
		const sample = await readFile(getSamplePath('header-only.pdf'));
		const tokenizer = fromBuffer(sample);

		const fileType = await detectPdf.detect(tokenizer);

		assert.isUndefined(fileType);
		assert.strictEqual(tokenizer.position, 0, 'position should not be advanced');
	});

	it('should ignore malformed XML entity in XMP metadata and still detect PDF', async () => {
		const tokenizer = await fromFile(getSamplePath('malformed-xmp-entity.pdf'));
		try {
			const result = await detectPdf.detect(tokenizer);
			assert.isDefined(result);
			assert.strictEqual(result?.ext, 'pdf');
			assert.strictEqual(result?.mime, 'application/pdf');
		} finally {
			await tokenizer.close();
		}
	});
});
