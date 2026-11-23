// Fast drop-in for makefun-site 1.0.0 (site-generator-speed-01-run-20261122).
//
// My own implementation of makefun-site's behavior: front matter, its Markdown
// subset, its template dialect, its slug rule and its report, byte for byte.
// Where the README and the reference differ, this follows the reference.
//
// Speed comes from: one pass over each source's lines (front matter and
// Markdown share the split), a Markdown renderer that scans plain runs in bulk
// instead of escaping character by character, a per-build slug cache, and
// templates compiled once per build into plain JavaScript functions (via the
// Function constructor) instead of being walked as a node tree per render.
// Nothing is cached from one case to the next: every per-build table (slug
// cache, compiled templates) is created fresh inside run().

const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// ---------------------------------------------------------------- text

const ESC_TEST = /[&<>"']/;

/** `text` with & < > " and ' escaped. Returns the input itself when clean. */
export function escapeHtml(text) {
  if (!ESC_TEST.test(text)) return text;
  let out = '';
  let last = 0;
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text.charCodeAt(i);
    let r;
    if (c === 38) r = '&amp;';
    else if (c === 60) r = '&lt;';
    else if (c === 62) r = '&gt;';
    else if (c === 34) r = '&quot;';
    else if (c === 39) r = '&#39;';
    else {
      i++;
      continue;
    }
    out += text.slice(last, i) + r;
    last = i + 1;
    i++;
  }
  return out + text.slice(last);
}

/** The most characters a slug keeps before a collision suffix. */
export const SLUG_MAX = 64;

/**
 * The slug of `text`: NFKD, combining marks dropped, A-Z lowered, every run of
 * characters other than a-z and 0-9 one "-", none at either end, at most 64
 * characters (a "-" left at the cut dropped), "untitled" when nothing is left.
 * Results are cached per build in `cache`.
 */
export function slugify(text, cache) {
  const hit = cache.get(text);
  if (hit !== undefined) return hit;
  let plain = text;
  let ascii = true;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) > 127) {
      ascii = false;
      break;
    }
  }
  if (!ascii) plain = text.normalize('NFKD').replace(/\p{M}/gu, '');
  let out = '';
  let gap = false;
  if (ascii) {
    for (let i = 0; i < plain.length; i++) {
      const c = plain.charCodeAt(i);
      let keep = -1;
      if (c >= 65 && c <= 90) keep = c + 32;
      else if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) keep = c;
      if (keep === -1) {
        gap = out.length > 0;
        continue;
      }
      if (gap) out += '-';
      gap = false;
      out += String.fromCharCode(keep);
    }
  } else {
    for (const ch of plain) {
      let keep = null;
      if (ch >= 'A' && ch <= 'Z') keep = ch.toLowerCase();
      else if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) keep = ch;
      if (keep === null) {
        gap = out.length > 0;
        continue;
      }
      if (gap) out += '-';
      gap = false;
      out += keep;
    }
  }
  out = out.slice(0, SLUG_MAX).replace(/-+$/, '');
  const res = out === '' ? 'untitled' : out;
  cache.set(text, res);
  return res;
}

/** `slug` made unique against `taken` (and added to it). */
export function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** A YYYY-MM-DD date in words, from the string alone. */
export function longDate(date) {
  return `${Number(date.slice(8, 10))} ${MONTHS[Number(date.slice(5, 7)) - 1]} ${date.slice(0, 4)}`;
}

/** Whether char code `c` is JavaScript whitespace (\s). */
function isWSCode(c) {
  return (
    c === 32 ||
    (c >= 9 && c <= 13) ||
    c === 160 ||
    c === 5760 ||
    (c >= 8192 && c <= 8202) ||
    c === 8232 ||
    c === 8233 ||
    c === 8239 ||
    c === 8287 ||
    c === 12288 ||
    c === 65279
  );
}

/** The words of a body given as lines: runs of characters other than whitespace. */
function wordsOfLines(lines, start) {
  let count = 0;
  for (let li = start; li < lines.length; li++) {
    const line = lines[li];
    let inWord = false;
    for (let i = 0; i < line.length; i++) {
      const c = line.charCodeAt(i);
      if (c > 32) {
        if (c < 128) {
          if (!inWord) {
            inWord = true;
            count++;
          }
        } else if (
          c === 160 ||
          c === 5760 ||
          (c >= 8192 && c <= 8202) ||
          c === 8232 ||
          c === 8233 ||
          c === 8239 ||
          c === 8287 ||
          c === 12288 ||
          c === 65279
        )
          inWord = false;
        else if (!inWord) {
          inWord = true;
          count++;
        }
      } else if (c === 32 || (c >= 9 && c <= 13)) inWord = false;
      else if (!inWord) {
        inWord = true;
        count++;
      }
    }
  }
  return count;
}

// ---------------------------------------------------------------- front matter

const FM_KEYS = new Set(['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary']);
const FM_LINE = /^([a-z_]+):(?: (.*))?$/;
const FM_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const FM_NAME = /^[a-z0-9-]+$/;
const FM_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const FM_TAG = /^[^"[\]]+$/;

function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

/** A string value: "..." with \" and \\ its only escapes, or a bare value. */
function fmStringOf(raw) {
  if (raw.startsWith('"')) {
    if (raw.length < 2 || !raw.endsWith('"')) return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1)
          return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += n;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw.startsWith('[')) return { error: 'a bare string opens on [' };
  return { value: raw };
}

/** One key's value, or why it is refused. */
function fmValueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = fmStringOf(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      const m = FM_DATE.exec(raw);
      const y = m ? Number(m[1]) : 0;
      const mo = m ? Number(m[2]) : 0;
      const d = m ? Number(m[3]) : 0;
      if (!m || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo))
        return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      return { value: raw };
    }
    case 'tags': {
      if (!raw.startsWith('[') || !raw.endsWith(']')) return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',').map((t) => t.trim());
      if (tags.some((t) => t === '' || !FM_TAG.test(t)))
        return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout':
      return FM_NAME.test(raw) ? { value: raw } : { error: 'key "layout": not a template name' };
    case 'slug':
      return FM_SLUG.test(raw) && raw.length <= 64 ? { value: raw } : { error: 'key "slug": not a slug' };
    default:
      return { error: `unknown key "${key}"` };
  }
}

/** Whether `line` is blank (spaces and tabs only). Most lines start with a non-space, so that decides it at once. */
function isBlank(line) {
  if (line.length === 0) return true;
  if (line.charCodeAt(0) !== 32 && line.charCodeAt(0) !== 9) return false;
  for (let j = 1; j < line.length; j++) {
    const c = line.charCodeAt(j);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/**
 * A source's front matter from its lines: { data, bodyStart }, or { error }.
 * `lines` is the whole file split on "\n"; the body starts at line `bodyStart`.
 */
function parseFrontMatter(lines) {
  if (lines[0] !== '---') return { error: 'no front matter' };
  let close = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === '---') {
      close = i;
      break;
    }
  }
  if (close === -1) return { error: 'the front matter is not closed' };
  const data = {};
  for (let i = 1; i < close; i++) {
    const line = lines[i];
    if (isBlank(line) || line.charCodeAt(0) === 35) continue;
    const m = FM_LINE.exec(line);
    if (!m) return { error: `line ${i + 1} is not "key: value"` };
    const key = m[1];
    let raw = m[2] ?? '';
    const lastC = raw.charCodeAt(raw.length - 1);
    if (lastC === 32 || lastC === 9) raw = raw.replace(/[ \t]+$/, '');
    if (!FM_KEYS.has(key)) return { error: `unknown key "${key}"` };
    if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
    if (raw === '') return { error: `key "${key}" has no value` };
    const v = fmValueOf(key, raw);
    if ('error' in v) return v;
    data[key] = v.value;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, bodyStart: close + 1 };
}

// ---------------------------------------------------------------- markdown

/** A line with spaces and tabs at either end dropped. */
function trimLine(line) {
  let a = 0;
  let b = line.length;
  while (a < b && (line.charCodeAt(a) === 32 || line.charCodeAt(a) === 9)) a++;
  while (b > a && (line.charCodeAt(b - 1) === 32 || line.charCodeAt(b - 1) === 9)) b--;
  return a === 0 && b === line.length ? line : line.slice(a, b);
}

/** A fence's language, or null when `line` does not open one. */
function fenceOpen(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return null;
  let j = 3;
  const n = line.length;
  while (j < n) {
    const c = line.charCodeAt(j);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 43 || c === 45) j++;
    else break;
  }
  const lang = line.slice(3, j);
  while (j < n) {
    const c = line.charCodeAt(j);
    if (c !== 32 && c !== 9) return null;
    j++;
  }
  return lang;
}

/** Whether `line` closes a fence. */
function fenceClose(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return false;
  for (let j = 3; j < line.length; j++) {
    const c = line.charCodeAt(j);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** A heading line's level and text, or null. */
function headingOf(line) {
  let n = 0;
  while (n < 6 && line.charCodeAt(n) === 35) n++;
  if (n === 0) return null;
  const c = line.charCodeAt(n);
  if (c !== 32 && c !== 9) return null;
  let j = n;
  while (j < line.length && (line.charCodeAt(j) === 32 || line.charCodeAt(j) === 9)) j++;
  let e = line.length;
  while (e > j && (line.charCodeAt(e - 1) === 32 || line.charCodeAt(e - 1) === 9)) e--;
  if (e === j) return null;
  return { depth: n, text: line.slice(j, e) };
}

/** Whether `line` is a thematic break. */
function isHr(line) {
  const a = line.charCodeAt(0);
  const b = line.charCodeAt(1);
  const c = line.charCodeAt(2);
  if (!((a === 45 && b === 45 && c === 45) || (a === 42 && b === 42 && c === 42))) return false;
  for (let j = 3; j < line.length; j++) {
    const ch = line.charCodeAt(j);
    if (ch !== 32 && ch !== 9) return false;
  }
  return true;
}

/** A bullet item's text, or null when `line` does not open one. */
function bulletOf(line) {
  const a = line.charCodeAt(0);
  if ((a === 45 || a === 42) && line.charCodeAt(1) === 32) return line.slice(2);
  return null;
}

/** An ordered item's start and text, or null when `line` does not open one. */
function orderedOf(line) {
  let j = 0;
  const n = line.length;
  while (j < n && j < 9) {
    const c = line.charCodeAt(j);
    if (c < 48 || c > 57) break;
    j++;
  }
  if (j === 0) return null;
  if (line.charCodeAt(j) !== 46 || line.charCodeAt(j + 1) !== 32) return null;
  return { start: Number(line.slice(0, j)), text: line.slice(j + 2) };
}

/** Whether `line` continues a list item (two or more spaces, then a non-space). */
function isContinued(line) {
  let j = 0;
  while (line.charCodeAt(j) === 32) j++;
  if (j < 2 || j >= line.length) return false;
  return !isWSCode(line.charCodeAt(j));
}

/** Whether `line` ends a paragraph. One first-character test picks the only check that can say yes: a fence, heading or rule cannot start with a space, so an indented line ends a paragraph only by being blank. */
function endsParagraph(line) {
  if (line.length === 0) return true;
  const c = line.charCodeAt(0);
  if (c === 32 || c === 9) return isBlank(line);
  if (c === 96) return fenceOpen(line) !== null;
  if (c === 35) return headingOf(line) !== null;
  if (c === 45 || c === 42) return isHr(line);
  return false;
}

/** The characters a backslash escapes. */
const ESCAPABLE = new Set(['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']);

/** The first index from `from` where `s` holds `what` outside an escape, or -1. */
function findUnescaped(s, what, from, end) {
  const wlen = what.length;
  for (let j = from; j <= end - wlen; j++) {
    if (s[j] === '\\' && j + 1 < end && ESCAPABLE.has(s[j + 1])) {
      j++;
      continue;
    }
    if (s.startsWith(what, j)) return j;
  }
  return -1;
}

/** The first single * from `from` (one whose run is not **), outside an escape, or -1. */
function findSingleStar(s, from, end) {
  for (let j = from; j < end; j++) {
    const c = s[j];
    if (c === '\\' && j + 1 < end && ESCAPABLE.has(s[j + 1])) {
      j++;
      continue;
    }
    if (c !== '*') continue;
    if (s[j + 1] === '*') {
      j++;
      continue;
    }
    return j;
  }
  return -1;
}

const INLINE_TEST = /[\\`*\[&<>"']/;

/** Stop characters for the inline run scanner: \ ` * [ & < > " '. Found with one RegExp search instead of a per-character loop. */
const INLINE_STOP_RE = /[\\`*\[&<>"']/g;

/** `s[a..b)` rendered inline into `out`; `link(target)` is a link's href. */
function inlineInto(s, a, b, link, out) {
  let i = a;
  while (i < b) {
    INLINE_STOP_RE.lastIndex = i;
    const m = INLINE_STOP_RE.exec(s);
    const j = m === null || m.index >= b ? b : m.index;
    if (j > i) out.push(s.slice(i, j));
    if (j >= b) break;
    i = j;
    const c = s.charCodeAt(i);
    if (c === 92) {
      if (i + 1 < b && ESCAPABLE.has(s[i + 1])) {
        const n = s[i + 1];
        out.push(n === '>' ? '&gt;' : n);
        i += 2;
      } else {
        out.push('\\');
        i++;
      }
      continue;
    }
    if (c === 96) {
      const k = s.indexOf('`', i + 1);
      if (k !== -1 && k < b && k > i + 1) {
        out.push('<code>', escapeHtml(s.slice(i + 1, k)), '</code>');
        i = k + 1;
      } else {
        out.push('`');
        i++;
      }
      continue;
    }
    if (c === 42) {
      if (s[i + 1] === '*') {
        const k = findUnescaped(s, '**', i + 2, b);
        if (k > i + 2) {
          out.push('<strong>');
          inlineInto(s, i + 2, k, link, out);
          out.push('</strong>');
          i = k + 2;
        } else {
          out.push('**');
          i += 2;
        }
        continue;
      }
      const k = findSingleStar(s, i + 1, b);
      if (k > i + 1) {
        out.push('<em>');
        inlineInto(s, i + 1, k, link, out);
        out.push('</em>');
        i = k + 1;
      } else {
        out.push('*');
        i++;
      }
      continue;
    }
    if (c === 91) {
      const k = findUnescaped(s, ']', i + 1, b);
      let m = k !== -1 && s[k + 1] === '(' ? s.indexOf(')', k + 2) : -1;
      if (m >= b) m = -1;
      const target = m === -1 ? '' : s.slice(k + 2, m);
      if (target !== '' && !/\s/.test(target)) {
        out.push(`<a href="${escapeHtml(link(target))}">`);
        inlineInto(s, i + 1, k, link, out);
        out.push('</a>');
        i = m + 1;
        continue;
      }
      out.push('[');
      i++;
      continue;
    }
    if (c === 38) out.push('&amp;');
    else if (c === 60) out.push('&lt;');
    else if (c === 62) out.push('&gt;');
    else if (c === 34) out.push('&quot;');
    else out.push('&#39;');
    i++;
  }
}

/**
 * The body at `lines[start..]` rendered: its HTML, its table of contents
 * (every level 2 and 3 heading) and its excerpt (the first paragraph's HTML).
 * Inline HTML is appended straight into the block list, so no block is joined
 * on its own; only the excerpt and a heading's table-of-contents HTML are.
 */
function renderMarkdown(lines, start, link, slugCache) {
  const out = [];
  const toc = [];
  let excerpt = null;
  const ids = new Set();
  let i = start;
  const n = lines.length;
  while (i < n) {
    const line = lines[i];
    // One first-character dispatch picks the only block a line can open: a
    // fence, heading or rule cannot start with a space, so an indented line
    // is a paragraph unless it is blank. 0 blank, 1 fence, 2 heading, 3 hr,
    // 4 quote, 5 list, 6 paragraph. Verified equivalent to the old chain
    // over the practice set's 65,389 lines (dev/micro3.mjs).
    let kind = 6;
    let lang = null;
    let hd = null;
    let bl = null;
    let od = null;
    if (line.length === 0) kind = 0;
    else {
      const c0 = line.charCodeAt(0);
      if (c0 === 32 || c0 === 9) kind = isBlank(line) ? 0 : 6;
      else if (c0 === 96) {
        lang = fenceOpen(line);
        kind = lang !== null ? 1 : 6;
      } else if (c0 === 35) {
        hd = headingOf(line);
        kind = hd !== null ? 2 : 6;
      } else if (c0 === 45 || c0 === 42) {
        if (isHr(line)) kind = 3;
        else {
          bl = bulletOf(line);
          kind = bl !== null ? 5 : 6;
        }
      } else if (c0 >= 48 && c0 <= 57) {
        od = orderedOf(line);
        kind = od !== null ? 5 : 6;
      } else if (c0 === 62) kind = 4;
    }
    if (kind === 0) {
      i++;
      continue;
    }
    if (kind === 1) {
      const cls = lang === '' ? '' : ` class="language-${escapeHtml(lang)}"`;
      out.push(`<pre><code${cls}>`);
      i++;
      while (i < n && !fenceClose(lines[i])) {
        out.push(escapeHtml(lines[i]), '\n');
        i++;
      }
      i++;
      out.push('</code></pre>\n');
      continue;
    }
    if (kind === 2) {
      const id = uniqueSlug(slugify(hd.text, slugCache), ids);
      out.push(`<h${hd.depth} id="${id}">`);
      const mark = out.length;
      inlineInto(hd.text, 0, hd.text.length, link, out);
      if (hd.depth === 2 || hd.depth === 3) toc.push({ level: hd.depth, id, html: out.slice(mark).join('') });
      out.push(`</h${hd.depth}>\n`);
      i++;
      continue;
    }
    if (kind === 3) {
      out.push('<hr>\n');
      i++;
      continue;
    }
    if (kind === 4) {
      const body = [];
      while (i < n && lines[i].charCodeAt(0) === 62) {
        const l = lines[i++];
        body.push(l.slice(l.charCodeAt(1) === 32 ? 2 : 1));
      }
      const ls = [];
      for (const l of body) {
        const t = trimLine(l);
        if (t !== '') ls.push(t);
      }
      if (ls.length === 0) out.push('<blockquote>\n</blockquote>\n');
      else {
        const text = ls.join('\n');
        out.push('<blockquote>\n<p>');
        inlineInto(text, 0, text.length, link, out);
        out.push('</p>\n</blockquote>\n');
      }
      continue;
    }
    if (kind === 5) {
      const isOrdered = od !== null;
      const startNum = isOrdered ? od.start : 1;
      const items = [[trimLine(isOrdered ? od.text : bl)]];
      i++;
      while (i < n) {
        const l = lines[i];
        if (isOrdered) {
          const m = orderedOf(l);
          if (m === null) {
            if (isContinued(l)) {
              items[items.length - 1].push(trimLine(l));
              i++;
              continue;
            }
            break;
          }
          items.push([trimLine(m.text)]);
          i++;
        } else {
          const m = bulletOf(l);
          if (m === null) {
            if (isContinued(l)) {
              items[items.length - 1].push(trimLine(l));
              i++;
              continue;
            }
            break;
          }
          items.push([trimLine(m)]);
          i++;
        }
      }
      const tag = isOrdered ? 'ol' : 'ul';
      const open = isOrdered && startNum !== 1 ? `<ol start="${startNum}">` : `<${tag}>`;
      out.push(`${open}\n`);
      for (const item of items) {
        const text = item.join('\n');
        out.push('<li>');
        inlineInto(text, 0, text.length, link, out);
        out.push('</li>\n');
      }
      out.push(`</${tag}>\n`);
      continue;
    }
    const body = [trimLine(line)];
    i++;
    while (i < n && !endsParagraph(lines[i])) body.push(trimLine(lines[i++]));
    const text = body.join('\n');
    out.push('<p>');
    const mark = out.length;
    inlineInto(text, 0, text.length, link, out);
    if (excerpt === null) excerpt = out.slice(mark).join('');
    out.push('</p>\n');
  }
  return { html: out.join(''), toc, excerpt: excerpt ?? '' };
}

// ---------------------------------------------------------------- templates

/** A template that does not parse: its name and why. */
export class TemplateError extends Error {}

const T_PATH = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const T_FOR = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const T_IF = /^if (not )?(\S+)$/;
const T_INCLUDE = /^include "([a-z0-9-]+)"$/;

/** The deepest an include nests: one past it renders nothing. */
export const INCLUDE_DEPTH = 8;

/** The path `text` names, split at its dots, or a TemplateError. */
function pathOf(name, text) {
  if (!T_PATH.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

/** `src`'s tokens: text, {{ }}, {{{ }}} and {% %}, a standalone tag's line taken with it. */
function tokenizeTemplate(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) {
      text += src.slice(i);
      break;
    }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = /^[ \t]*$/.test(src.slice(lineStart, open)) && /^[ \t]*$/.test(src.slice(end, lineEnd));
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

/** The value at `path` in the scope chain: its first name from the nearest scope holding it, then own properties. */
function lk(scope, path) {
  let s = scope;
  while (s !== null && !Object.hasOwn(s.vars, path[0])) s = s.parent;
  if (s === null) return undefined;
  let v = s.vars[path[0]];
  for (let k = 1; k < path.length; k++) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
    v = v[path[k]];
  }
  return v;
}

/** A value as text: a string itself, a number in JavaScript's digits, true or false, an array's items joined by ", ", else "". */
function tv(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) {
    let s = '';
    for (let k = 0; k < v.length; k++) {
      if (k > 0) s += ', ';
      s += tv(v[k]);
    }
    return s;
  }
  return '';
}

/**
 * `esc(tv(v))` in one call: a string escaped, a number in JavaScript's
 * digits, true or false, an array's items joined by ", " then escaped, else "".
 * Exactly escapeHtml(tv(v)) for every value.
 */
function etv(v) {
  if (typeof v === 'string') return escapeHtml(v);
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) {
    let s = '';
    for (let k = 0; k < v.length; k++) {
      if (k > 0) s += ', ';
      s += tv(v[k]);
    }
    return escapeHtml(s);
  }
  return '';
}

/** Whether a value counts as true in an if. */
function tru(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

/**
 * `src` compiled into a render function (sc, T, d, esc, tv, lk, tru) -> string.
 * A for or if that is not closed, or a tag that is none, throws TemplateError.
 */
function compileTemplate(name, src) {
  const tokens = tokenizeTemplate(name, src);
  const root = { kind: 'root', code: [], elseCode: null, sc: 'sc' };
  const stack = [root];
  let uid = 0;
  // Lookup paths are hoisted into constants at the top of the function, so no
  // array is allocated for a path on every interpolation.
  const paths = new Map();
  const pathVar = (path) => {
    const key = JSON.stringify(path);
    let v = paths.get(key);
    if (v === undefined) {
      v = `P${paths.size}`;
      paths.set(key, v);
    }
    return v;
  };
  const curBody = () => {
    const top = stack[stack.length - 1];
    return top.elseCode !== null ? top.elseCode : top.code;
  };
  for (const tok of tokens) {
    const top = stack[stack.length - 1];
    if (tok.t === 'text') {
      curBody().push(`out+=${JSON.stringify(tok.text)};`);
      continue;
    }
    if (tok.t === 'var' || tok.t === 'raw') {
      const p = pathVar(tok.path);
      curBody().push(
        tok.t === 'var' ? `out+=etv(lk(${top.sc},${p}));` : `out+=tv(lk(${top.sc},${p}));`,
      );
      continue;
    }
    const tag = tok.tag;
    let m;
    if ((m = T_FOR.exec(tag)) !== null) {
      uid++;
      const scN = `s${uid}`;
      const v = `v${uid}`;
      const it = `i${uid}`;
      const path = pathOf(name, m[2]);
      const frame = { kind: 'for', code: [], elseCode: null, sc: scN };
      curBody().push(
        `{const ${v}=lk(${top.sc},${pathVar(path)});if(Array.isArray(${v})){for(let ${it}=0;${it}<${v}.length;${it}++){const ${scN}={vars:{[${JSON.stringify(m[1])}]:${v}[${it}],loop:{index:${it}+1,first:${it}===0,last:${it}===${v}.length-1,length:${v}.length}},parent:${top.sc}};`,
      );
      stack.push(frame);
    } else if ((m = T_IF.exec(tag)) !== null) {
      const path = pathOf(name, m[2]);
      const frame = {
        kind: 'if',
        code: [],
        elseCode: null,
        sc: top.sc,
        cond: `tru(lk(${top.sc},${pathVar(path)}))!==${m[1] !== undefined}`,
      };
      stack.push(frame);
    } else if (tag === 'else') {
      if (top.kind !== 'if' || top.elseCode !== null)
        throw new TemplateError(`template "${name}": an else outside an if`);
      top.elseCode = [];
    } else if (tag === 'endfor' || tag === 'endif') {
      const want = tag === 'endfor' ? 'for' : 'if';
      if (top.kind !== want)
        throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
      stack.pop();
      const parent = stack[stack.length - 1];
      if (top.kind === 'for') {
        (parent.elseCode !== null ? parent.elseCode : parent.code).push(...top.code, '}}}');
      } else {
        (parent.elseCode !== null ? parent.elseCode : parent.code).push(
          `if(${top.cond}){`,
          ...top.code,
          '}',
          top.elseCode !== null ? `else{${top.elseCode.join('')}}` : '',
        );
      }
    } else if ((m = T_INCLUDE.exec(tag)) !== null) {
      uid++;
      const f = `f${uid}`;
      curBody().push(
        `{const ${f}=T.get(${JSON.stringify(m[1])});if(${f}!==undefined&&d<8)out+=${f}(${top.sc},T,d+1,esc,tv,lk,tru,etv);}`,
      );
    } else {
      throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1)
    throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  const decls = [...paths.entries()].map(([key, v]) => `${v}=${key}`).join(',');
  return new Function(
    'sc',
    'T',
    'd',
    'esc',
    'tv',
    'lk',
    'tru',
    'etv',
    `${decls === '' ? '' : `const ${decls};`}let out="";${root.code.join('')}return out;`,
  );
}

// ---------------------------------------------------------------- build

/** The top-level directories the generator writes itself. */
export const RESERVED = Object.freeze(['posts', 'tags', 'page']);
/** The report file every build writes. */
export const REPORT_FILE = 'build-report.txt';

const SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/;

/** `rel` from the directory `dir` of a source, or null when it climbs out of the root. */
function resolvePath(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

/** A page's link record as templates read it. */
const linkOf = (s) =>
  s === null
    ? null
    : {
        title: s.data.title,
        url: s.url,
        date: s.data.date ?? '',
        date_long: s.data.date === undefined ? '' : longDate(s.data.date),
      };

/** One site's output tree: path -> text. */
export function build(input) {
  const report = [];
  const templates = new Map();
  for (const name of Object.keys(input.templates).sort(byCodeUnits)) {
    try {
      templates.set(name, compileTemplate(name, input.templates[name]));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }
  const base = input.site.base_url.replace(/\/+$/, '');
  const slugCache = new Map();

  // 1. The sources, in code-unit order of their paths; a source that is not .md is static.
  const files = [...input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  const sources = [];
  const statics = [];
  for (const f of files) {
    if (f.path.endsWith('.md')) {
      const text = f.content.includes('\r') ? f.content.replace(/\r\n?/g, '\n') : f.content;
      sources.push({ path: f.path, lines: text.split('\n') });
    } else statics.push({ path: f.path, content: f.content });
  }

  // 2. Each source's front matter: a refused source is reported and dropped, and so is a draft.
  const kept = [];
  for (const s of sources) {
    const fm = parseFrontMatter(s.lines);
    if ('error' in fm) {
      report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.bodyStart = fm.bodyStart;
    s.post = s.path.startsWith('posts/');
    const own = s.path.startsWith('tags/') ? 'tags' : s.path.startsWith('page/') ? 'page' : undefined;
    if (own !== undefined) {
      report.push(`refused ${s.path}: ${own}/ is the generator's own`);
      continue;
    }
    if (s.post && !Object.hasOwn(s.data, 'date')) {
      report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!templates.has(layout)) {
      report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      report.push(`draft ${s.path}`);
      continue;
    }
    kept.push(s);
  }

  // 3. Each page's output directory and url: its slug made unique in its directory, in source order.
  const taken = new Map();
  const takenIn = (dir) => {
    let set = taken.get(dir);
    if (set === undefined) {
      set = new Set(dir === '' ? RESERVED : []);
      taken.set(dir, set);
    }
    return set;
  };
  const bySource = new Map();
  for (const s of kept) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    const slug = uniqueSlug(s.data.slug ?? slugify(s.data.title, slugCache), takenIn(dir));
    s.slug = slug;
    s.outDir = dir === '' ? slug : `${dir}/${slug}`;
    s.url = `${base}/${s.outDir}/`;
    bySource.set(s.path, s);
  }

  // 4. Each body's Markdown, its links resolved to the pages and static files they name.
  const staticPaths = new Set(statics.map((f) => f.path));
  const broken = new Set();
  const resolved = new Map();
  const resolveCached = (dir, rel) => {
    let byDir = resolved.get(dir);
    if (byDir === undefined) {
      byDir = new Map();
      resolved.set(dir, byDir);
    }
    let path = byDir.get(rel);
    if (path === undefined) {
      path = resolvePath(dir, rel);
      byDir.set(rel, path);
    }
    return path;
  };
  for (const s of kept) {
    const dir = dirOf(s.path);
    const link = (target) => {
      if (SCHEME.test(target) || target.startsWith('/') || target.startsWith('#')) return target;
      const hash = target.indexOf('#');
      const rel = hash === -1 ? target : target.slice(0, hash);
      const frag = hash === -1 ? '' : target.slice(hash);
      const path = rel === '' ? null : resolveCached(dir, rel);
      if (path !== null && bySource.has(path)) return `${bySource.get(path).url}${frag}`;
      if (path !== null && staticPaths.has(path)) return `${base}/${path}${frag}`;
      broken.add(`broken-link ${s.path} -> ${target}`);
      return target;
    };
    const md = renderMarkdown(s.lines, s.bodyStart, link, slugCache);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
    s.words = wordsOfLines(s.lines, s.bodyStart);
  }

  // 5. The posts, newest first and then by slug; each post's newer and older neighbours.
  const posts = kept.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  posts.forEach((p, k) => {
    p.newer = k === 0 ? null : posts[k - 1];
    p.older = k === posts.length - 1 ? null : posts[k + 1];
  });

  // 6. The tags: grouped by their slug, each named as first met in the posts' order, ordered by count and then slug.
  const bySlug = new Map();
  const ownTags = (s) => {
    const seen = new Set();
    const out = [];
    for (const name of s.data.tags ?? []) {
      const slug = slugify(name, slugCache);
      if (!seen.has(slug)) {
        seen.add(slug);
        out.push(name);
      }
    }
    return out;
  };
  for (const p of posts) {
    p.tagRefs = [];
    for (const name of ownTags(p)) {
      const slug = slugify(name, slugCache);
      let tag = bySlug.get(slug);
      if (tag === undefined) {
        tag = { name, slug, url: `${base}/tags/${slug}/`, posts: [] };
        bySlug.set(slug, tag);
      }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of kept)
    if (!s.post)
      s.tagRefs = ownTags(s).map(
        (name) => bySlug.get(slugify(name, slugCache)) ?? { name, slug: slugify(name, slugCache), url: '', posts: [] },
      );
  const tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));

  // 7. Every page through its layout, the index pages and the tag pages through theirs.
  const cardOf = (s) => {
    if (s._card !== undefined) return s._card;
    const card = {
      title: s.data.title,
      url: s.url,
      date: s.data.date ?? '',
      date_long: s.data.date === undefined ? '' : longDate(s.data.date),
      summary: s.data.summary ?? '',
      excerpt: s.excerpt,
      reading_minutes: Math.max(1, Math.ceil(s.words / 200)),
      tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
    };
    s._card = card;
    return card;
  };
  const site = { title: input.site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => cardOf(p));
  const output = {};
  const render = (name, vars) => {
    const fn = templates.get(name);
    if (fn === undefined) return null;
    return fn({ vars: { site, tags: allTags, recent, ...vars }, parent: null }, templates, 0, escapeHtml, tv, lk, tru, etv);
  };
  for (const s of kept) {
    const page = {
      ...cardOf(s),
      slug: s.slug,
      content: s.html,
      toc: s.toc,
      newer: linkOf(s.newer ?? null),
      older: linkOf(s.older ?? null),
      is_post: s.post,
    };
    output[`${s.outDir}/index.html`] = render(s.layout, { page });
  }
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    const html = render('index', {
      posts: posts.slice((k - 1) * per, k * per).map((p) => cardOf(p)),
      pager: {
        number: k,
        total: pages,
        url: indexUrl(k),
        newer_url: k === 1 ? '' : indexUrl(k - 1),
        older_url: k === pages ? '' : indexUrl(k + 1),
      },
    });
    if (html !== null) output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (const t of tags) {
    const html = render('tag', {
      tag: { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => cardOf(p)) },
    });
    if (html !== null) output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (const f of statics) {
    if (Object.hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }

  // 8. The report: every refusal, draft, broken link and template that did not parse, sorted, then the counts.
  const lines = [...report, ...broken].sort(byCodeUnits);
  const pagesCount = kept.filter((s) => !s.post).length;
  lines.push(`built ${pagesCount} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  output[REPORT_FILE] = `${lines.join('\n')}\n`;
  return output;
}

/** makefun-site 1.0.0's answer for one case's input. */
export function run(input) {
  return build(input);
}
