// parse.js — a from-scratch drop-in for marked 18.1.3 (defaults: gfm on,
// breaks off, pedantic off, synchronous). Output must match marked byte
// for byte on every input.
//
// How it works: a line-oriented block parser builds a small tree, a
// delimiter-stack inline parser renders inline content, and small render
// functions emit marked's exact HTML. No dependencies.
//
// Tabs: a tab's width is always relative to the ABSOLUTE column where the
// text sits, not to the start of the current string slice. Container cuts
// (quotes, item indents) can straddle a tab, so the block parser tracks a
// virtual text start: an absolute column plus a count of pad spaces that
// stand in for the leftover columns of a straddled tab. Helpers that
// measure or strip leading whitespace take a `base` (absolute column).

// ---------------------------------------------------------------------------
// Part 1 — character and string helpers
// ---------------------------------------------------------------------------

function isSpace(c) { return c === 32 || c === 9 || c === 10 || c === 13; }
function isDigit(c) { return c >= 48 && c <= 57; }
function isAlphaNum(c) {
  return (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
}
// ASCII punctuation per CommonMark: !"#$%&'()*+,-./:;<=>?@[\]^_`{|}~
function isPunct(c) {
  return (c >= 33 && c <= 47) || (c >= 58 && c <= 64) ||
    (c >= 91 && c <= 96) || (c >= 123 && c <= 126);
}
// Whitespace for emphasis flanking: ASCII whitespace plus NBSP and the
// other Unicode spaces (ASCII isSpace alone misses them).
function isFlankSpace(c) {
  return c === 32 || c === 9 || c === 10 || c === 13 || c === 11 || c === 12 ||
    c === 0xA0 || c === 0x1680 || (c >= 0x2000 && c <= 0x200A) ||
    c === 0x2028 || c === 0x2029 || c === 0x202F || c === 0x205F ||
    c === 0x3000 || c === 0xFEFF;
}
// Unicode punctuation (P) and symbols (S, including currency like £ € $)
// for emphasis flanking. Astral surrogates are never punctuation here.
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

// Decode a numeric character-reference body (after '&#' or '&#x').
// Returns the character, or null when the body is not a valid ref.
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

// Encode a URL the way marked does: drop control chars, percent-encode
// with encodeURI (space -> %20, " -> %22, \ -> %5C, non-ASCII as UTF-8),
// then HTML-escape & (unless it starts a valid entity) and ' -> &#39;.
function cleanUrl(href) {
  let s = '';
  for (let i = 0; i < href.length; i++) {
    const c = href.charCodeAt(i);
    if (c < 32 || c === 127) continue;
    s += href[i];
  }
  // Encode segment by segment so valid %XX sequences survive (a plain
  // encodeURI would re-encode '%' itself to '%25').
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
// entity, which is kept as-is).
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
    if (s.charCodeAt(i) === 92 && i + 1 < s.length && isPunct(s.charCodeAt(i + 1))) {
      out += s[i + 1]; i++;
    } else out += s[i];
  }
  return out;
}

// Split source into lines; CRLF and lone CR become LF. A trailing empty
// line (source ending with a newline) is dropped.
function splitLines(src) {
  src = src.replace(/\r\n?/g, '\n');
  const lines = src.split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

// Width in columns of the leading whitespace of `s` (a tab jumps to the
// next multiple of 4, measured from `base`, the absolute column where `s`
// starts) and the number of leading whitespace characters.
function indentCols(s, base = 0) {
  let col = 0, i = 0;
  while (i < s.length) {
    const c = s.charCodeAt(i);
    if (c === 32) { col++; i++; }
    else if (c === 9) { col += 4 - ((base + col) % 4); i++; }
    else break;
  }
  return { col, i };
}

// Index of the first character that is not a space or tab (or s.length).
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
// that straddles the cut turns into spaces). `base` is the absolute column
// where `s` starts.
function stripIndent(s, cols, base = 0) {
  let col = 0, i = 0;
  while (i < s.length && col < cols) {
    const c = s.charCodeAt(i);
    if (c === 32) { col++; i++; }
    else if (c === 9) {
      const w = 4 - ((base + col) % 4);
      if (col + w > cols) return ' '.repeat(col + w - cols) + s.slice(i + 1);
      col += w; i++;
    } else break;
  }
  return s.slice(i);
}

// Normalize a link label: collapse whitespace runs to a single space,
// trim, lowercase (with sharp S folding to "ss").
function normalizeLabel(label) {
  return label.replace(/\s+/g, ' ').trim().toLowerCase().replace(/ß/g, 'ss');
}

// Advance `cols` columns from string index `from` in `line` (tab-aware).
// Returns {i, pad}: the index after consuming `cols` columns, plus the
// leftover columns when a tab straddles the cut (those columns become
// spaces, not lost). `base` is the absolute column of line[from].
function advanceCols(line, from, cols, base = 0) {
  let col = 0, i = from, pad = 0;
  while (i < line.length && col < cols) {
    const c = line.charCodeAt(i);
    if (c === 32) { col++; i++; }
    else if (c === 9) {
      const w = 4 - ((base + col) % 4);
      if (col + w > cols) { pad = col + w - cols; i++; break; }
      col += w; i++;
    }
    else break;
  }
  return { i, pad };
}

// ---------------------------------------------------------------------------
// Part 2 — block-level helpers
// ---------------------------------------------------------------------------

const BLOCK_TAGS = new Set(('address article aside base basefont blockquote body caption center col colgroup dd details dialog dir div dl dt fieldset figcaption figure footer form frame frameset h1 h2 h3 h4 h5 h6 head header hr html iframe legend li link main menu menuitem nav noframes ol optgroup option p param search section summary table tbody td tfoot th thead title tr track ul').split(' '));

// Split a table row on unescaped pipes. The empty cells implied by outer
// pipes are dropped. Returns the raw (untrimmed) cell strings.
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
// ('left' | 'right' | 'center' | null per column) or null. A delimiter
// cell is one or more dashes with an optional leading/trailing colon.
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

// Match a blockquote marker at line[pos..]: up to 3 columns of indent,
// '>', then one optional space. Returns {i, col, padCols} — the index just
// past the marker, the absolute column where the virtual text starts, and
// the leftover columns when a tab straddles the optional space — or null.
// `base` is the absolute column of line[pos]. A tab after '>' is consumed
// as ONE column (the optional space); its remaining columns become pad
// spaces in the virtual text.
function matchQuote(line, pos, base = 0) {
  let col = base, i = pos;
  while (i < line.length) {
    const c = line.charCodeAt(i);
    if (c === 32) { col++; i++; }
    else if (c === 9) { col += 4 - (col % 4); i++; }
    else break;
    if (col - base > 3) return null;
  }
  if (col - base > 3) return null;
  if (line.charCodeAt(i) !== 62) return null; // '>'
  i++; col++;
  let padCols = 0;
  if (i < line.length && line.charCodeAt(i) === 32) { i++; col++; }
  else if (i < line.length && line.charCodeAt(i) === 9) {
    const w = 4 - (col % 4);
    i++; col++;
    padCols = w - 1;
  }
  return { i, col, padCols };
}

// Try to parse a link reference definition starting at lines[li], column
// col. The definition may span lines (destination / title on following
// lines). Returns {dest, title, endLine, endCol, label} or null.
function tryParseRefDef(lines, li, col) {
  const line = lines[li];
  if (line.charCodeAt(col) !== 91) return null; // '['
  // Scan the label; it may span lines (a newline inside the label
  // normalizes to a space when matched).
  let j = col + 1, label = '';
  let labelLine = li;
  let foundClose = false;
  while (true) {
    const curLine = lines[labelLine];
    while (j < curLine.length) {
      const c = curLine.charCodeAt(j);
      // Backslash escapes stay verbatim in the label (the inline link
      // label rule): `bar\\` stays `bar\\`.
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
// paragraph, so they return null here. `base` is the absolute column where
// `text` starts; `parentIsItem` is whether the paragraph's parent is a
// list item (then any starting number may interrupt).
function blockStartKind(text, paraInterrupt, base = 0, parentIsItem = false) {
  const { col, i } = indentCols(text, base);
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
      // An ordered list can interrupt a paragraph only if it starts with 1
      // — UNLESS the paragraph's parent is a list item, in which case any
      // starting number can start a nested list inside the item (`- [x]
      // Foo` + `  3. bar` starts <ol start="3">). At the top level or
      // inside a quote, `Foo\n3. bar` stays one paragraph.
      if (paraInterrupt && parseInt(rest.slice(0, n), 10) !== 1 && !parentIsItem) return null;
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
      // Type 1 (script/pre/style/textarea) starts only with the OPEN tag;
      // a closing tag (</pre> etc.) is type 7 at most and cannot interrupt
      // a paragraph (`</pre>` stays a lazy paragraph continuation).
      if (tag === 'script' || tag === 'pre' || tag === 'style' || tag === 'textarea') {
        if (rest.charCodeAt(1) !== 47) return 'html';
      } else if (BLOCK_TAGS.has(tag)) return 'html';
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
    const keepOne = !!b._keepTrailing;
    while (b.lines.length && b.lines[b.lines.length - 1] === '') b.lines.pop();
    // A paragraph closed while sealed (flagged by the blank-line or
    // block-start site) keeps one trailing empty line, so its text ends
    // with a newline.
    if (keepOne && b.lines.length > 0) b.lines.push('');
    if (b.lines.length === 0) {
      const parent = this.tip();
      const idx = parent.children.indexOf(b);
      if (idx !== -1) parent.children.splice(idx, 1);
      return;
    }
    b.text = b.lines.join('\n');
    delete b.lines; delete b.onlyDefs; delete b._keepTrailing;
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
  //
  // Seal rule: a line that loses 4 columns to the code-indent strip seals
  // the paragraph (`_sealed`); a line that does not lose 4 columns clears
  // it. `_sealedByMatch` records whether the seal came from a matching
  // (non-lazy) line. The seal itself never splits the paragraph — the
  // callers insert a single empty line when the next line arrives.
  addParaLine(rest, cUnmatched, lazy, innermostIsItem, base = 0) {
    let s = rest;
    let baseCol = base;
    const { col: r0 } = indentCols(s, baseCol);
    if (cUnmatched > 0 && r0 >= cUnmatched) { s = stripIndent(s, cUnmatched, baseCol); baseCol += cUnmatched; }
    const { col: r1 } = indentCols(s, baseCol);
    let stripped4 = false;
    const p = this.tip();
    // No 4-column strip in a post-list paragraph (see the _postList note
    // at paragraph creation): its lines keep their indent and it never
    // seals.
    if ((lazy || innermostIsItem) && !p._postList && r1 >= 4) { s = stripIndent(s, 4, baseCol); stripped4 = true; }
    // Lazy setext-lookalike line inside a quote, after a lazy line: marked
    // indents it to exactly 4 spaces (verified on `> foo\nbar\n===` etc.).
    if (lazy && p._hasLazy && /^ {0,3}(=+|-+)[ \t]*$/.test(s)) {
      let inQuote = false;
      for (let k = 0; k < this.stack.length; k++) if (this.stack[k].t === 'quote') { inQuote = true; break; }
      if (inQuote) s = '    ' + s.replace(/^[ \t]+/, '');
    }
    p.lines.push(s);
    if (lazy) {
      p._hasLazy = true;
      // A lazy line's seal never counts as "sealed by a match".
      p._sealed = stripped4;
      p._sealedByMatch = false;
      // The last lazy line's remaining indent (after the container walk
      // and the unmatched-item strip, before any 4-column strip): a
      // paragraph whose last lazy line kept >= 2 leading spaces is closed
      // by a later lazy line that fails the outermost item (verified on
      // the depth-3 indent matrix: a lazy rest-2 line arms the close,
      // a lazy rest-0/1 line does not; a matching line resets this).
      p._lastLazyRest = r1;
    } else {
      p._sealed = stripped4;
      // A matching line that loses 4 columns seals the paragraph BY A
      // MATCH: a later lazy line then closes the paragraph and its item.
      p._sealedByMatch = stripped4;
      // The last matching line's remaining indent (after the container
      // walk, before any 4-column strip): a paragraph whose last matching
      // line kept >= 2 leading spaces is closed by a later lazy line
      // that fails the outermost item (see the §10 rule below).
      p._lastMatchRest = r1;
      p._lastLazyRest = -1;
      // A non-lazy continuation line (matching the containers) anchors the
      // paragraph: a later indent-0 line then closes it instead of lazily
      // continuing it (verified: multi-line para + indent-0 line closes
      // the lists, single-line or lazy-continued para stays lazy).
      if (p.lines.length > 1) p._hasMatchingCont = true;
    }
  }

  parse() {
    const lines = this.lines;
    while (this.i < lines.length) {
      const line = lines[this.i];
      // ---- container matching ----
      // Walk state: `off` = string index in the line, `col` = absolute
      // column of the virtual text start, `padCols` = leftover columns
      // from a tab straddled by a cut (virtual spaces before line[off]).
      // The virtual text is ' '.repeat(padCols) + line.slice(off), and
      // a tab's width is always relative to its absolute column
      // (CommonMark partially-consumed-tab rule, verified vs marked).
      let off = 0, matched = 0, failedAt = -1;
      let matchedItemCols = 0; // item indent stripped by the walk
      let hasQuote = false; // the line carried a `>` marker
      let col = 0; // absolute column of the virtual text start
      let padCols = 0; // virtual spaces before line[off]
      for (let k = 1; k < this.stack.length; k++) {
        const node = this.stack[k];
        if (node.t === 'quote') {
          const r = matchQuote(line, off, col + padCols);
          if (r === null) { failedAt = k; break; }
          off = r.i; col = r.col; padCols = r.padCols; matched = k; hasQuote = true;
        } else if (node.t === 'list') {
          matched = k;
        } else if (node.t === 'item') {
          if (isBlank(line.slice(off))) { matched = k; }
          else {
            const ind = indentCols(line.slice(off), col + padCols).col;
            if (padCols + ind >= node.contentIndent) {
              if (padCols >= node.contentIndent) {
                padCols -= node.contentIndent;
                col += node.contentIndent;
              } else {
                const need = node.contentIndent - padCols;
                const adv = advanceCols(line, off, need, col + padCols);
                off = adv.i;
                col = col + padCols + need;
                padCols = adv.pad;
              }
              matchedItemCols += node.contentIndent;
              matched = k;
            } else { failedAt = k; break; }
          }
        } else break; // leaf
      }
      const allMatched = failedAt === -1;
      const rest = ' '.repeat(padCols) + line.slice(off);
      const restCol = col;
      const blank = isBlank(rest);

      if (blank) {
        if (!allMatched) this.closeTo(matched);
        const t = this.tip();
        // A quote line carrying only spaces (`>  `) is a paragraph
        // continuation holding those spaces, not a blank line: the
        // paragraph keeps the spaces as its last line.
        if (hasQuote && rest.length > 0 && t.t === 'para') {
          const innermostIsItem = this.stack.length > 1 && this.stack[this.stack.length - 2].t === 'item';
          this.addParaLine(rest, 0, false, innermostIsItem, restCol);
          this.i++; continue;
        }
        // A blank line inside a fenced code block keeps its whitespace
        // (it is code content, minus the fence indent); inside an
        // indented block it keeps the line minus the 4-column indent.
        if (t.t === 'code') {
          if (t.fenced) t.lines.push(t.fenceIndent > 0 ? stripIndent(rest, t.fenceIndent, restCol) : rest);
          else t.lines.push(stripIndent(rest, 4, restCol));
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
        // A blank line closes the paragraph but its parent stays open, so
        // a sealed paragraph keeps one trailing empty line (its text ends
        // with a newline, e.g. `<p>foo\nbar\nbaz\n</p>` in a loose list).
        // The trailing line is kept only if the list turns out LOOSE
        // (another item follows); when the list ends tight (a top-level
        // paragraph follows) it is dropped at render time. The pending
        // flag records that this trailing line came from a blank line.
        if (this.tip().t === 'para') {
          const pb = this.tip();
          if (pb._sealed && pb.lines.length > 0) { pb.lines.push(''); pb._keepTrailing = true; pb._trailingPending = true; }
          this.closePara();
        }
        // An empty list item is closed by a blank line: it can gain no
        // content after one (`-\n\n  foo` leaves `  foo` a top-level
        // paragraph, not the item's content). Only an item with no blocks
        // yet closes; a non-empty item keeps later indented content
        // (e.g. `- foo\n\n  bar` stays inside the item).
        if (this.tip().t === 'item' && this.tip().children.length === 0) this.stack.pop();
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
          t.lines.push(t.fenceIndent > 0 ? stripIndent(rest, t.fenceIndent, restCol) : rest);
        }
        this.i++; continue;
      }
      if (allMatched && t.t === 'code' && !t.fenced) {
        const { col } = indentCols(rest, restCol);
        if (col >= 4) { t.lines.push(stripIndent(rest, 4, restCol)); this.i++; continue; }
        const b = this.stack.pop(); this.finishCode(b);
        // fall through: reprocess the line at the new tip
      } else if (allMatched && t.t === 'html') {
        t.lines.push(rest);
        if (t.htmlEnd && rest.toLowerCase().includes(t.htmlEnd)) {
          const b = this.stack.pop(); this.finishHtml(b);
        }
        this.i++; continue;
      } else if (allMatched && t.t === 'table') {
        if (blockStartKind(rest, false, restCol) !== null) {
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
        if (allMatched && p.lines.length > 0 && indentCols(rest, restCol).col <= 3) {
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
          const { col: c0, i: ci } = indentCols(rest, restCol);
          if (c0 <= 3) {
            const d = tryParseRefDef(lines, this.i, off + ci - padCols);
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
        // Exception: when the paragraph's parent is a list item, any
        // starting number can interrupt (nested list inside the item).
        const parentIsItem = this.stack.length > 1 && this.stack[this.stack.length - 2].t === 'item';
        if (blockStartKind(rest, allMatched, restCol, parentIsItem) !== null) {
          // A new block starting inside the paragraph's containers closes
          // it but the parent stays open, so a sealed paragraph keeps one
          // trailing empty line (e.g. `foo\nbar\n<ul>`). A lazy line (not
          // matching) starts its block at an outer level, closing the
          // parent too, so no trailing line there.
          if (allMatched && p._sealed && p.lines.length > 0) { p.lines.push(''); p._keepTrailing = true; }
          this.closePara();
          continue; // reprocess the line (do not advance i)
        }
        if (allMatched) {
          const innermostIsItem = this.stack.length > 1 && this.stack[this.stack.length - 2].t === 'item';
          // Match-seal split: a paragraph sealed by a MATCHING line that
          // lost 4 columns is ENDED by the next matching line unless that
          // line also loses 4 columns (two strip lines stay joined).
          // E.g. `  - A.` + `        X.` + `    C` renders `A.\nX.\n\nC`
          // (two paragraphs in the tight item), while `        Y.` after
          // `        X.` stays joined. The blank line comes from the
          // two-paragraph separator; no trailing line is pushed.
          if (p._sealed && p._sealedByMatch && !(innermostIsItem && indentCols(rest, restCol).col >= 4)) {
            this.closePara();
            continue; // reprocess the line (do not advance i)
          }
          // Seal rule: a sealed paragraph is NOT split. The matching line
          // inserts ONE empty line into the paragraph's lines (rendering
          // as a blank line inside the paragraph, e.g. `<p>foo\nbar\n\n
          // baz</p>` in a loose list) and the paragraph continues; the
          // seal is cleared by addParaLine's non-lazy branch. The insert
          // fires ONLY when the seal came from a LAZY line: a seal set by
          // a matching line does not insert (two matching strip lines
          // stay joined).
          if (p._sealed && !p._sealedByMatch) p.lines.push('');
          this.addParaLine(rest, 0, false, innermostIsItem, restCol);
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
        // Nested matching-continuation close: a paragraph in a nested item
        // (depth >= 2), anchored by a matching continuation line, is
        // closed by a lazy line that fails the OUTERMOST item (indent <
        // the outermost item's content indent) when EITHER the inner
        // item's content is indented >= 4 columns beyond the outer
        // item's (nest gap >= 4, in ABSOLUTE columns) OR the paragraph's
        // last matching line kept >= 2 leading spaces (its remaining
        // indent after the container walk is >= 2, e.g. `- A.` + `  * B.`
        // + `      C.` + `D` closes although the gap is only 2 — while
        // `    C.` (rest 0) and a last line that reset the rest to 0 stay
        // lazy). The same close fires when the paragraph's last line is a
        // LAZY line that kept >= 2 leading spaces (depth-3 indent matrix:
        // a lazy rest-2 line arms it, rest-0/1 does not; at depth 3 the
        // gap is >= 4 whenever the lazy arm can fire). The indent
        // threshold is the outermost item's indent, not 2: with outer
        // `  -` (CI 4) a lazy line at indent 2 or 3 closes, at indent 4
        // it stays lazy. No seal is needed.
        if ((tipPara._hasMatchingCont || (tipPara._lastLazyRest || 0) >= 2) && itemDepth >= 2) {
          let outerCI = -1;
          for (let k = 1; k < this.stack.length; k++) {
            if (this.stack[k].t === 'item') { outerCI = this.stack[k].contentIndent; break; }
          }
          // Absolute content column of the innermost item = sum of all
          // item contentIndents (totalItemIndent); the outermost item's
          // absolute column is its own contentIndent.
          // Two arms, both gap-sensitive in different ways:
          // - match arm: a matching continuation anchors the paragraph;
          //   it closes when the nest gap is >= 4, or (gap-free) when
          //   the last matching line kept >= 2 leading spaces.
          // - lazy arm: the paragraph's last line is a lazy line that
          //   kept >= 2 leading spaces; it closes ONLY at depth >= 3
          //   (at depth 2 a lazy rest-2 line does NOT close — verified
          //   on doc-11's case at gap 3 and doc-08's case at gap 4;
          //   at depth 3 the gap is >= 5 whenever the arm can fire).
          const gap = this.totalItemIndent() - outerCI;
          // The match arm fires only while the paragraph's LAST line is
          // a matching line: any lazy line resets it (verified: a lazy
          // rest-0/1/2 line after a matching continuation keeps the
          // paragraph lazy at gap 4 and gap 6 alike). `_lastLazyRest` is
          // -1 after a matching line, >= 0 after a lazy one.
          const matchArm = tipPara._hasMatchingCont && (tipPara._lastLazyRest ?? -1) < 0 && (gap >= 4 || (tipPara._lastMatchRest || 0) >= 2);
          const lazyArm = (tipPara._lastLazyRest || 0) >= 2 && itemDepth >= 3;
          if (outerCI >= 0 && indentCols(line).col < outerCI && (matchArm || lazyArm)) {
            this.closePara();
            continue; // reprocess the line at the outer level
          }
        }
        const innermostIsItem = this.stack.length > 1 && this.stack[this.stack.length - 2].t === 'item';
        // Deep-nest lazy close: at depth >= 3, when the inner items are
        // indented >= 6 columns beyond the outermost item (nest gap >= 6),
        // a lazy line that reaches neither the outermost item's content
        // indent nor 4 columns closes the paragraph (the line is
        // reprocessed at the outer level). E.g. `  - A.` + `    - B.` +
        // `      - C.` + `  D` closes (gap 6, indent 2 < 4), but a gap-5
        // nest and a line with indent >= min(outerCI, 4) stay lazy. This
        // holds with or without a matching continuation line.
        if (itemDepth >= 3 && innermostIsItem) {
          let outerCI = -1;
          for (let k = 1; k < this.stack.length; k++) {
            if (this.stack[k].t === 'item') { outerCI = this.stack[k].contentIndent; break; }
          }
          if (outerCI >= 0 && this.totalItemIndent() - outerCI >= 6 && indentCols(line).col < Math.min(outerCI, 4)) {
            this.closePara();
            continue; // reprocess the line at the outer level
          }
        }
        // Lazy-line dedent: marked strips the content indent of the
        // FIRST (outermost) unmatched item whose indent the line's
        // remaining indent covers; if no unmatched item's indent is
        // covered, nothing is stripped. The strip is all-or-nothing per
        // item and the outermost covered item wins. Verified on 100+
        // probes: (O=4,R=3,L=2) strips 0, (O=4,R=2,L=2) strips 2,
        // (O=6,R=5,L=5) strips 5, (mid=3,inner=2,L=3) strips 3,
        // (mid=2,inner=3,L=3) strips 2.
        let cUnmatched = 0;
        {
          const r0 = indentCols(rest, restCol).col;
          for (let k = failedAt; k < this.stack.length; k++) {
            const node = this.stack[k];
            if (node.t === 'item' && node.contentIndent <= r0) { cUnmatched = node.contentIndent; break; }
          }
        }
        // Seal close rule: a sealed paragraph in a list item is closed by
        // any lazy line — the line is reprocessed at the outer level,
        // closing the item — when EITHER the seal came from a MATCHING
        // line (any depth: `- foo` + `      bar` + `baz` closes) OR the
        // paragraph sits in a NESTED item (depth >= 2) AND the lazy line
        // fails the OUTERMOST item (it matched no item: matchedItemCols
        // is 0). A lazy seal in a nested item does NOT close when the line
        // matches the outer item — the line then splits the paragraph
        // inside the item (seal-insert below) instead. A seal set by a
        // lazy line in a top-level item does NOT close (the lazy line
        // stays, with one empty line inserted). Quotes never close this way.
        if (p._sealed && innermostIsItem && (p._sealedByMatch || (itemDepth >= 2 && matchedItemCols === 0))) {
          this.closePara();
          continue; // reprocess the line at the outer level
        }
        // Seal rule: a sealed paragraph is NOT split by a lazy line that
        // does not lose 4 columns to the code-indent strip. The lazy line
        // inserts ONE empty line into the paragraph's lines (rendering as
        // a blank line inside the paragraph) and is added to the SAME
        // paragraph with its leading whitespace kept; the seal is cleared
        // (addParaLine sets _sealed = stripped4, false here). A lazy line
        // that loses 4 columns just continues the paragraph (seal stays).
        let r1 = 0;
        if (p._sealed) {
          let s0 = rest, b0 = restCol;
          const r0 = indentCols(s0, b0).col;
          if (cUnmatched > 0 && r0 >= cUnmatched) { s0 = stripIndent(s0, cUnmatched, b0); b0 += cUnmatched; }
          r1 = indentCols(s0, b0).col;
        }
        if (p._sealed && r1 < 4) p.lines.push('');
        this.addParaLine(rest, cUnmatched, true, innermostIsItem, restCol);
        this.i++; continue;
      }

      // ---- not a paragraph tip: close unmatched containers, then start ----
      if (!allMatched) { this.closeTo(matched); continue; }

      const { col: ind, i: ci } = indentCols(rest, restCol);
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
      if (matchQuote(rest, 0, restCol) !== null) {
        const quote = { t: 'quote', children: [] };
        this.openBlock(quote);
        continue; // reprocess the line inside the quote (do not advance i)
      }
      // List item
      const ls = matchListStart(content, ind);
      if (ls) {
        this.startListItem(ls, off, ci, padCols, restCol);
        continue; // startListItem advances i or rewrites the line
      }
      // Indented code
      if (ind >= 4) {
        const code = { t: 'code', fenced: false, lines: [stripIndent(rest, 4, restCol)], children: [] };
        this.openBlock(code);
        this.i++; continue;
      }
      // Paragraph (or link reference definitions at its start).
      const para = { t: 'para', lines: [], onlyDefs: true, children: [] };
      // Post-list paragraph: once a sub-list has appeared in the
      // enclosing list item, later paragraphs in that item are "loose"
      // — their continuation lines keep their indent (no 4-column strip,
      // no seal) and they render wrapped in <p> even in a tight list.
      // E.g. `- Dog.` + `  - Import.` + `  ## Head` + `  Badge.` +
      // `      More.` keeps `    More.` (no strip) and wraps Badge in
      // <p>, while the same shape without the sub-list strips to `More.`
      // and renders bare. A paragraph before any sub-list is unaffected.
      for (let k = this.stack.length - 1; k >= 1; k--) {
        if (this.stack[k].t === 'item') {
          if (this.stack[k].children.some(ch => ch.t === 'list')) para._postList = true;
          break;
        }
      }
      this.openBlock(para);
      if (ind <= 3) {
        const d = tryParseRefDef(lines, this.i, off + ci - padCols);
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
      this.addParaLine(rest, 0, false, innermostIsItem, restCol);
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
  startListItem(ls, off, ci, padCols = 0, restCol = 0) {
    // A blank between items of this list loosens it. Capture the flag
    // now: loosenCheck() below clears pending flags (a blank is
    // consumed once), and the previous item may already be popped, so
    // this list's flag is the only record of the blank.
    const tip0 = this.tip();
    const listPending = (tip0.t === 'list' && tip0.ordered === ls.ordered && tip0.delim === ls.marker) ? tip0._blankPending : false;
    this.loosenCheck();
    const line = this.lines[this.i];
    // `ci` counts pad spaces too; the marker's index in the original
    // line is off + ci - padCols. The absolute column of line[off] is
    // restCol + padCols; tab widths in the whitespace run are relative
    // to it.
    const markerIdx = off + ci - padCols;
    let q = markerIdx + ls.markerLen;
    const absOff = restCol + padCols;
    const baseIndent = indentCols(line.slice(off), absOff).col;
    let col = baseIndent + ls.markerLen;
    let colAbs = absOff + col;
    let spaces = 0;
    while (q < line.length && (line.charCodeAt(q) === 32 || line.charCodeAt(q) === 9)) {
      if (line.charCodeAt(q) === 32) { spaces++; col++; colAbs++; q++; }
      else { const w = 4 - (colAbs % 4); spaces += w; col += w; colAbs += w; q++; }
    }
    const isEmpty = q >= line.length;
    // Content indent is the absolute column where the content starts,
    // relative to the virtual text start (restCol): the leading indent
    // + marker + spaces (1-4 spaces), or leading indent + marker + 1
    // when there are 5+ spaces or the item is empty. It MUST be
    // computed from absolute columns (colAbs / absOff), not from `col`:
    // when a tab straddles the outer item's strip, the walk leaves a
    // pad (padCols) and `col` is measured from the tab's end, so it
    // understates the content indent by the pad — the walk then
    // under-strips later lines and the pad leaks into the content as
    // leading spaces (e.g. `+ Extends.` + `\t1. Quote...` rendered
    // `  Quote...` instead of `Quote...`). With no pad the two agree
    // (absOff == restCol), so non-tab cases are unaffected.
    const contentColAbs = (isEmpty || spaces >= 5)
      ? absOff + baseIndent + ls.markerLen + 1
      : colAbs;
    const contentIndent = contentColAbs - restCol;
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
    // Rewrite the line: outer prefix + spaces to the content's column +
    // remainder. The space count is `col` (the column where the content
    // starts), NOT contentIndent: when the whitespace run is 5+ columns
    // the extra columns are real indent that an indented code block (or
    // a lazy continuation) can still see — collapsing them to
    // contentIndent loses them (e.g. `-\t\tfoo` must keep 6 columns so
    // the code indent leaves "  foo"). Exception: when the innermost
    // open container is a blockquote that did NOT consume an optional
    // space after `>` in the original line (e.g. `>>- one`, where `>` is
    // directly followed by `-`), re-matching the quote eats one of the
    // inserted spaces as its optional space, so the content lands one
    // column short of contentIndent; insert one extra space.
    const parentIsQuoteNoSpace = tip0.t === 'quote' && off > 0 && line.charCodeAt(off - 1) !== 32;
    this.lines[this.i] = line.slice(0, off) + ' '.repeat(parentIsQuoteNoSpace ? col + 1 : col) + line.slice(q);
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
  const pending = [];   // emphasis closers deferred by a live '['
  let buf = '';         // pending plain-text run

  const flush = () => { if (buf) { out.push(buf); buf = ''; } };
  const pushStr = (s) => { flush(); out.push(s); };

  // Find the nearest opener (in `delims`) for `closer` (same char, can open,
  // not the closer itself), honouring the rule of 3. Returns the record or null.
  // With `ignoreBracket`, the link-boundary check is skipped (used to tell
  // whether a closer is blocked ONLY by a bracket, so it can be deferred).
  function findOpener(closer, ignoreBracket) {
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
      if (!ignoreBracket && bracketIdx !== -1 && o.idx <= bracketIdx) continue;
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
    // Deferred pairing: if this closer could pair with an opener but for
    // the link boundary, remember it. When the '[' resolves, the closer
    // pairs if no link formed, and stays literal if one did.
    if (closer.lit.length > 0 && findOpener(closer, true) && !pending.includes(closer)) pending.push(closer);
  }

  // Re-run deferred closers (after a '[' failed to form a link, or at the
  // end of the text where no link can form). Closers still blocked by a
  // live bracket, or with no opener even ignoring brackets, are dropped
  // from the pending list (the latter can never pair: openers only
  // precede a closer).
  function flushPending() {
    if (!pending.length) return;
    const keep = [];
    for (const d of pending) {
      if (d.lit.length === 0) continue;
      processEmphasis(d);
      if (d.lit.length > 0 && findOpener(d, true)) keep.push(d);
    }
    pending.length = 0;
    for (const d of keep) pending.push(d);
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
        if (o.blocked) { openers.splice(k, 1); flushPending(); break; }
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
        flushPending();
        buf += ']'; i++; continue;
      }
      // A link formed: deferred closers inside its text stay literal
      // (they cannot pair across the link boundary).
      for (let k = pending.length - 1; k >= 0; k--) {
        if (pending[k].idx > opener.idx) pending.splice(k, 1);
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
  // Unclosed '[' openers can never form a link: deferred closers blocked
  // only by them may now pair. Deactivate the openers first so the
  // bracket check in findOpener no longer blocks them.
  for (const o of openers) o.active = false;
  flushPending();
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
      for (let ii = 0; ii < node.children.length; ii++) {
        const item = node.children[ii];
        let inner = '';
        for (let k = 0; k < item.children.length; k++) {
          const child = item.children[k];
          let cs;
          // A paragraph in a tight item renders bare unless it is a
          // post-list paragraph (a sub-list precedes it in the item):
          // post-list paragraphs are wrapped in <p> tags.
          const barePara = child.t === 'para' && node.tight && !child._postList;
          // Paragraph text adjustments (render time, structural):
          // - a blank-line trailing line is dropped when the enclosing
          //   list stayed tight (see the blank-line site): the text ends
          //   with one newline from _keepTrailing, and only that newline
          //   is removed here; in a loose list the text is kept.
          // - trailing spaces of the last line are stripped when the
          //   paragraph is the last child of its item AND its item is the
          //   last item of the list (tight or loose); they are kept when
          //   another item follows or another block follows in the item.
          let ptext = child.t === 'para' ? child.text : null;
          if (ptext !== null) {
            if (node.tight && child._trailingPending) ptext = ptext.replace(/\n$/, '');
            if (k === item.children.length - 1 && ii === node.children.length - 1) ptext = ptext.replace(/[ \t]+(\n)?$/, '$1');
          }
          // Task list: the item's first paragraph may start with [ ] / [x].
          const tm = k === 0 && child.t === 'para' ? taskMarker(ptext) : null;
          if (tm) {
            const box = tm.checked
              ? '<input checked="" disabled="" type="checkbox">'
              : '<input disabled="" type="checkbox">';
            if (node.tight) cs = box + parseInline(tm.rest, refs);
            else cs = '<p>' + box + parseInline(tm.rest, refs) + '</p>\n';
          } else if (barePara) cs = parseInline(ptext, refs);
          else if (child.t === 'para') cs = '<p>' + parseInline(ptext, refs) + '</p>\n';
          else cs = renderBlock(child, refs, node.tight);
          inner += cs;
          // Separators between an item's children: a tight paragraph is
          // followed directly by a non-paragraph block (no newline), but
          // two paragraphs in a tight item are separated by a blank line
          // (the seal rule can split a paragraph with no blank line in
          // the source, e.g. `  1. foo\n    bar\n     baz`). A paragraph
          // that follows a non-paragraph block in a tight item is wrapped
          // in <p> tags (e.g. a paragraph after a nested list or a
          // heading); a bare paragraph ends without a newline, so the
          // blank line is two newlines, while a <p> paragraph already ends
          // with one, so the blank line is one more.
          if (k < item.children.length - 1) {
            const next = item.children[k + 1];
            if (child.t === 'para' && node.tight && next.t === 'para') inner += barePara ? '\n\n' : '\n';
            else if (!cs.endsWith('\n') && !(child.t === 'para' && node.tight)) inner += '\n';
          }
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
