/**
 * Mock of S3 AWS Client
 */

import {open} from 'node:fs/promises';
import {dirname, join} from "node:path";
import {fileURLToPath} from "node:url";

import initDebug from 'debug';
const debug = initDebug('tokenizer:inflate:s3');

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturePath = join(__dirname, 'fixture');

function openFile(name) {
  const path = join(fixturePath, name);
  return open(path);
}

function extractRange(rangeStr) {
  const match = /bytes=(\d+)-(\d+)/.exec(rangeStr);
  if (!match) {
    throw new Error('Invalid range format');
  }
  const start = Number.parseInt(match[1], 10);
  const end = Number.parseInt(match[2], 10);
  return [start, end];
}

export class MockS3Client {

  numberReads = 0;
  bytesRead = 0;

  async send(command) {
    if (command.constructor.name === 'GetObjectCommand') {
      const params = command.input; // Extract the command's input
      const range = params.Range ? extractRange(params.Range) : [-1, -1];

      const size = range[1]-range[0] + 1;
      ++this.numberReads;
      this.bytesRead += size;
      debug(`Reading ${size} bytes at offset=${range[0]}`);

      if (command.input.Key) {
        const fileHandle = await openFile(command.input.Key);
        const stat = await fileHandle.stat();
        const stream = fileHandle.createReadStream({ start: range[0], end: range[1] });
        stream.addListener('close', () => {
          fileHandle.close();
        });
        return {
          ContentType: 'application/octet-stream',
          ContentRange: `bytes ${range.join('-')}/${stat.size}`, // Mock content range
          Body: stream,
        };
      }

      throw new Error('Missing range');
    }

    throw new Error('Unsupported command');
  }

  stats() {
    return {
      bytesRead: this.bytesRead,
      numberReads: this.numberReads
    }
  }
}
