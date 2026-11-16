// Entry point for the markdown-render-speed-02 submission.
//
// The grader places the test cases at /input/cases.json and reads the
// rendered HTML from /output/html.json. Each case is a markdown string,
// or an object holding one under `markdown` (with `text`, `input` or
// `source` as fallbacks); the file itself may be a bare array or an
// object with a `cases` array. Every case is rendered with the local
// parse() implementation and the results are written out in order as
// a JSON array of HTML strings.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { parse } from './parse.js';

const INPUT_PATH = '/input/cases.json';
const OUTPUT_PATH = '/output/html.json';

// Pull the markdown text out of one case entry, whatever its shape.
function caseText(entry: unknown): string {
  if (typeof entry === 'string') return entry;
  if (entry !== null && typeof entry === 'object') {
    const fields = entry as Record<string, unknown>;
    const value = fields.markdown ?? fields.text ?? fields.input ?? fields.source;
    return typeof value === 'string' ? value : '';
  }
  return '';
}

// Unwrap the top-level JSON value into the list of case entries.
function caseList(document: unknown): unknown[] {
  if (Array.isArray(document)) return document;
  if (document !== null && typeof document === 'object') {
    const wrapped = (document as Record<string, unknown>).cases;
    if (Array.isArray(wrapped)) return wrapped;
  }
  return [];
}

const document: unknown = JSON.parse(readFileSync(INPUT_PATH, 'utf8'));
const entries = caseList(document);

const rendered: string[] = [];
for (const entry of entries) rendered.push(parse(caseText(entry)));

mkdirSync('/output', { recursive: true });
writeFileSync(OUTPUT_PATH, JSON.stringify(rendered));
