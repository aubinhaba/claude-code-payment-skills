#!/usr/bin/env node
/**
 * PreToolUse guard — stops card data and obvious secrets from being written to disk.
 */

'use strict';

const path = require('path');

const OWN_SOURCE = path.resolve(__filename);

const KNOWN_TEST_PANS = new Set([
  '4242424242424242', '4111111111111111', '4000000000000002', '4000000000009995',
  '4000056655665556', '5555555555554444', '5105105105105100', '5200828282828210',
  '2223003122003222', '378282246310005', '371449635398431', '6011111111111117',
  '6011000990139424', '3566002020360505', '3530111333300000', '30569309025904',
  '38520000023237', '6200000000000005', '4917610000000000',
]);

const TEST_PATH = /(^|[\\/])(test|tests|__tests__|spec|fixtures?|testdata|mocks?)([\\/]|$)|\.(test|spec|it)\.[a-z]+$|src[\\/]test[\\/]/i;

/** Prose. A published test PAN here is a documented example, not a stored card. */
const DOC_PATH = /\.(md|markdown|mdx|txt|adoc|rst)$/i;

// Brand prefixes. Luhn alone is a 1-in-10 coincidence on any 16-digit number;
const BRAND = /^(4\d{12}(\d{3})?(\d{3})?|5[1-5]\d{14}|2(2[2-9]\d|[3-6]\d{2}|7[01]\d|720)\d{12}|3[47]\d{13}|6(011|5\d{2})\d{12}|3(0[0-5]|[68]\d)\d{11}|35(2[89]|[3-8]\d)\d{12})$/;

const DIGIT_RUN = /(?<![\w-])(?:\d[ -]?){12,18}\d(?![\w-])/g;

const LOG_CALL = /\b(log(ger)?\.(trace|debug|info|warn|error)|console\.(log|info|warn|error|debug)|System\.(out|err)\.print)/i;
const CVV_TOKEN = /\b(cvv2?|cvc2?|card_?verification|security_?code|cav2|cid)\b/i;
const CARD_CONTEXT = /\b(pan|card|credit|debit|cc_?num|primary_?account|payment_?method|visa|mastercard|amex)\b/i;
const PERSIST_CONTEXT = /@(Column|Entity|Field|Document)|create\s+table|alter\s+table|insert\s+into|\.save\(|persist\(|redis|cache\.put|outbox/i;

const SECRETS = [
  { name: 'AWS access key id', re: /\b(AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { name: 'private key block', re: /-----BEGIN (RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/ },
  { name: 'Stripe live secret key', re: /\bsk_live_[0-9a-zA-Z]{16,}\b/ },
  { name: 'GitHub token', re: /\bgh[pousr]_[0-9A-Za-z]{30,}\b/ },
  { name: 'Slack token', re: /\bxox[abprs]-[0-9A-Za-z-]{10,}\b/ },
];

function luhn(digits) {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (d < 0 || d > 9) return false;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

/** Text a Write/Edit/MultiEdit/NotebookEdit call is about to put on disk. */
function newContent(input) {
  if (!input) return '';
  const parts = [];
  if (typeof input.content === 'string') parts.push(input.content);
  if (typeof input.new_string === 'string') parts.push(input.new_string);
  if (typeof input.new_source === 'string') parts.push(input.new_source);
  if (Array.isArray(input.edits)) {
    for (const e of input.edits) {
      if (e && typeof e.new_string === 'string') parts.push(e.new_string);
    }
  }
  return parts.join('\n');
}

function findPans(text) {
  const hits = [];
  for (const match of text.matchAll(DIGIT_RUN)) {
    const digits = match[0].replace(/[ -]/g, '');
    if (digits.length < 13 || digits.length > 19) continue;
    if (!BRAND.test(digits)) continue;
    if (!luhn(digits)) continue;
    if (digits.length < 15 && !CARD_CONTEXT.test(splitIdentifiers(lineAround(text, match.index)))) continue;
    hits.push({ digits, index: match.index });
  }
  return hits;
}

function lineOf(text, index) {
  return text.slice(0, index).split('\n').length;
}

/**
 * Break identifiers at their seams so word-boundary matching sees the parts.
 *
 * Neither `cardNumber` nor `pan_number` contains a word boundary after the part that
 * matters — camelCase has none, and `_` is a word character — so `\bcard\b` missed the
 * two most common ways a card field is actually named. Splitting first restores the
 * boundaries while `cardinality`, which has no seam, stays one word and does not match.
 */
function splitIdentifiers(line) {
  return line.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/_/g, ' ');
}

/** The single line an offset falls on, used to read the words around a match. */
function lineAround(text, index) {
  const start = text.lastIndexOf('\n', index) + 1;
  const end = text.indexOf('\n', index);
  return text.slice(start, end === -1 ? text.length : end);
}

/**
 * Returns the `lines` entries within `radius` of `i`, joined.
 *
 * Java puts its annotations on their own line, so `@Column(name = "sec_val")` above
 * `private String cvv;` split the evidence across two lines and a line-local check saw
 * neither half. The window is small on purpose: widen it to the whole file and any class
 * holding a cvv field alongside an unrelated save() call starts asking.
 */
function neighbourhood(lines, i, radius) {
  return lines.slice(Math.max(0, i - radius), i + radius + 1).join('\n');
}

/** True when the write targets this guard itself, the one file it must not police. */
function isOwnSource(file) {
  if (!file) return false;
  const resolved = path.resolve(file);
  return process.platform === 'win32'
    ? resolved.toLowerCase() === OWN_SOURCE.toLowerCase()
    : resolved === OWN_SOURCE;
}

function decide(payload) {
  const input = payload.tool_input || {};
  const filePath = input.file_path || input.notebook_path || '';
  if (isOwnSource(filePath)) return null;

  const text = newContent(input);
  if (!text) return null;

  const inTestPath = TEST_PATH.test(filePath);

  for (const s of SECRETS) {
    const m = text.match(s.re);
    if (m) {
      return {
        decision: 'deny',
        reason:
          `payment-grade: refusing to write a ${s.name} into ${filePath || 'this file'} ` +
          `(line ${lineOf(text, m.index)}). Move it to the secret store and reference it ` +
          `by name. If this is a fake value for a test, make it obviously fake.`,
      };
    }
  }

  for (const pan of findPans(text)) {
    const known = KNOWN_TEST_PANS.has(pan.digits);
    const line = lineOf(text, pan.index);
    const masked = pan.digits.slice(0, 6) + '…' + pan.digits.slice(-4);

    if (known && inTestPath) continue;
    if (!known && inTestPath) {
      return {
        decision: 'ask',
        reason:
          `payment-grade: line ${line} of ${filePath} contains ${masked}, a Luhn-valid number ` +
          `with a real card brand prefix. In a test source that is usually generated test ` +
          `data and fine. Confirm it did not come from a real cardholder, and prefer one of ` +
          `the published test PANs so the next reader does not have to ask.`,
      };
    }

    if (known && DOC_PATH.test(filePath)) {
      return {
        decision: 'ask',
        reason:
          `payment-grade: ${masked} is a well-known test card number and ${filePath} is ` +
          `documentation. Published test PANs are not cardholder data, so this is usually ` +
          `fine. Confirm the number came from the published list rather than a real card, ` +
          `and remember that a reader may copy it straight out of the prose into a fixture.`,
      };
    }

    if (known && !inTestPath) {
      return {
        decision: 'deny',
        reason:
          `payment-grade: ${masked} is a well-known test card number, and ${filePath} is not a ` +
          `test path. Test PANs belong in test sources only — outside them they end up in ` +
          `fixtures, seeds and demos that later get pointed at production.`,
      };
    }

    return {
      decision: 'deny',
      reason:
        `payment-grade: line ${line} of ${filePath || 'this file'} contains ${masked}, a ` +
        `Luhn-valid number with a real card brand prefix. Writing a PAN to a source file ` +
        `puts the repository, every clone of it and its whole history inside PCI scope. ` +
        `Use a token, a masked value, or one of the published test PANs in a test source.`,
    };
  }

  // A PAN-carrying object handed to a logger: the most common leak in payment code.
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (LOG_CALL.test(l) && /\b(pan|card_?number|cardnumber|primary_?account)\b/i.test(l)) {
      return {
        decision: 'deny',
        reason:
          `payment-grade: line ${i + 1} logs a card number field. Logs are shipped, indexed ` +
          `and retained; this is the single most common PCI finding. Log the token or the ` +
          `masked value, and apply masking in the serialiser rather than at the call site.`,
      };
    }
  }

  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (!CVV_TOKEN.test(l)) continue;
    const near = neighbourhood(lines, i, 2);
    if (PERSIST_CONTEXT.test(near) || LOG_CALL.test(near)) {
      return {
        decision: 'ask',
        reason:
          `payment-grade: line ${i + 1} of ${filePath || 'this file'} looks like it stores or ` +
          `logs a CVV/CVC. The verification value must never be persisted or logged — not ` +
          `encrypted, not temporarily, not in a retry payload or an outbox row. Confirm this ` +
          `is a transient request field and not a stored one.`,
      };
    }
  }

  return null;
}

function main() {
  let raw = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    raw += chunk;
    if (raw.length > 8 * 1024 * 1024) process.exit(0); // do not scan huge payloads
  });
  process.stdin.on('end', () => {
    try {
      const verdict = decide(JSON.parse(raw));
      if (verdict) {
        process.stdout.write(JSON.stringify({
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: verdict.decision,
            permissionDecisionReason: verdict.reason,
          },
        }));
      }
    } catch (_) {
      // fail open, deliberately
    }
    process.exit(0);
  });
}

main();
