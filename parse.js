// parse.js — drop-in replacement for marked 18.1.3 (default options: gfm,
// breaks false, pedantic false, async false). Written from scratch against
// marked's observable behaviour; output must be byte-identical to marked's
// on every input. MIT license (see LICENSE).
//
// Architecture: a line-based block parser builds a small tree, an inline
// parser (delimiter stack) renders inline content, and renderers emit the
// exact HTML marked emits. No dependencies, no regexes on hot paths where a
// hand scan is cheaper.

// ---------------------------------------------------------------------------
// Part 1 — shared helpers
// ---------------------------------------------------------------------------

function isSpace(c) { return c === 32 || c === 9 || c === 10 || c === 13; }
function isDigit(c) { return c >= 48 && c <= 57; }
function isAlphaNum(c) { return (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122); }
// ASCII punctuation (CommonMark): !"#$%&'()*+,-./:;<=>?@[\]^_`{|}~
function isPunct(c) {
  return (c >= 33 && c <= 47) || (c >= 58 && c <= 64) || (c >= 91 && c <= 96) || (c >= 123 && c <= 126);
}
// Unicode whitespace for emphasis flanking (includes NBSP and other
// Unicode spaces, which ASCII isSpace misses).
function isFlankSpace(c) {
  return c === 32 || c === 9 || c === 10 || c === 13 || c === 11 || c === 12 ||
    c === 0xA0 || c === 0x1680 || (c >= 0x2000 && c <= 0x200A) ||
    c === 0x2028 || c === 0x2029 || c === 0x202F || c === 0x205F ||
    c === 0x3000 || c === 0xFEFF;
}
// Unicode punctuation/symbols for emphasis flanking: ASCII punctuation
// plus Unicode punctuation (P) and symbols (S, incl. currency like £ € $).
// Surrogates (astral halves) are never punctuation here.
const FLANK_PUNCT_RE = /[\p{P}\p{S}]/u;
function isFlankPunct(c) {
  if (c >= 0xD800 && c <= 0xDFFF) return false;
  if (isPunct(c)) return true;
  return FLANK_PUNCT_RE.test(String.fromCharCode(c));
}

// Escape &, <, >, " and ' (the set marked escapes in text and code).
function escapeHtml(s) {
  let out = '', start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    let rep = null;
    if (c === 38) rep = '&amp;';
    else if (c === 60) rep = '&lt;';
    else if (c === 62) rep = '&gt;';
    else if (c === 34) rep = '&quot;';
    else if (c === 39) rep = '&#39;';
    if (rep) { out += s.slice(start, i) + rep; start = i + 1; }
  }
  return start === 0 ? s : out + s.slice(start);
}

// Decode a numeric character reference body (after '&#' or '&#x'), returning
// the replacement character, or null if the body is not a valid numeric ref.
function decodeNumericEntity(body) {
  let n;
  if (body[0] === 'x' || body[0] === 'X') {
    if (body.length === 1) return null;
    n = parseInt(body.slice(1), 16);
    if (isNaN(n)) return null;
  } else {
    if (!/^\d+$/.test(body)) return null;
    n = parseInt(body, 10);
  }
  if (n === 0 || n > 0x10FFFF || (n >= 0xD800 && n <= 0xDFFF)) return '\uFFFD';
  return String.fromCodePoint(n);
}

// Encode a URL the way marked does: control chars dropped, then encodeURI
// percent-encoding (space -> %20, " -> %22, \ -> %5C, non-ASCII as UTF-8),
// then HTML-escape & (unless part of a valid entity) and ' -> &#39;.
function cleanUrl(href) {
  let s = '';
  for (let i = 0; i < href.length; i++) {
    const c = href.charCodeAt(i);
    if (c < 32 || c === 127) continue;
    s += href[i];
  }
  // Encode each segment separately so valid %XX sequences are preserved
  // (encodeURI would re-encode '%' to '%25').
  const parts = s.split(/(%[0-9A-Fa-f]{2})/g);
  let u = '';
  for (const part of parts) {
    if (/^%[0-9A-Fa-f]{2}$/.test(part)) { u += part; continue; }
    try {
      u += encodeURI(part);
    } catch (e) {
      // Lone surrogates make encodeURI throw; replace them and retry.
      u += encodeURI(part.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '\uFFFD'));
    }
  }
  let res = '', start = 0;
  for (let i = 0; i < u.length; i++) {
    const c = u.charCodeAt(i);
    if (c === 38) {
      const m = u.slice(i).match(/^&(#\d{1,7}|#[xX][0-9a-fA-F]{1,6}|[A-Za-z][A-Za-z0-9]*);/);
      if (!m) { res += u.slice(start, i) + '&amp;'; start = i + 1; }
    } else if (c === 39) {
      res += u.slice(start, i) + '&#39;'; start = i + 1;
    }
  }
  return start === 0 ? u : res + u.slice(start);
}

// Escape an HTML attribute value: " ' < > and & (unless & starts a valid
// entity, which is preserved).
function escapeAttr(s) {
  let res = '', start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 38) {
      const m = s.slice(i).match(/^&(#\d{1,7}|#[xX][0-9a-fA-F]{1,6}|[A-Za-z][A-Za-z0-9]*);/);
      if (!m) { res += s.slice(start, i) + '&amp;'; start = i + 1; }
    } else if (c === 34) { res += s.slice(start, i) + '&quot;'; start = i + 1; }
    else if (c === 39) { res += s.slice(start, i) + '&#39;'; start = i + 1; }
    else if (c === 60) { res += s.slice(start, i) + '&lt;'; start = i + 1; }
    else if (c === 62) { res += s.slice(start, i) + '&gt;'; start = i + 1; }
  }
  return start === 0 ? s : res + s.slice(start);
}

// Unescape backslash-escaped ASCII punctuation.
function unescapeStr(s) {
  if (s.indexOf('\\') === -1) return s;
  let out = '';
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) === 92 && i + 1 < s.length && isPunct(s.charCodeAt(i + 1))) { out += s[i + 1]; i++; }
    else out += s[i];
  }
  return out;
}

// Split source into lines; CRLF and lone CR become LF. The final line has
// no terminator.
function splitLines(src) {
  src = src.replace(/\r\n?/g, '\n');
  const lines = src.split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

// Column width of the leading whitespace of `s` (tab = next multiple of 4)
// and the number of leading whitespace characters.
function indentCols(s) {
  let col = 0, i = 0;
  while (i < s.length) {
    const c = s.charCodeAt(i);
    if (c === 32) { col++; i++; }
    else if (c === 9) { col += 4 - (col % 4); i++; }
    else break;
  }
  return { col, i };
}

// Index of the first non-space/tab character (or s.length).
function firstNonSpace(s) {
  let i = 0;
  while (i < s.length && (s.charCodeAt(i) === 32 || s.charCodeAt(i) === 9)) i++;
  return i;
}

function isBlank(s) {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

// Remove `cols` columns of leading whitespace from `s` (tab-aware; a tab
// that straddles the cut becomes spaces).
function stripIndent(s, cols) {
  let col = 0, i = 0;
  while (i < s.length && col < cols) {
    const c = s.charCodeAt(i);
    if (c === 32) { col++; i++; }
    else if (c === 9) {
      const w = 4 - (col % 4);
      if (col + w > cols) return ' '.repeat(col + w - cols) + s.slice(i + 1);
      col += w; i++;
    } else break;
  }
  return s.slice(i);
}

// Normalize a link label: collapse whitespace runs to one space, lowercase.
function normalizeLabel(label) {
  // Unicode case folding: sharp S (both cases) folds to "ss".
  return label.replace(/\s+/g, ' ').trim().toLowerCase().replace(/ß/g, 'ss');
}

// Advance `cols` columns from string index `from` in `line` (tab-aware).
function advanceCols(line, from, cols) {
  // Returns {i, pad}: index after consuming `cols` columns, plus the
  // number of leftover columns when a tab straddles the cut (those
  // columns become spaces, not lost).
  let col = 0, i = from, pad = 0;
  while (i < line.length && col < cols) {
    const c = line.charCodeAt(i);
    if (c === 32) { col++; i++; }
    else if (c === 9) {
      const w = 4 - (col % 4);
      if (col + w > cols) { pad = col + w - cols; i++; break; }
      col += w; i++;
    }
    else break;
  }
  return { i, pad };
}

// ---------------------------------------------------------------------------
// Part 2 — block parsing
// ---------------------------------------------------------------------------

const BLOCK_TAGS = new Set(('address article aside base basefont blockquote body caption center col colgroup dd details dialog dir div dl dt fieldset figcaption figure footer form frame frameset h1 h2 h3 h4 h5 h6 head header hr html iframe legend li link main menu menuitem nav noframes ol optgroup option p param search section summary table tbody td tfoot th thead title tr track ul').split(' '));

// Split a table row on unescaped pipes. Leading/trailing empty cells from
// outer pipes are dropped. Returns the raw cell strings (untrimmed).
function splitRow(line) {
  const cells = [];
  let cur = '';
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '\\' && i + 1 < line.length && line[i + 1] === '|') { cur += '|'; i++; continue; }
    if (c === '|') { cells.push(cur); cur = ''; continue; }
    cur += c;
  }
  cells.push(cur);
  if (cells.length && cells[0].trim() === '') cells.shift();
  if (cells.length && cells[cells.length - 1].trim() === '') cells.pop();
  return cells;
}

// Is this line a GFM table delimiter row? Returns the alignment array
// ('left'|'right'|'center'|null) or null. Delimiter cells are 1+ dashes with
// optional leading/trailing colon.
function parseDelimiterRow(text) {
  const t = text.trim();
  if (!t) return null;
  const cells = splitRow(t);
  if (!cells.length) return null;
  const aligns = [];
  for (const cell of cells) {
    const c = cell.trim();
    if (!/^:?-+:?$/.test(c)) return null;
    aligns.push(c[0] === ':' ? (c[c.length - 1] === ':' ? 'center' : 'left') : (c[c.length - 1] === ':' ? 'right' : null));
  }
  return aligns;
}

// Match a blockquote marker at line[pos..]: up to 3 columns of indent, '>',
// one optional space/tab. Returns the index just past the marker, or -1.
function matchQuote(line, pos) {
  let col = 0, i = pos;
  while (i < line.length) {
    const c = line.charCodeAt(i);
    if (c === 32) { col++; i++; }
    else if (c === 9) { col += 4 - (col % 4); i++; }
    else break;
    if (col > 3) return -1;
  }
  if (col > 3) return -1;
  if (line.charCodeAt(i) !== 62) return -1; // '>'
  i++;
  if (i < line.length && (line.charCodeAt(i) === 32 || line.charCodeAt(i) === 9)) i++;
  return i;
}

// Try to parse a link reference definition starting at lines[li], column col.
// The definition may span lines (destination / title on following lines).
// Returns {dest, title, endLine, endCol} or null.
function tryParseRefDef(lines, li, col) {
  const line = lines[li];
  if (line.charCodeAt(col) !== 91) return null; // '['
  // Scan the label; it may span lines (a newline in the label
  // normalizes to a space when matched).
  let j = col + 1, label = '';
  let labelLine = li;
  let foundClose = false;
  while (true) {
    const curLine = lines[labelLine];
    while (j < curLine.length) {
      const c = curLine.charCodeAt(j);
      // Backslash escapes are kept verbatim in the label (matching the
      // inline link label rule): `bar\\` stays `bar\\`.
      if (c === 92 && j + 1 < curLine.length && isPunct(curLine.charCodeAt(j + 1))) { label += curLine[j] + curLine[j + 1]; j += 2; continue; }
      if (c === 91 || c === 93) break;
      label += curLine[j]; j++;
    }
    if (j < curLine.length && curLine.charCodeAt(j) === 93) { foundClose = true; break; }
    if (j < curLine.length) return null; // hit an unescaped '[' — invalid label
    // End of line without ']' — continue on the next line (not blank).
    if (labelLine + 1 >= lines.length) return null;
    if (lines[labelLine + 1].trim() === '') return null;
    label += '\n';
    labelLine++;
    j = 0;
  }
  if (!foundClose) return null;
  if (label.trim() === '') return null; // empty label
  const rawLabel = label;
  j++; // past ']'
  let cur = labelLine, curCol = j;
  const skipWs = () => {
    while (true) {
      while (curCol < lines[cur].length && (lines[cur].charCodeAt(curCol) === 32 || lines[cur].charCodeAt(curCol) === 9)) curCol++;
      if (curCol < lines[cur].length) return true;
      if (cur + 1 >= lines.length) return false;
      cur++; curCol = 0;
      if (lines[cur].trim() === '') return false;
    }
  };
  if (!skipWs()) return null;
  if (lines[cur].charCodeAt(curCol) !== 58) return null; // ':'
  curCol++;
  if (!skipWs()) return null;
  let dest = '';
  const l2 = lines[cur];
  if (l2.charCodeAt(curCol) === 60) { // '<'
    let k = curCol + 1, ok = false;
    while (k < l2.length) {
      const c = l2.charCodeAt(k);
      if (c === 62) { ok = true; break; }
      if (c === 60 || c === 10) break;
      if (c === 92 && k + 1 < l2.length && isPunct(l2.charCodeAt(k + 1))) { dest += l2[k + 1]; k += 2; continue; }
      dest += l2[k]; k++;
    }
    if (!ok) return null;
    curCol = k + 1;
  } else {
    let depth = 0, k = curCol;
    while (k < l2.length) {
      const c = l2.charCodeAt(k);
      if (c === 32 || c === 9) break;
      if (c === 92 && k + 1 < l2.length && isPunct(l2.charCodeAt(k + 1))) { dest += l2[k + 1]; k += 2; continue; }
      if (c === 40) depth++;
      else if (c === 41) { if (depth === 0) break; depth--; }
      else if (c < 32) break;
      dest += l2[k]; k++;
    }
    if (k === curCol) return null;
    if (depth !== 0) return null;
    curCol = k;
  }
  let title = null;
  const saveCur = cur, saveCol = curCol;
  let tcur = cur, tcol = curCol;
  // A title must be separated from the destination by whitespace (spaces,
  // tabs, or a newline). `<bar>(baz)` is not a title — no whitespace.
  let hadWs = false;
  while (tcol < lines[tcur].length && (lines[tcur].charCodeAt(tcol) === 32 || lines[tcur].charCodeAt(tcol) === 9)) { tcol++; hadWs = true; }
  if (tcol >= lines[tcur].length && tcur + 1 < lines.length && lines[tcur + 1].trim() !== '') {
    tcur++; tcol = 0; hadWs = true;
    while (tcol < lines[tcur].length && (lines[tcur].charCodeAt(tcol) === 32 || lines[tcur].charCodeAt(tcol) === 9)) tcol++;
  }
  const tl = lines[tcur];
  const qc = tl.charCodeAt(tcol);
  if (hadWs && (qc === 34 || qc === 39 || qc === 40)) {
    const close = qc === 40 ? 41 : qc;
    // A title may span lines; newlines inside it are kept.
    let t = '', ok = false;
    let scanLine = tcur, scanCol = tcol + 1;
    while (true) {
      const curText = lines[scanLine];
      while (scanCol < curText.length) {
        const c = curText.charCodeAt(scanCol);
        if (c === 92 && scanCol + 1 < curText.length && isPunct(curText.charCodeAt(scanCol + 1))) { t += curText[scanCol + 1]; scanCol += 2; continue; }
        if (c === close) { ok = true; break; }
        t += curText[scanCol]; scanCol++;
      }
      if (ok) break;
      if (scanLine + 1 >= lines.length) break;
      if (lines[scanLine + 1].trim() === '') break;
      t += '\n';
      scanLine++; scanCol = 0;
    }
    if (ok) {
      let m = scanCol + 1;
      const endText = lines[scanLine];
      while (m < endText.length && (endText.charCodeAt(m) === 32 || endText.charCodeAt(m) === 9)) m++;
      if (m >= endText.length) { title = t; cur = scanLine; curCol = m; }
      else { cur = saveCur; curCol = saveCol; }
    } else { cur = saveCur; curCol = saveCol; }
  }
  let m = curCol;
  while (m < lines[cur].length && (lines[cur].charCodeAt(m) === 32 || lines[cur].charCodeAt(m) === 9)) m++;
  if (m < lines[cur].length) return null;
  return { dest, title, endLine: cur, endCol: m, label: rawLabel };
}

// Does the text (after container markers) start a new block? Used for the
// lazy-continuation decision and for table body termination. Returns the
// block kind or null. Indented code and HTML type 7 cannot interrupt a
// paragraph, so they return null here.
function blockStartKind(text, paraInterrupt) {
  const { col, i } = indentCols(text);
  if (i >= text.length) return null;
  const rest = text.slice(i);
  if (col >= 4) return null;
  const c0 = rest.charCodeAt(0);
  if (c0 === 35) {
    let n = 0; while (n < rest.length && rest.charCodeAt(n) === 35) n++;
    if (n >= 1 && n <= 6 && (n === rest.length || rest.charCodeAt(n) === 32 || rest.charCodeAt(n) === 9)) return 'atx';
    return null;
  }
  if (c0 === 96 || c0 === 126) {
    let n = 0; while (n < rest.length && rest.charCodeAt(n) === c0) n++;
    if (n >= 3) {
      if (c0 === 96 && rest.slice(n).indexOf('`') !== -1) return null;
      return 'fence';
    }
    return null;
  }
  if (c0 === 42 || c0 === 95 || c0 === 45) {
    const s = rest.replace(/[ \t]/g, '');
    if (s.length >= 3) {
      const ch = s[0];
      let ok = true; for (let k = 0; k < s.length; k++) if (s[k] !== ch) { ok = false; break; }
      if (ok) return 'hr';
    }
  }
  if (c0 === 45 || c0 === 43 || c0 === 42) {
    if (rest.length === 1 || rest.charCodeAt(1) === 32 || rest.charCodeAt(1) === 9) {
      // An empty list item (marker with no content) cannot interrupt a
      // paragraph (`foo\n*` stays one paragraph).
      if (paraInterrupt) {
        let q = 1;
        while (q < rest.length && (rest.charCodeAt(q) === 32 || rest.charCodeAt(q) === 9)) q++;
        if (q >= rest.length) return null;
      }
      return 'list';
    }
    return null;
  }
  if (isDigit(c0)) {
    let n = 0; while (n < rest.length && isDigit(rest.charCodeAt(n))) n++;
    if (n >= 1 && n <= 9 && (rest.charCodeAt(n) === 46 || rest.charCodeAt(n) === 41) && (n + 1 === rest.length || rest.charCodeAt(n + 1) === 32 || rest.charCodeAt(n + 1) === 9)) {
      // An ordered list can interrupt a paragraph only if it starts with 1.
      if (paraInterrupt && parseInt(rest.slice(0, n), 10) !== 1) return null;
      // An empty ordered item cannot interrupt a paragraph either.
      if (paraInterrupt) {
        let q = n + 1;
        while (q < rest.length && (rest.charCodeAt(q) === 32 || rest.charCodeAt(q) === 9)) q++;
        if (q >= rest.length) return null;
      }
      return 'list';
    }
    return null;
  }
  if (c0 === 60) {
    const lower = rest.toLowerCase();
    if (lower.startsWith('<!--') || lower.startsWith('<?') || lower.startsWith('<![cdata[')) return 'html';
    if (/^<![a-z]/i.test(rest)) return 'html';
    const m = lower.match(/^<\/?([a-z][a-z0-9-]*)(\s|\/?>|$)/);
    if (m) {
      const tag = m[1];
      if (tag === 'script' || tag === 'pre' || tag === 'style' || tag === 'textarea') return 'html';
      if (BLOCK_TAGS.has(tag)) return 'html';
    }
    return null;
  }
  if (c0 === 62) return 'quote';
  return null;
}

function isThematicBreak(content) {
  const s = content.replace(/[ \t]+/g, '');
  if (s.length < 3) return false;
  const ch = s[0];
  if (ch !== '*' && ch !== '_' && ch !== '-') return false;
  for (let k = 0; k < s.length; k++) if (s[k] !== ch) return false;
  return true;
}

// Match an HTML block start. Returns {type, end} or null. Type 7 is a
// complete tag alone on the line (single line, cannot interrupt a paragraph).
function matchHtmlStart(content, ind) {
  if (ind > 3 || content.charCodeAt(0) !== 60) return null;
  const lower = content.toLowerCase();
  const m1 = lower.match(/^<(script|pre|style|textarea)([\s>]|$)/);
  if (m1) return { type: 1, end: '</' + m1[1] + '>' };
  if (lower.startsWith('<!--')) return { type: 2, end: '-->' };
  if (lower.startsWith('<?')) return { type: 3, end: '?>' };
  if (/^<![a-z]/i.test(content)) return { type: 4, end: '>' };
  if (lower.startsWith('<![cdata[')) return { type: 5, end: ']]>' };
  const m6 = lower.match(/^<\/?([a-z][a-z0-9-]*)(\s|\/?>|$)/);
  if (m6 && BLOCK_TAGS.has(m6[1])) return { type: 6, end: null };
  // Type 7: a complete open/closing tag alone on the line. The tag must
  // be well-formed (valid attribute names/values); a malformed tag such
  // as `<a h*#ref="hi">` is not an HTML block at all. A closing tag
  // takes no attributes (`</a href="foo">` is not a tag).
  if (/^(?:<[A-Za-z][A-Za-z0-9-]*(?:\s+[A-Za-z_:][A-Za-z0-9_.:-]*(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*\s*\/?>|<\/[A-Za-z][A-Za-z0-9-]*\s*>)[ \t]*$/.test(content)) return { type: 7, end: null };
  return null;
}

// Match a list item start in `content` (indent already stripped, indent
// columns `ind`). Returns {ordered, marker, markerLen, start} or null.
function matchListStart(content, ind) {
  if (ind > 3) return null;
  const c0 = content.charCodeAt(0);
  if (c0 === 45 || c0 === 43 || c0 === 42) {
    if (content.length === 1 || content.charCodeAt(1) === 32 || content.charCodeAt(1) === 9) {
      return { ordered: false, marker: content[0], markerLen: 1, after: 1, start: 1 };
    }
    return null;
  }
  if (isDigit(c0)) {
    let n = 0; while (n < content.length && isDigit(content.charCodeAt(n))) n++;
    if (n >= 1 && n <= 9 && (content.charCodeAt(n) === 46 || content.charCodeAt(n) === 41) &&
        (n + 1 === content.length || content.charCodeAt(n + 1) === 32 || content.charCodeAt(n + 1) === 9)) {
      return { ordered: true, marker: content[n], markerLen: n + 1, after: n + 1, start: parseInt(content.slice(0, n), 10) };
    }
  }
  return null;
}

class BlockParser {
  constructor(lines) {
    this.lines = lines;
    this.refs = new Map();
    this.root = { t: 'doc', children: [] };
    this.stack = [this.root];
    this.i = 0;
  }

  tip() { return this.stack[this.stack.length - 1]; }

  closeTo(depth) {
    while (this.stack.length > depth + 1) {
      const b = this.stack.pop();
      if (b.t === 'para') this.closeParaNode(b);
      else if (b.t === 'code') this.finishCode(b);
      else if (b.t === 'html') this.finishHtml(b);
    }
  }
  // Finish a paragraph; a defs-only paragraph (no text lines) is removed
  // from its parent instead of rendering.
  closeParaNode(b) {
    while (b.lines.length && b.lines[b.lines.length - 1] === '') b.lines.pop();
    if (b.lines.length === 0) {
      const parent = this.tip();
      const idx = parent.children.indexOf(b);
      if (idx !== -1) parent.children.splice(idx, 1);
      return;
    }
    b.text = b.lines.join('\n');
    delete b.lines; delete b.onlyDefs;
  }
  finishPara(b) {
    this.closeParaNode(b);
  }
  finishCode(b) {
    if (b.fenced) {
      // Fenced: drop exactly one trailing blank line (the line before
      // the closing fence); further blank lines are content.
      if (b.lines.length && b.lines[b.lines.length - 1] === '') b.lines.pop();
    } else {
      // Indented: strip all trailing blank lines.
      while (b.lines.length && b.lines[b.lines.length - 1] === '') b.lines.pop();
    }
    b.text = b.lines.join('\n') + (b.lines.length ? '\n' : '');
    delete b.lines;
  }
  finishHtml(b) {
    b.text = b.lines.join('\n');
    // Types 1-5 end at a marker line. A newline follows the block only
    // when the line after the marker is non-blank: a blank line after
    // the block produces none, and at EOF the document-level rule
    // decides. (finishHtml runs while `i` still points at the marker
    // line, so the following line is lines[i + 1].)
    if (b.htmlType >= 1 && b.htmlType <= 5 && b.text && !b.text.endsWith('\n')) {
      const next = this.lines[this.i + 1];
      if (next !== undefined && next.trim() !== '') b.text += '\n';
    }
    delete b.lines;
  }
  openBlock(b) {
    this.loosenCheck();
    this.tip().children.push(b);
    this.stack.push(b);
    return b;
  }
  // A blank line is pending in the innermost open item; if a new block now
  // starts there and the item already has content, the enclosing list is
  // loose. (A blank after an empty item, or at the end of a list, does not
  // loosen it.) The pending flag is consumed here, on every open
  // list/item, so one blank line cannot loosen two lists.
  loosenCheck() {
    for (let k = this.stack.length - 1; k >= 1; k--) {
      const n = this.stack[k];
      if (n.t === 'item') {
        if (n._blankPending && n.children.length > 0) {
          for (let j = k - 1; j >= 1; j--) {
            if (this.stack[j].t === 'list') { this.stack[j].tight = false; break; }
          }
        }
        break;
      }
    }
    for (let k = 1; k < this.stack.length; k++) {
      const n = this.stack[k];
      if (n.t === 'list' || n.t === 'item') n._blankPending = false;
    }
  }
  closePara() {
    if (this.tip().t === 'para') { const b = this.stack.pop(); this.closeParaNode(b); }
  }

  // Total content-indent (sum of list-item C) of the open containers.
  totalItemIndent() {
    let total = 0;
    for (let k = 1; k < this.stack.length; k++) if (this.stack[k].t === 'item') total += this.stack[k].contentIndent;
    return total;
  }

  // Add a continuation line to the open paragraph. `rest` is the line after
  // the container walk; `cUnmatched` is the item indent the walk did not
  // strip (0 for a normal line); `lazy` is whether the walk failed; and
  // `innermostIsItem` is whether the deepest matched container is an item.
  // Rule (verified against marked on 60+ probes): strip the unmatched item
  // indent when the remaining indent covers it, then strip one 4-column
  // code-indent when the remainder is >= 4 and the line is lazy or the
  // innermost matched container is a list item.
  addParaLine(rest, cUnmatched, lazy, innermostIsItem) {
    let s = rest;
    const { col: r0 } = indentCols(s);
    if (cUnmatched > 0 && r0 >= cUnmatched) s = stripIndent(s, cUnmatched);
    const { col: r1 } = indentCols(s);
    if ((lazy || innermostIsItem) && r1 >= 4) s = stripIndent(s, 4);
    // Lazy setext-lookalike line inside a quote, after a lazy line: marked
    // indents it to exactly 4 spaces (verified on `> foo\nbar\n===` etc.).
    const p = this.tip();
    if (lazy && p._hasLazy && /^ {0,3}(=+|-+)[ \t]*$/.test(s)) {
      let inQuote = false;
      for (let k = 0; k < this.stack.length; k++) if (this.stack[k].t === 'quote') { inQuote = true; break; }
      if (inQuote) s = '    ' + s.replace(/^[ \t]+/, '');
    }
    p.lines.push(s);
    if (lazy) p._hasLazy = true;
    // A non-lazy continuation line (matching the containers) anchors the
    // paragraph: a later indent-0 line then closes it instead of lazily
    // continuing it (verified: multi-line para + indent-0 line closes
    // the lists, single-line or lazy-continued para stays lazy).
    else if (p.lines.length > 1) p._hasMatchingCont = true;
  }

  parse() {
    const lines = this.lines;
    while (this.i < lines.length) {
      const line = lines[this.i];
      // ---- container matching ----
      let off = 0, matched = 0, failedAt = -1;
      let matchedItemCols = 0; // item indent stripped by the walk
      let hasQuote = false; // the line carried a `>` marker
      let pad = ''; // spaces from tabs straddled by an item-indent cut
      for (let k = 1; k < this.stack.length; k++) {
        const node = this.stack[k];
        if (node.t === 'quote') {
          const r = matchQuote(line, off);
          if (r === -1) { failedAt = k; break; }
          off = r; matched = k; hasQuote = true;
        } else if (node.t === 'list') {
          matched = k;
        } else if (node.t === 'item') {
          if (isBlank(line.slice(off))) { matched = k; }
          else {
            const { col } = indentCols(line.slice(off));
            if (col >= node.contentIndent) {
              const adv = advanceCols(line, off, node.contentIndent);
              off = adv.i;
              if (adv.pad > 0) pad += ' '.repeat(adv.pad);
              matchedItemCols += node.contentIndent;
              matched = k;
            } else { failedAt = k; break; }
          }
        } else break; // leaf
      }
      const allMatched = failedAt === -1;
      const rest = pad + line.slice(off);
      const blank = isBlank(rest);

      if (blank) {
        if (!allMatched) this.closeTo(matched);
        const t = this.tip();
        // A quote line carrying only spaces (`>  `) is a paragraph
        // continuation holding those spaces, not a blank line: the
        // paragraph keeps the spaces as its last line.
        if (hasQuote && rest.length > 0 && t.t === 'para') {
          const innermostIsItem = this.stack.length > 1 && this.stack[this.stack.length - 2].t === 'item';
          this.addParaLine(rest, 0, false, innermostIsItem);
          this.i++; continue;
        }
        // A blank line inside a fenced code block keeps its whitespace
        // (it is code content, minus the fence indent); inside an
        // indented block it keeps the line minus the 4-column indent.
        if (t.t === 'code') {
          if (t.fenced) t.lines.push(t.fenceIndent > 0 ? stripIndent(rest, t.fenceIndent) : rest);
          else t.lines.push(stripIndent(rest, 4));
          this.i++; continue;
        }
        // HTML types 1-5 end at a marker, not a blank line: the blank
        // line is part of the raw content.
        if (t.t === 'html' && t.htmlType >= 1 && t.htmlType <= 5) { t.lines.push(''); this.i++; continue; }
        // Only HTML types 6 and 7 end at a blank line; types 1-5 end at
        // their marker and may contain blank lines.
        if (t.t === 'html' && (t.htmlType === 6 || t.htmlType === 7)) {
          const b = this.stack.pop(); this.finishHtml(b);
        }
        if (this.tip().t === 'table') this.stack.pop();
        if (this.tip().t === 'para') this.closePara();
        // A blank line inside a list/item is pending looseness: the next
        // item or block in that context makes the list loose. (The flag
        // is consumed once, by loosenCheck, so one blank cannot loosen
        // two lists.) A line carrying a `>` marker (e.g. `  >`) is a
        // blockquote line with empty content: it marks the ITEM (so a
        // following block in the same item loosens the list) but not the
        // LIST (so a following new item does not loosen it).
        for (let k = 1; k < this.stack.length; k++) {
          const n = this.stack[k];
          if (n.t === 'item') n._blankPending = true;
          else if (n.t === 'list' && !hasQuote) n._blankPending = true;
        }
        this.i++; continue;
      }

      const t = this.tip();

      // ---- leaf blocks that consume raw lines ----
      if (allMatched && t.t === 'code' && t.fenced) {
        const m = rest.match(/^( {0,3})(`{3,}|~{3,})[ \t]*$/);
        if (m && m[2][0] === t.fenceChar && m[2].length >= t.fenceLen) {
          const b = this.stack.pop(); this.finishCode(b);
        } else {
          // Content lines lose up to the opening fence's indent.
          t.lines.push(t.fenceIndent > 0 ? stripIndent(rest, t.fenceIndent) : rest);
        }
        this.i++; continue;
      }
      if (allMatched && t.t === 'code' && !t.fenced) {
        const { col } = indentCols(rest);
        if (col >= 4) { t.lines.push(stripIndent(rest, 4)); this.i++; continue; }
        const b = this.stack.pop(); this.finishCode(b);
        // fall through: reprocess the line at the new tip
      } else if (allMatched && t.t === 'html') {
        t.lines.push(rest);
        if (t.htmlEnd && rest.toLowerCase().includes(t.htmlEnd)) {
          const b = this.stack.pop(); this.finishHtml(b);
        }
        this.i++; continue;
      } else if (allMatched && t.t === 'table') {
        if (blockStartKind(rest) !== null) {
          this.stack.pop();
          // fall through: reprocess the line at the new tip
        } else {
          const cells = splitRow(rest.trim());
          const row = [];
          for (let k = 0; k < t.aligns.length; k++) row.push(k < cells.length ? cells[k].trim() : '');
          t.rows.push(row);
          this.i++; continue;
        }
      }

      // ---- paragraph tip ----
      if (this.tip().t === 'para') {
        const p = this.tip();
        // Setext underline and table delimiter rows only apply when the
        // line matches the paragraph's containers. A lazy line (one that
        // does not match the containers) never forms a setext underline or
        // a table delimiter; the containers close instead.
        if (allMatched && p.lines.length > 0) {
          const sm = rest.match(/^ {0,3}(=+|-+)[ \t]*$/);
          if (sm) {
            const level = sm[1][0] === '=' ? 1 : 2;
            const parent = this.stack[this.stack.length - 2];
            this.stack.pop();
            this.finishPara(p);
            // The paragraph is replaced by the heading: remove it.
            const pidx = parent.children.indexOf(p);
            if (pidx !== -1) parent.children.splice(pidx, 1);
            const hText = p.text.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
            const h = { t: 'heading', level, text: hText, children: [] };
            this.tip().children.push(h);
            this.i++; continue;
          }
        }
        // Table delimiter row: the paragraph's last line is the header.
        // The delimiter line must be indented by at most 3 columns.
        if (allMatched && p.lines.length > 0 && indentCols(rest).col <= 3) {
          const aligns = parseDelimiterRow(rest);
          if (aligns) {
            const headerCells = splitRow(p.lines[p.lines.length - 1].trim());
            if (headerCells.length === aligns.length) {
              p.lines.pop();
              const parent = this.stack[this.stack.length - 2];
              this.stack.pop(); // the paragraph
              if (p.lines.length) this.finishPara(p);
              else {
                // Paragraph was only the header: remove it from its parent.
                const idx = parent.children.indexOf(p);
                if (idx !== -1) parent.children.splice(idx, 1);
              }
              const table = { t: 'table', aligns, header: headerCells.map((c) => c.trim()), rows: [], children: [] };
              this.tip().children.push(table);
              this.stack.push(table);
              this.i++; continue;
            }
          }
        }
        // Link reference definitions, while the paragraph is defs-only.
        if (p.onlyDefs) {
          const { col: c0, i: ci } = indentCols(rest);
          if (c0 <= 3) {
            const d = tryParseRefDef(lines, this.i, off + ci);
            if (d) {
              const key = normalizeLabel(d.label);
              if (!this.refs.has(key)) this.refs.set(key, { dest: d.dest, title: d.title });
              if (d.endCol < lines[d.endLine].length) {
                p.lines.push(lines[d.endLine].slice(d.endCol).replace(/^[ \t]+/, ''));
                p.onlyDefs = false;
              }
              this.i = d.endLine + 1;
              continue;
            }
          }
          p.onlyDefs = false;
        }
        // A line starting a new block closes the paragraph (it is not a
        // continuation). Indented code and HTML type 7 cannot interrupt.
        // An ordered list can interrupt only if it starts with 1 — but
        // only when the line matches the paragraph's containers; a lazy
        // line (not matching) always closes the paragraph, since it is at
        // an outer level (e.g. the next item of the enclosing list).
        if (blockStartKind(rest, allMatched) !== null) {
          this.closePara();
          continue; // reprocess the line (do not advance i)
        }
        if (allMatched) {
          const innermostIsItem = this.stack.length > 1 && this.stack[this.stack.length - 2].t === 'item';
          this.addParaLine(rest, 0, false, innermostIsItem);
          this.i++; continue;
        }
        // Lazy continuation (blockStartKind is null here, checked above).
        // Exception: a paragraph anchored by a matching continuation
        // line, inside a triply-nested list item, is closed by an
        // indent-0 line (it is a new top-level block, not a lazy
        // continuation). Depth 1-2 stays lazy.
        const tipPara = this.tip();
        let itemDepth = 0;
        for (let k = 1; k < this.stack.length; k++) if (this.stack[k].t === 'item') itemDepth++;
        if (tipPara._hasMatchingCont && itemDepth >= 3 && indentCols(line).col === 0) {
          this.closePara();
          continue; // reprocess the line at the outer level
        }
        const cTotal = this.totalItemIndent();
        const cUnmatched = cTotal - matchedItemCols;
        const innermostIsItem = this.stack.length > 1 && this.stack[this.stack.length - 2].t === 'item';
        this.addParaLine(rest, cUnmatched, true, innermostIsItem);
        this.i++; continue;
      }

      // ---- not a paragraph tip: close unmatched containers, then start ----
      if (!allMatched) { this.closeTo(matched); continue; }

      const { col: ind, i: ci } = indentCols(rest);
      const content = rest.slice(ci);
      // A list can only contain list items. If the tip is a list and this
      // line does not start an item of this list, close the list and
      // reprocess the line at the outer level.
      if (this.tip().t === 'list') {
        const ls0 = matchListStart(content, ind);
        const lst = this.tip();
        // A thematic break beats a list item (`* * *` is an <hr>, not an
        // item, even though it also parses as a bullet item).
        const isHr = ind <= 3 && isThematicBreak(content);
        if (isHr || !ls0 || ls0.ordered !== lst.ordered || ls0.marker !== lst.delim) {
          this.stack.pop();
          continue;
        }
      }
      // ATX heading
      if (content.charCodeAt(0) === 35) {
        let n = 0; while (n < content.length && content.charCodeAt(n) === 35) n++;
        if (n >= 1 && n <= 6 && ind <= 3 && (n === content.length || content.charCodeAt(n) === 32 || content.charCodeAt(n) === 9)) {
          let text = content.slice(n).replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
          // Strip a closing sequence: a run of #s at the end, preceded by a
          // space, or the entire content.
          if (/^#+$/.test(text)) text = '';
          else text = text.replace(/[ \t]+#+$/, '');
          const h = { t: 'heading', level: n, text, children: [] };
          this.tip().children.push(h);
          this.i++; continue;
        }
      }
      // Fenced code
      if (content.charCodeAt(0) === 96 || content.charCodeAt(0) === 126) {
        const fch = content[0];
        let n = 0; while (n < content.length && content.charCodeAt(n) === fch.charCodeAt(0)) n++;
        if (n >= 3 && ind <= 3) {
          const info = content.slice(n);
          if (!(fch === '`' && info.indexOf('`') !== -1)) {
            const code = { t: 'code', fenced: true, fenceChar: fch, fenceLen: n, info: info.trim(), fenceIndent: ind, lines: [], children: [] };
            this.openBlock(code);
            this.i++; continue;
          }
        }
      }
      // HTML block
      const htmlStart = matchHtmlStart(content, ind);
      if (htmlStart) {
        // If the first line already contains the end marker, the block is
        // complete on this line. Types 1-5 end with a newline (as in
        // finishHtml) — unless the next line is blank, in which case the
        // blank line is the separator and no newline is added. Types 6-7
        // carry none.
        if (htmlStart.end && rest.toLowerCase().includes(htmlStart.end)) {
          const nextBlank = this.i + 1 >= lines.length || isBlank(lines[this.i + 1]);
          const txt = (htmlStart.type >= 1 && htmlStart.type <= 5 && !nextBlank) ? rest + '\n' : rest;
          this.tip().children.push({ t: 'html', htmlType: htmlStart.type, text: txt, children: [] });
          this.i++; continue;
        }
        // Types 6 and 7 continue until a blank line; types 1-5 until the
        // end marker. All are stack blocks so later lines accumulate.
        const html = { t: 'html', htmlType: htmlStart.type, htmlEnd: htmlStart.end || null, lines: [rest], children: [] };
        this.openBlock(html);
        this.i++; continue;
      }
      // Thematic break
      if (ind <= 3 && isThematicBreak(content)) { this.tip().children.push({ t: 'hr', children: [] }); this.i++; continue; }
      // Blockquote
      if (matchQuote(rest, 0) !== -1) {
        const quote = { t: 'quote', children: [] };
        this.openBlock(quote);
        continue; // reprocess the line inside the quote (do not advance i)
      }
      // List item
      const ls = matchListStart(content, ind);
      if (ls) {
        this.startListItem(ls, off, ci);
        continue; // startListItem advances i or rewrites the line
      }
      // Indented code
      if (ind >= 4) {
        const code = { t: 'code', fenced: false, lines: [stripIndent(rest, 4)], children: [] };
        this.openBlock(code);
        this.i++; continue;
      }
      // Paragraph (or link reference definitions at its start).
      const para = { t: 'para', lines: [], onlyDefs: true, children: [] };
      this.openBlock(para);
      if (ind <= 3) {
        const d = tryParseRefDef(lines, this.i, off + ci);
        if (d) {
          const key = normalizeLabel(d.label);
          if (!this.refs.has(key)) this.refs.set(key, { dest: d.dest, title: d.title });
          if (d.endCol < lines[d.endLine].length) {
            para.lines.push(lines[d.endLine].slice(d.endCol).replace(/^[ \t]+/, ''));
            para.onlyDefs = false;
          }
          this.i = d.endLine + 1;
          if (para.lines.length === 0) {
            this.stack.pop();
            const parentChildren = this.tip().children;
            const pidx = parentChildren.indexOf(para);
            if (pidx !== -1) parentChildren.splice(pidx, 1);
            continue;
          }
          continue;
        }
      }
      para.onlyDefs = false;
      const innermostIsItem = this.stack.length > 1 && this.stack[this.stack.length - 2].t === 'item';
      this.addParaLine(rest, 0, false, innermostIsItem);
      this.i++;
    }
    this.closeTo(0);
    return { root: this.root, refs: this.refs };
  }

  // Start a list item for the line at this.i (already container-matched,
  // `off` = index past the outer containers, `ci` = indent chars in rest).
  // Non-empty items: rewrite the line so the remainder is reprocessed inside
  // the new item (prefix preserved, content indent inserted). Empty items:
  // push the item and advance.
  startListItem(ls, off, ci) {
    // A blank between items of this list loosens it. Capture the flag
    // now: loosenCheck() below clears pending flags (a blank is
    // consumed once), and the previous item may already be popped, so
    // this list's flag is the only record of the blank.
    const tip0 = this.tip();
    const listPending = (tip0.t === 'list' && tip0.ordered === ls.ordered && tip0.delim === ls.marker) ? tip0._blankPending : false;
    this.loosenCheck();
    const line = this.lines[this.i];
    let q = off + ci + ls.markerLen;
    const baseIndent = indentCols(line.slice(off)).col;
    let col = baseIndent + ls.markerLen;
    let spaces = 0;
    while (q < line.length && (line.charCodeAt(q) === 32 || line.charCodeAt(q) === 9)) {
      if (line.charCodeAt(q) === 32) { spaces++; col++; q++; }
      else { const w = 4 - (col % 4); spaces += w; col += w; q++; }
    }
    const isEmpty = q >= line.length;
    // Content indent is the absolute column where the content starts: the
    // leading indent + marker + spaces (1-4 spaces), or leading indent +
    // marker + 1 when there are 5+ spaces or the item is empty.
    const contentIndent = isEmpty
      ? baseIndent + ls.markerLen + 1
      : (spaces >= 5 ? baseIndent + ls.markerLen + 1 : col);
    const t = this.tip();
    let list = null;
    if (t.t === 'list' && t.ordered === ls.ordered && t.delim === ls.marker) list = t;
    if (!list) {
      list = { t: 'list', ordered: ls.ordered, delim: ls.marker, start: ls.ordered ? ls.start : 1, tight: true, children: [] };
      this.tip().children.push(list);
      this.stack.push(list);
    }
    // Loose detection: a pending blank inside this list loosens it.
    if (listPending && list.children.length) list.tight = false;
    list._blankPending = false;
    const item = { t: 'item', contentIndent, children: [] };
    list.children.push(item);
    this.stack.push(item);
    if (isEmpty) {
      this.i++;
      return;
    }
    // Rewrite the line: outer prefix + contentIndent spaces + remainder.
    this.lines[this.i] = line.slice(0, off) + ' '.repeat(contentIndent) + line.slice(q);
    // Do not advance i: the rewritten line is reprocessed inside the item.
  }
}

// ---------------------------------------------------------------------------
// Part 3 — inline parsing
// ---------------------------------------------------------------------------

// Render a delimiter record to its current string. A record is used as an
// opener (literal chars, then open tags, outermost first) and/or as a closer
// (close tags, then literal chars). Unused chars stay literal.
function renderDelim(d) {
  return d.closeTags.join('') + d.lit + d.openTags.join('');
}

function updateDelimOut(out, d) {
  out[d.idx] = renderDelim(d);
}

// Can this delimiter run open emphasis? (left-flanking, with the `_` rule)
function delimCanOpen(char, before, after) {
  const beforeWS = before === null || isFlankSpace(before.charCodeAt(0));
  const afterWS = after === null || isFlankSpace(after.charCodeAt(0));
  const beforePunct = before !== null && isFlankPunct(before.charCodeAt(0));
  const afterPunct = after !== null && isFlankPunct(after.charCodeAt(0));
  const leftFlanking = !afterWS && (!afterPunct || beforeWS || beforePunct);
  const rightFlanking = !beforeWS && (!beforePunct || afterWS || afterPunct);
  if (char === '_') {
    return leftFlanking && (!rightFlanking || beforePunct);
  }
  return leftFlanking;
}
function delimCanClose(char, before, after) {
  const beforeWS = before === null || isFlankSpace(before.charCodeAt(0));
  const afterWS = after === null || isFlankSpace(after.charCodeAt(0));
  const beforePunct = before !== null && isFlankPunct(before.charCodeAt(0));
  const afterPunct = after !== null && isFlankPunct(after.charCodeAt(0));
  const leftFlanking = !afterWS && (!afterPunct || beforeWS || beforePunct);
  const rightFlanking = !beforeWS && (!beforePunct || afterWS || afterPunct);
  if (char === '_') {
    return rightFlanking && (!leftFlanking || afterPunct);
  }
  return rightFlanking;
}

// Parse a link destination starting at `i` in `s`. Returns {dest, next} or
// null. `next` is the index just past the destination.
function parseLinkDest(s, i) {
  while (i < s.length && (s.charCodeAt(i) === 32 || s.charCodeAt(i) === 9 || s.charCodeAt(i) === 10)) i++;
  if (i >= s.length) return null;
  if (s.charCodeAt(i) === 60) { // '<'
    let j = i + 1, dest = '';
    while (j < s.length) {
      const c = s.charCodeAt(j);
      if (c === 62) return { dest, next: j + 1 }; // '>'
      if (c === 60 || c === 10) return null;
      if (c === 92 && j + 1 < s.length && isPunct(s.charCodeAt(j + 1))) { dest += s[j + 1]; j += 2; continue; }
      dest += s[j]; j++;
    }
    return null;
  }
  let depth = 0, j = i, dest = '';
  while (j < s.length) {
    const c = s.charCodeAt(j);
    if (c === 32 || c === 9 || c < 32) break;
    if (c === 92 && j + 1 < s.length && isPunct(s.charCodeAt(j + 1))) { dest += s[j + 1]; j += 2; continue; }
    if (c === 40) depth++;
    else if (c === 41) { if (depth === 0) break; depth--; }
    dest += s[j]; j++;
  }
  // An empty destination (e.g. `[link]()`) is valid; only unbalanced
  // parens reject it.
  if (depth !== 0) return null;
  return { dest, next: j };
}

// Parse a link title starting at `i` in `s`. Returns {title, next} or null.
function parseLinkTitle(s, i) {
  while (i < s.length && (s.charCodeAt(i) === 32 || s.charCodeAt(i) === 9)) i++;
  if (i >= s.length) return null;
  const q = s.charCodeAt(i);
  if (q !== 34 && q !== 39 && q !== 40) return null;
  const close = q === 40 ? 41 : q;
  let j = i + 1, title = '';
  while (j < s.length) {
    const c = s.charCodeAt(j);
    if (c === 92 && j + 1 < s.length && isPunct(s.charCodeAt(j + 1))) { title += s[j + 1]; j += 2; continue; }
    if (c === close) return { title, next: j + 1 };
    if (c === 10) return null;
    title += s[j]; j++;
  }
  return null;
}

// Inline parser. `text` is a single block's text (paragraph, heading, table
// cell). `refs` is the document's link reference map. Returns the HTML.
//
// Sticky regexes for the per-character autolink/entity checks. Using the
// `y` flag with an explicit lastIndex avoids `text.slice(i)` (which copies
// the rest of the string on every alphanumeric character — O(n^2)).
const ENTITY_RE = /&#([0-9]{1,7});|&#[xX]([0-9a-fA-F]{1,6});|&([A-Za-z][A-Za-z0-9]*);/y;
const WWW_RE = /www\.[\w-]+(\.[\w-]+)*(:\d+)?(\/[^\s<]*)?/y;
const SCHEME_SLASH_RE = /[A-Za-z][A-Za-z0-9+.-]{1,31}:\/\/[^\s<]+/y;
const SCHEME_RE = /([A-Za-z][A-Za-z0-9+.-]{1,31}):([^\s<]+)/y;
const EMAIL_RE = /[A-Za-z0-9.!#$%&'*+\/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*/y;
// Fast path: no inline-markup trigger at all — just HTML-escape.
const PLAIN_RE = /[*_`\[\]!<&\\~@]|www\.|:\/\//;

function parseInline(text, refs) {
  // Fast path: no inline-markup trigger and no hard break — just escape.
  if (!PLAIN_RE.test(text) && !/[ \t]{2,}\n/.test(text)) return escapeHtml(text);
  const out = [];       // chunks: strings, or delimiter records (objects)
  const delims = [];    // delimiter records (for *, _, ~~)
  const openers = [];   // '[' opener records for links/images
  let buf = '';         // pending plain-text run

  const flush = () => { if (buf) { out.push(buf); buf = ''; } };
  const pushStr = (s) => { flush(); out.push(s); };

  // Find the nearest opener (in `delims`) for `closer` (same char, can open,
  // not the closer itself), honouring the rule of 3. Returns the record or null.
  function findOpener(closer) {
    // A closer inside a potential link text ([...]) cannot pair with an
    // opener outside that link text: emphasis cannot span a link boundary.
    // Find the most recent active '[' opener before this closer.
    let bracketIdx = -1;
    for (let k = openers.length - 1; k >= 0; k--) {
      if (openers[k].active && openers[k].idx < closer.idx) { bracketIdx = openers[k].idx; break; }
    }
    for (let k = delims.length - 1; k >= 0; k--) {
      const o = delims[k];
      if (o === closer || o.char !== closer.char || !o.canOpen || o.lit.length === 0) continue;
      // Skip openers outside the link text (at or before the '[').
      if (bracketIdx !== -1 && o.idx <= bracketIdx) continue;
      // Skip openers inside an already-closed emphasis span: an opener
      // enclosed by a paired opener/closer (same char, both tagged)
      // cannot pair with a closer outside that span.
      let enclosed = false;
      for (let a = 0; a < delims.length && !enclosed; a++) {
        const p = delims[a];
        if (p.openTags.length === 0 || p.idx >= o.idx) continue;
        for (let b = a + 1; b < delims.length; b++) {
          const q = delims[b];
          if (q.char !== p.char || q.closeTags.length === 0) continue;
          if (q.idx <= o.idx || q.idx >= closer.idx) continue;
          enclosed = true; break;
        }
      }
      if (enclosed) continue;
      if (closer.char === '~' && o.lit.length > 2) continue;
      const oAmb = o.canOpen && o.canClose;
      const cAmb = closer.canOpen && closer.canClose;
      if ((oAmb || cAmb) && (o.lit.length + closer.lit.length) % 3 === 0 &&
          !(o.lit.length % 3 === 0 && closer.lit.length % 3 === 0)) continue;
      return o;
    }
    return null;
  }

  // Apply emphasis for `closer` against matching openers (possibly several
  // times if the run is long, e.g. *** -> strong + em).
  function processEmphasis(closer) {
    let o = findOpener(closer);
    while (o && closer.lit.length > 0) {
      // Tilde (strikethrough): opener and closer must have equal length
      // 1 or 2; mismatched lengths or runs of 3+ never pair.
      if (closer.char === '~') {
        if (o.lit.length !== closer.lit.length || o.lit.length > 2) break;
      }
      const use = closer.char === '~' ? o.lit.length : (o.lit.length >= 2 && closer.lit.length >= 2) ? 2 : 1;
      const tag = closer.char === '~' ? 'del' : (use === 2 ? 'strong' : 'em');
      // Opener: consume `use` chars from the END of its literal, prepend the
      // open tag (outermost first).
      o.lit = o.lit.slice(0, o.lit.length - use);
      o.openTags.unshift('<' + tag + '>');
      updateDelimOut(out, o);
      // Closer: consume `use` chars from the START of its literal, append
      // the close tag.
      closer.lit = closer.lit.slice(use);
      closer.closeTags.push('</' + tag + '>');
      updateDelimOut(out, closer);
      if (o.lit.length === 0 && o.openTags.length === 0 && o.closeTags.length === 0) {
        const ix = delims.indexOf(o);
        if (ix !== -1) delims.splice(ix, 1);
      }
      if (closer.lit.length > 0) o = findOpener(closer);
    }
  }

  // Try to form a link/image from the opener at `openers[oi]` and the text
  // starting at `j` (just past the ']'). Returns the index just past the
  // link markup, or -1 if no link forms.
  function tryLink(oi, j, isImage) {
    const opener = openers[oi];
    let dest = null, title = null, next = -1;
    if (j < text.length && text.charCodeAt(j) === 40) { // '(' inline link
      const d = parseLinkDest(text, j + 1);
      if (d) {
        // Whitespace (including newlines) may separate dest, title, ')'.
        let k = d.next;
        while (k < text.length && (text.charCodeAt(k) === 32 || text.charCodeAt(k) === 9 || text.charCodeAt(k) === 10)) k++;
        if (k < text.length && text.charCodeAt(k) === 41) {
          dest = d.dest; next = k + 1;
        } else {
          const t = parseLinkTitle(text, k);
          if (t) {
            let m = t.next;
            while (m < text.length && (text.charCodeAt(m) === 32 || text.charCodeAt(m) === 9 || text.charCodeAt(m) === 10)) m++;
            if (m < text.length && text.charCodeAt(m) === 41) {
              dest = d.dest; title = t.title; next = m + 1;
            }
          }
        }
      }
      // If the inline link failed (e.g. a destination with a space),
      // the `[foo]` may still be a shortcut reference — fall back to
      // it, leaving the `(...)` as literal text.
      if (dest === null) {
        const ref = refs.get(normalizeLabel(opener.rawText));
        if (!ref) return -1;
        dest = ref.dest; title = ref.title; next = j;
      }
    } else if (j < text.length && text.charCodeAt(j) === 91) { // '[' full ref or collapsed
      let k = j + 1, label = '';
      while (k < text.length) {
        const c = text.charCodeAt(k);
        // Backslash escapes are kept verbatim in the label: `foo\!` does
        // NOT match a ref `foo!` (the raw label text is what is matched).
        if (c === 92 && k + 1 < text.length && isPunct(text.charCodeAt(k + 1))) { label += text[k] + text[k + 1]; k += 2; continue; }
        if (c === 91 || c === 93) break;
        label += text[k]; k++;
      }
      if (k >= text.length || text.charCodeAt(k) !== 93) return -1;
      // An empty `[]` is a collapsed reference: the label is the link text.
      if (label.length === 0) label = opener.rawText;
      const ref = refs.get(normalizeLabel(label));
      if (!ref) return -1;
      dest = ref.dest; title = ref.title; next = k + 1;
    } else {
      // Collapsed '[]' or shortcut: the label is the link text.
      let label;
      if (j + 1 < text.length && text.charCodeAt(j) === 91 && text.charCodeAt(j + 1) === 93) {
        label = opener.rawText;
        next = j + 2;
      } else {
        label = opener.rawText;
        next = j;
      }
      const ref = refs.get(normalizeLabel(label));
      if (!ref) return -1;
      dest = ref.dest; title = ref.title;
    }
    // Form the link/image.
    flush();
    // Deactivate openers inside the link text (they cannot match outside).
    for (let k = oi + 1; k < openers.length; k++) openers[k].active = false;
    // A link cannot contain another link: deactivate enclosing LINK
    // openers. (An image may contain a link in its alt text, and a link
    // may contain an image, so image openers stay active.) A deactivated
    // opener BLOCKS the next ']' (it claims it, so the ']' is literal)
    // and is consumed by that ']'.
    if (!isImage) {
      for (let k = 0; k < oi; k++) {
        if (!openers[k].isImage) { openers[k].active = false; openers[k].blocked = true; }
      }
    }
    openers.splice(oi, 1);
    // Drop delimiters inside the link text (they cannot match outside).
    for (let k = delims.length - 1; k >= 0; k--) {
      if (delims[k].idx > opener.idx) delims.splice(k, 1);
    }
    if (isImage) {
      const alt = plainTextOf(opener.rawText, refs);
      // Blank out the '!', '[', link text and ']' chunks.
      for (let k = opener.bangIdx; k < out.length; k++) out[k] = '';
      const img = '<img src="' + cleanUrl(dest) + '" alt="' + escapeAttr(alt) + '"' +
        (title !== null ? ' title="' + escapeAttr(title) + '"' : '') + '>';
      out.push(img);
    } else {
      out[opener.idx] = '<a href="' + cleanUrl(dest) + '"' +
        (title !== null ? ' title="' + escapeAttr(title) + '"' : '') + '>';
      out.push('</a>');
    }
    return next;
  }

  const n = text.length;
  let i = 0;
  while (i < n) {
    const c = text.charCodeAt(i);
    // Backslash escapes and hard breaks.
    if (c === 92) { // '\'
      if (i + 1 < n && text.charCodeAt(i + 1) === 10) {
        pushStr('<br>'); i += 2;
        // A hard break strips the next line's leading indent.
        while (i < n && (text.charCodeAt(i) === 32 || text.charCodeAt(i) === 9)) i++;
        continue;
      }
      if (i + 1 < n && isPunct(text.charCodeAt(i + 1))) { buf += escapeHtml(text[i + 1]); i += 2; continue; }
      buf += '\\'; i++; continue;
    }
    // Code spans.
    if (c === 96) { // '`'
      let run = 0;
      while (i + run < n && text.charCodeAt(i + run) === 96) run++;
      let close = -1;
      for (let k = i + run; k < n; k++) {
        if (text.charCodeAt(k) === 96) {
          let r2 = 0;
          while (k + r2 < n && text.charCodeAt(k + r2) === 96) r2++;
          if (r2 === run) { close = k; break; }
          k += r2 - 1;
        }
      }
      if (close === -1) { buf += text.slice(i, i + run); i += run; continue; }
      let content = text.slice(i + run, close).replace(/\n/g, ' ');
      if (content.length >= 2 && content[0] === ' ' && content[content.length - 1] === ' ' && content.trim() !== '') {
        content = content.slice(1, -1);
      }
      pushStr('<code>' + escapeHtml(content) + '</code>');
      i = close + run;
      continue;
    }
    // Images / link openers.
    if (c === 33 && i + 1 < n && text.charCodeAt(i + 1) === 91) { // '!['
      flush();
      const bangIdx = out.length;
      out.push('!');
      out.push('[');
      openers.push({ idx: out.length - 1, bangIdx, active: true, rawText: '', isImage: true, start: i + 2 });
      i += 2;
      continue;
    }
    if (c === 91) { // '['
      flush();
      openers.push({ idx: out.length, active: true, rawText: '', isImage: false, bangIdx: -1, start: i + 1 });
      out.push('[');
      i++;
      continue;
    }
    if (c === 93) { // ']'
      // Find the nearest opener. An opener blocked by a link formed
      // inside it claims this ']' (the ']' is literal) and is consumed.
      // An opener deactivated only because its own tryLink failed is
      // skipped, so a later ']' can try the next-outer opener.
      let oi = -1;
      for (let k = openers.length - 1; k >= 0; k--) {
        const o = openers[k];
        if (o.blocked) { openers.splice(k, 1); break; }
        if (o.active) { oi = k; break; }
      }
      if (oi === -1) { buf += ']'; i++; continue; }
      const opener = openers[oi];
      opener.rawText = text.slice(opener.start, i);
      const next = tryLink(oi, i + 1, opener.isImage);
      if (next === -1) {
        // This opener can never form a link: deactivate it so a later ']'
        // tries the next-outer opener (nested brackets belong to the
        // outermost link whose text ends at a matching ']').
        opener.active = false;
        buf += ']'; i++; continue;
      }
      i = next;
      continue;
    }
    // Autolinks <...> and raw HTML tags.
    if (c === 60) { // '<'
      const rest = text.slice(i);
      const m = rest.match(/^<([A-Za-z][A-Za-z0-9.+-]{1,31}:[^<>\s]*)>/);
      if (m) {
        pushStr('<a href="' + cleanUrl(m[1]) + '">' + escapeHtml(m[1]) + '</a>');
        i += m[0].length;
        continue;
      }
      const em = rest.match(/^<([A-Za-z0-9.!#$%&'*+\/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*)>/);
      if (em) {
        pushStr('<a href="mailto:' + em[1] + '">' + escapeHtml(em[1]) + '</a>');
        i += em[0].length;
        continue;
      }
      const hm = rest.match(/^<!-->|^<!--->|^<!--[\s\S]*?-->|^<\?[\s\S]*?\?>|^<![A-Za-z][^>]*>|^<!\[CDATA\[[\s\S]*?\]\]>|^<[A-Za-z][A-Za-z0-9-]*(?:\s+[A-Za-z_:][A-Za-z0-9_.:-]*(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*\s*\/?>|^<\/[A-Za-z][A-Za-z0-9-]*\s*>/);
      if (hm) {
        pushStr(hm[0]);
        i += hm[0].length;
        continue;
      }
      buf += '&lt;'; i++;
      continue;
    }
    // Entities.
    if (c === 38) { // '&'
      ENTITY_RE.lastIndex = i;
      const m = ENTITY_RE.exec(text);
      if (m) {
        if (m[1] !== undefined || m[2] !== undefined) {
          const body = m[1] !== undefined ? m[1] : 'x' + m[2];
          const decoded = decodeNumericEntity(body);
          buf += decoded !== null ? escapeHtml(decoded) : '\uFFFD';
        } else {
          buf += m[0];
        }
        i += m[0].length;
        continue;
      }
      buf += '&amp;'; i++;
      continue;
    }
    // Emphasis / strikethrough delimiter runs.
    if (c === 42 || c === 95 || c === 126) { // '*', '_', '~'
      let run = 0;
      while (i + run < n && text.charCodeAt(i + run) === c) run++;
      if (c === 126 && run >= 3) { buf += text.slice(i, i + run); i += run; continue; }
      const before = i > 0 ? text[i - 1] : null;
      const after = i + run < n ? text[i + run] : null;
      const char = c === 42 ? '*' : c === 95 ? '_' : '~';
      const canOpen = delimCanOpen(char, before, after);
      const canClose = delimCanClose(char, before, after);
      flush();
      const d = { char, lit: text.slice(i, i + run), canOpen, canClose, idx: out.length, openTags: [], closeTags: [] };
      out.push(d);
      delims.push(d);
      if (canClose) processEmphasis(d);
      i += run;
      continue;
    }
    // Hard break: two or more spaces (or a tab) before a newline.
    if (c === 10) { // '\n'
      let sp = 0;
      for (let k = buf.length - 1; k >= 0; k--) {
        const bc = buf.charCodeAt(k);
        if (bc === 32 || bc === 9) sp++;
        else break;
      }
      if (sp >= 2) {
        buf = buf.slice(0, buf.length - sp);
        pushStr('<br>');
        i++;
        // A hard break strips the next line's leading indent.
        while (i < n && (text.charCodeAt(i) === 32 || text.charCodeAt(i) === 9)) i++;
      } else {
        buf += '\n';
        i++;
      }
      continue;
    }
    // GFM extended autolinks: www. and email, at a word boundary.
    if ((c === 119 && text.startsWith('www.', i)) || isAlphaNum(c)) {
      const prevCh = i > 0 ? text.charCodeAt(i - 1) : -1;
      const atStart = i === 0 || (!isAlphaNum(prevCh) && prevCh !== 46);
      if (atStart) {
        if (text.startsWith('www.', i)) {
          WWW_RE.lastIndex = i;
          const m = WWW_RE.exec(text);
          if (m) {
            let url = trimAutolink(m[0]);
            if (url.length > 4) {
              pushStr('<a href="http://' + cleanUrl(url) + '">' + escapeHtml(url) + '</a>');
              i += url.length;
              continue;
            }
          }
        }
        // Scheme autolink: http://, https://, ftp://, ...
        SCHEME_SLASH_RE.lastIndex = i;
        const sm = SCHEME_SLASH_RE.exec(text);
        if (sm) {
          let url = trimAutolink(sm[0]);
          if (url.length > 0) {
            pushStr('<a href="' + cleanUrl(url) + '">' + escapeHtml(url) + '</a>');
            i += url.length;
            continue;
          }
        }
        // Scheme autolink without slashes: mailto:foo@bar.baz,
        // xmpp:foo@bar.baz/txt — the whole `scheme:rest` is one link.
        // (Checked before the bare-email rule, which would otherwise
        // link only the email part and leave the scheme literal.)
        SCHEME_RE.lastIndex = i;
        const sm2 = SCHEME_RE.exec(text);
        if (sm2) {
          const scheme = sm2[1].toLowerCase();
          let url = null;
          if (scheme === 'mailto') {
            // The part after mailto: must be a valid email; a trailing
            // `/` is not part of it, and a following `+`/`-`/`_`
            // invalidates the whole thing.
            const em2 = sm2[2].match(/^[A-Za-z0-9.!#$%&'*+\/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*/);
            if (em2) {
              const after = sm2[2][em2[0].length];
              if (after !== '+' && after !== '-' && after !== '_') url = 'mailto:' + em2[0];
            }
          } else {
            url = trimAutolink(sm2[0]);
            // A scheme target holds at most one path segment after the
            // email/authority (xmpp:foo@bar.baz/txt, not /txt/bin).
            const m3 = url.match(/^([A-Za-z][A-Za-z0-9+.-]{1,31}:[^\/\s<]+\/[^\/\s<]*)\//);
            if (m3) url = m3[1];
            const afterColon = url.slice(url.indexOf(':') + 1);
            if (!(afterColon.includes('@') || afterColon.includes('/') || afterColon.includes('.'))) url = null;
          }
          if (url) {
            pushStr('<a href="' + cleanUrl(url) + '">' + escapeHtml(url) + '</a>');
            i += url.length;
            continue;
          }
        }
        EMAIL_RE.lastIndex = i;
        const em = EMAIL_RE.exec(text);
        if (em) {
          // The match must be the whole email-like token: a following
          // `+`, `-` or `_` means the domain continues invalidly
          // (e.g. `hello@mail+xyz.example`, `a.b@a.b-`), so no link.
          const after = text[i + em[0].length];
          if (after !== '+' && after !== '-' && after !== '_') {
            pushStr('<a href="mailto:' + em[0] + '">' + escapeHtml(em[0]) + '</a>');
            i += em[0].length;
            continue;
          }
        }
      }
      buf += text[i]; i++;
      continue;
    }
    // Plain character (HTML-escaped: the buffer holds escaped text).
    if (c === 38) buf += '&amp;';
    else if (c === 60) buf += '&lt;';
    else if (c === 62) buf += '&gt;';
    else if (c === 34) buf += '&quot;';
    else if (c === 39) buf += '&#39;';
    else buf += text[i];
    i++;
  }
  flush();
  // Render the chunks: delimiter records become their literal text plus any
  // emphasis tags; strings pass through.
  let result = '';
  for (const chunk of out) {
    result += typeof chunk === 'string' ? chunk : renderDelim(chunk);
  }
  return result;
}

// Trim trailing punctuation from a GFM autolink, keeping balanced parens.
function trimAutolink(url) {
  let end = url.length;
  while (end > 0) {
    const ch = url[end - 1];
    if (ch === '.' || ch === ',' || ch === ':' || ch === '!' || ch === '?' || ch === ']' || ch === "'") { end--; continue; }
    if (ch === ';') {
      // If this ';' completes an entity-like `&name;`, drop the whole thing.
      const before = url.slice(0, end - 1);
      const em = before.match(/&[A-Za-z0-9]+$/);
      if (em) { end = before.length - em[0].length; continue; }
      end--; continue;
    }
    if (ch === ')') {
      // Keep the ')' only if there is an unmatched '(' before it.
      const before = url.slice(0, end - 1);
      let open = 0, close = 0;
      for (let k = 0; k < before.length; k++) {
        if (before[k] === '(') open++;
        else if (before[k] === ')') close++;
      }
      if (open > close) break;
      end--; continue;
    }
    break;
  }
  return url.slice(0, end);
}

// Plain-text rendering of inline content (for image alt text): emphasis,
// code and link markup are stripped, HTML tags removed, entities decoded.
function plainTextOf(text, refs) {
  const html = parseInline(text, refs);
  // An image's alt text lives inside its tag; keep it (decoded) instead
  // of dropping the whole tag with the alt inside it.
  const withAlt = html.replace(/<img\b[^>]*?\salt="([^"]*)"[^>]*>/g, (m, alt) =>
    alt.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&'));
  return withAlt.replace(/<[^>]*>/g, '');
}

// ---------------------------------------------------------------------------
// Part 4 — rendering + entry point
// ---------------------------------------------------------------------------

// Task-list marker at the start of a list item's first paragraph.
// Returns {checked, rest} where `rest` is the text after the marker
// (including the following space), or null.
function taskMarker(text) {
  if (text.length >= 3 && text.charCodeAt(0) === 91 && text.charCodeAt(2) === 93) {
    const m = text.charCodeAt(1);
    if (m === 32 || m === 120 || m === 88) {
      if (text.length === 3) return { checked: m !== 32, rest: '' };
      const c3 = text.charCodeAt(3);
      if (c3 === 32 || c3 === 9) return { checked: m !== 32, rest: text.slice(3) };
    }
  }
  return null;
}

function renderBlock(node, refs, inTightList) {
  switch (node.t) {
    case 'para':
      return '<p>' + parseInline(node.text, refs) + '</p>\n';
    case 'heading':
      return '<h' + node.level + '>' + parseInline(node.text, refs) + '</h' + node.level + '>\n';
    case 'hr':
      return '<hr>\n';
    case 'code': {
      if (node.fenced) {
        const lang = node.info ? unescapeStr(node.info.split(/\s+/)[0]) : '';
        const cls = lang ? ' class="language-' + escapeAttr(lang) + '"' : '';
        return '<pre><code' + cls + '>' + escapeHtml(node.text) + '</code></pre>\n';
      }
      return '<pre><code>' + escapeHtml(node.text) + '</code></pre>\n';
    }
    case 'html':
      return node.text;
    case 'quote': {
      let s = '<blockquote>\n';
      for (const child of node.children) s += renderBlock(child, refs, false);
      return s + '</blockquote>\n';
    }
    case 'list': {
      const tag = node.ordered ? 'ol' : 'ul';
      const startAttr = node.ordered && node.start !== 1 ? ' start="' + node.start + '"' : '';
      let s = '<' + tag + startAttr + '>\n';
      for (const item of node.children) {
        let inner = '';
        for (let k = 0; k < item.children.length; k++) {
          const child = item.children[k];
          let cs;
          // Task list: the item's first paragraph may start with [ ] / [x].
          const tm = k === 0 && child.t === 'para' ? taskMarker(child.text) : null;
          if (tm) {
            const box = tm.checked
              ? '<input checked="" disabled="" type="checkbox">'
              : '<input disabled="" type="checkbox">';
            if (node.tight) cs = box + parseInline(tm.rest.replace(/[ \t]+$/, ''), refs);
            else cs = '<p>' + box + parseInline(tm.rest, refs) + '</p>\n';
          } else if (child.t === 'para' && node.tight) cs = parseInline(child.text.replace(/[ \t]+$/, ''), refs);
          else cs = renderBlock(child, refs, node.tight);
          inner += cs;
          // A tight paragraph is followed directly by the next block (no
          // newline); other children already end with one.
          if (k < item.children.length - 1 && !cs.endsWith('\n') && !(child.t === 'para' && node.tight)) inner += '\n';
        }
        s += '<li>' + inner + '</li>\n';
      }
      return s + '</' + tag + '>\n';
    }
    case 'table': {
      let s = '<table>\n<thead>\n<tr>\n';
      for (let k = 0; k < node.header.length; k++) {
        const a = node.aligns[k];
        s += '<th' + (a ? ' align="' + a + '"' : '') + '>' + parseInline(node.header[k], refs) + '</th>\n';
      }
      s += '</tr>\n</thead>\n';
      if (node.rows.length) {
        s += '<tbody>';
        for (let r = 0; r < node.rows.length; r++) {
          s += '<tr>\n';
          for (let k = 0; k < node.rows[r].length; k++) {
            const a = node.aligns[k];
            s += '<td' + (a ? ' align="' + a + '"' : '') + '>' + parseInline(node.rows[r][k], refs) + '</td>\n';
          }
          s += '</tr>\n';
        }
        s += '</tbody></table>\n';
      } else {
        s += '</table>\n';
      }
      return s;
    }
    default:
      return '';
  }
}

function parse(src) {
  const lines = splitLines(src);
  const parser = new BlockParser(lines);
  const { root, refs } = parser.parse();
  let out = '';
  for (const child of root.children) out += renderBlock(child, refs, false);
  // A trailing newline is appended only when the source ends with one
  // (a final raw HTML block with no trailing newline in the source
  // yields no trailing newline in the output).
  if (out.length > 0 && !out.endsWith('\n') && src.endsWith('\n')) out += '\n';
  return out;
}

export { parse };
export default parse;
