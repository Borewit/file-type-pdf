[![NPM version](https://img.shields.io/npm/v/@file-type/pdf.svg)](https://npmjs.org/package/@file-type/pdf)
[![Node.js CI](https://github.com/Borewit/file-type-pdf/actions/workflows/nodejs-ci.yml/badge.svg)](https://github.com/Borewit/file-type-pdf/actions/workflows/nodejs-ci.yml)
[![npm downloads](http://img.shields.io/npm/dm/@file-type/pdf.svg)](https://npmcharts.com/compare/@file-type/pdf?start=365)

# @file-type/pdf

Detector plugin for [file-type](https://github.com/sindresorhus/file-type) that identifies
[PDF (Portable Document Format)](https://en.wikipedia.org/wiki/PDF) files and selected PDF-based subtypes.

This plugin goes beyond simple magic-number detection and can inspect the internal PDF
structure to distinguish between generic PDF files and specific producer formats such as
**Adobe Illustrator (.ai)**.

## Scope

This detector is designed for well-formed PDF files and established PDF-based subtypes.
Support for corrupted or non-conforming PDFs is intentionally limited and only considered when a deviation is both common and widely accepted.

## Installation

```bash
npm install @file-type/pdf
```

## Usage

The following example shows how to add the PDF detector to [file-type](https://github.com/sindresorhus/file-type):

```js
import { FileTypeParser } from 'file-type';
import { detectPdf } from '@file-type/pdf';

const parser = new FileTypeParser({
  customDetectors: [detectPdf],
});

const fileType = await parser.fromFile('example.pdf');
console.log(fileType);
```

## Supported file formats

- `.ai` / `application/illustrator`: Adobe Illustrator
- `.pdf` / `application/pdf`: Generic Portable Document Format files

## License

This project is licensed under the [MIT License](LICENSE.txt).
Feel free to use, modify, and distribute it as needed.
