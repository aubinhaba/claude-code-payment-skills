#!/usr/bin/env node
/**
 * Stop guard — refuses to end a turn that changed source and verified nothing.
 */

'use strict';

const fs = require('fs');

const MAX_TRANSCRIPT_BYTES = 32 * 1024 * 1024;

const MUTATING_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

/** Files whose modification demands evidence. */
const SOURCE_FILE =
  /\.(java|kt|kts|scala|groovy|gradle|xml|ya?ml|properties|sql|tf|tfvars|ts|tsx|js|jsx|py|go|rs|sh)$/i;

/** Prose, CI config and the agent's own configuration are not the running system. */
const EXCLUDED_PATH = /(^|[\\/])(\.claude|\.github|docs)([\\/]|$)|\.md$/i;

/**
 * Commands that count as evidence. Mutation testing is here because
 * `test-strength-review` treats a green suite as a claim rather than a result, and the
 * terraform entries because an infrastructure change is verified by a plan, not a test.
 */
const VERIFICATION = [
  /\bmvnw?\b[^\n]*\b(test|verify|package|install|checkstyle|spotless|sonar)\b/,
  /\bmvnw?\b[^\n]*\borg\.pitest\b|\bpitest:mutationCoverage\b/,
  /\bgradlew?\b[^\n]*\b(test|build|check|assemble|spotless|pitest)\b/,
  /\bnpm\b[^\n]*\b(test|run\s+(test|build|lint|typecheck))\b/,
  /\b(pnpm|yarn)\b[^\n]*\b(test|build|lint|typecheck)\b/,
  /\bpytest\b|\bpython\s+-m\s+pytest\b|\btox\b/,
  /\bgo\s+(test|build|vet)\b/,
  /\bcargo\s+(test|build|clippy|check)\b/,
  /\btsc\b/,
  /\bterraform\s+(validate|plan|fmt)\b/,
  /\bdocker\s+build\b/,
];

/**
 * A segment that prints a command, or asks a tool its version, has verified nothing.
 *
 * This matters more here than in the other guards, because the party this gate is aimed
 * at is the same party composing the command. `echo mvn test` satisfied a plain substring
 * match, which handed the model a one-word way out of the only rule it cannot argue with.
 */
const NOT_A_RUN = /^(echo|printf|cat|true|:)\b|--version\b|--help\b/;

/** True when some segment of the command line actually runs a build, test or plan. */
function isVerification(command) {
  return command
    .split(/\n|&&|\|\||;|\|/g)
    .map((segment) => segment.trim())
    .some((segment) => !NOT_A_RUN.test(segment) && VERIFICATION.some((re) => re.test(segment)));
}

function readTranscript(transcriptPath) {
  if (!transcriptPath) return [];
  let stat;
  try {
    stat = fs.statSync(transcriptPath);
  } catch (_) {
    return [];
  }
  if (!stat.isFile() || stat.size > MAX_TRANSCRIPT_BYTES) return [];

  const entries = [];
  for (const line of fs.readFileSync(transcriptPath, 'utf8').split('\n')) {
    if (!line) continue;
    try {
      entries.push(JSON.parse(line));
    } catch (_) {
      // A partially flushed line is not a reason to abandon the whole transcript.
    }
  }
  return entries;
}

function toolUses(entry) {
  const content = entry && entry.message && entry.message.content;
  if (!Array.isArray(content)) return [];
  return content.filter((part) => part && part.type === 'tool_use');
}

/**
 * Walks the transcript once, recording where the last source change and the last
 * verification happened. Position, not count, is what matters: a test run from before
 * the change proves nothing about it.
 */
function analyse(entries) {
  const state = {
    lastChange: null,
    lastChangeAt: -1,
    lastVerification: null,
    lastVerificationAt: -1,
    changedFiles: new Set(),
  };

  entries.forEach((entry, index) => {
    for (const use of toolUses(entry)) {
      const input = use.input || {};

      if (MUTATING_TOOLS.has(use.name)) {
        const file = input.file_path || input.notebook_path || '';
        if (SOURCE_FILE.test(file) && !EXCLUDED_PATH.test(file)) {
          state.lastChange = file;
          state.lastChangeAt = index;
          state.changedFiles.add(file);
        }
      }

      if (use.name === 'Bash' && typeof input.command === 'string') {
        if (isVerification(input.command)) {
          state.lastVerification = input.command;
          state.lastVerificationAt = index;
        }
      }
    }
  });

  return state;
}

function reason(state) {
  const changed = [...state.changedFiles];
  const listed = changed.slice(-5);
  const remainder = changed.length - listed.length;

  return [
    'payment-grade: this turn changed source and verified nothing.',
    '',
    `Modified (${changed.length}):`,
    ...listed.map((f) => `  ${f}`),
    ...(remainder > 0 ? [`  … and ${remainder} more`] : []),
    '',
    state.lastVerificationAt >= 0
      ? `The last verification ran before those changes: ${state.lastVerification}`
      : 'No build, test or plan command ran in this session.',
    '',
    'Do one of these before ending the turn:',
    '',
    '  1. Run the narrowest command that would fail if the change were wrong —',
    '     `mvn -q -pl <module> test -Dtest=<Class>` rather than the full build — and',
    '     report the command and its actual output, including a failure.',
    '  2. If the change cannot be verified here (no credentials, no runtime,',
    '     infrastructure-only), say so explicitly and name the command the user must run.',
    '',
    'A green compile is not evidence that behaviour changed correctly. See the',
    'production-readiness skill for the evidence table this gate exists to make real.',
  ].join('\n');
}

function decide(payload) {
  // The gate already fired for this stop. Blocking again would loop the session.
  if (payload.stop_hook_active) return null;

  const state = analyse(readTranscript(payload.transcript_path));
  if (state.lastChangeAt < 0) return null;
  if (state.lastVerificationAt > state.lastChangeAt) return null;

  return { decision: 'block', reason: reason(state) };
}

function main() {
  let raw = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    raw += chunk;
    if (raw.length > 8 * 1024 * 1024) process.exit(0);
  });
  process.stdin.on('end', () => {
    try {
      const verdict = decide(JSON.parse(raw));
      if (verdict) process.stdout.write(JSON.stringify(verdict));
    } catch (_) {
      // fail open, deliberately
    }
    process.exit(0);
  });
}

main();
