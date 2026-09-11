import assert from 'node:assert/strict';

// Diagnostic labels use subset checks; complete projected observations are
// compared separately. Never discard or reorder entries in an event journal.
export function assertSubset(actual, required) {
  if (actual === null || typeof actual !== 'object') throw new Error('Missing observed record');
  for (const [key, value] of Object.entries(required)) assert.deepEqual(actual[key], value, `Observed ${key}`);
}

// JSON.parse accepts duplicate members. Refuse them at the command/observation
// boundary, including differently escaped spellings of the same member name.
export function parseJSON(text) {
  const parsed = JSON.parse(text);
  let at = 0;
  const space = () => { while (/\s/.test(text[at] ?? '') && at < text.length) at++; };
  const quoted = () => {
    const start = at++;
    while (text[at] !== '"') { if (text[at] === '\\') at++; at++; }
    at++;
    return JSON.parse(text.slice(start, at));
  };
  const value = () => {
    space();
    if (text[at] === '"') { quoted(); return; }
    if (text[at] === '{') {
      at++; space(); const seen = new Set();
      if (text[at] !== '}') for (;;) {
        space(); const key = quoted();
        if (seen.has(key)) throw new Error(`Duplicate JSON member: ${key}`);
        seen.add(key); space(); at++; value(); space();
        if (text[at] !== ',') break;
        at++;
      }
      at++; return;
    }
    if (text[at] === '[') {
      at++; space();
      if (text[at] !== ']') for (;;) { value(); space(); if (text[at] !== ',') break; at++; }
      at++; return;
    }
    while (at < text.length && !/[\s,\]}]/.test(text[at])) at++;
  };
  value(); return parsed;
}

// Bound memory before joining chunks. A line is one complete JSON message;
// unterminated input and an oversized frame are transport failures.
export async function* replayLines(input, limit = 64 * 1024 * 1024) {
  let fragments = [];
  let size = 0;
  for await (const chunk of input) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    let start = 0;
    while (start < bytes.length) {
      const newline = bytes.indexOf(10, start);
      const end = newline < 0 ? bytes.length : newline + 1;
      const fragment = bytes.subarray(start, end);
      if (size + fragment.length > limit) throw new Error("Oversized replay frame");
      fragments.push(fragment);
      size += fragment.length;
      if (newline >= 0) {
        yield Buffer.concat(fragments, size).toString("utf8");
        fragments = [];
        size = 0;
      }
      start = end;
    }
  }
  if (size !== 0) throw new Error("Unterminated replay frame");
}
