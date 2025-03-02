import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe, it} from 'mocha';

import {detectPdf} from '../lib/index.js';
import {fromFile} from 'strtok3';

import {assert} from 'chai';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function getSamplePath(filename) {
	return path.join(__dirname, 'fixture', filename);
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

});
