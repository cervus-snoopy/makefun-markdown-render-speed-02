import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { parse } from './parse.js';

// Read every case from /input/cases.json, render each with parse(), and
// write the HTML strings (in case order) to /output/html.json.
// The input is a JSON array of 720 cases. Each case is either a markdown
// string or an object carrying the markdown in `markdown` (falling back
// to `text` / `input` / `source`); a top-level `{ cases: [...] }` wrapper
// is also accepted.
const raw: unknown = JSON.parse(readFileSync('/input/cases.json', 'utf8'));
const items: unknown[] = Array.isArray(raw)
  ? raw
  : (raw !== null && typeof raw === 'object' && Array.isArray((raw as Record<string, unknown>).cases)
    ? ((raw as Record<string, unknown>).cases as unknown[])
    : []);

function toMarkdown(item: unknown): string {
  if (typeof item === 'string') return item;
  if (item !== null && typeof item === 'object') {
    const o = item as Record<string, unknown>;
    const md = o.markdown ?? o.text ?? o.input ?? o.source ?? '';
    return typeof md === 'string' ? md : '';
  }
  return '';
}

const html: string[] = items.map((item) => parse(toMarkdown(item)));

mkdirSync('/output', { recursive: true });
writeFileSync('/output/html.json', JSON.stringify(html));
