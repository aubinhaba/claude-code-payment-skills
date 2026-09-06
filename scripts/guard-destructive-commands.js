#!/usr/bin/env node
/**
 * PreToolUse guard — stops irreversible infrastructure and data commands.
 *
 */

'use strict';

const RULES = [
  // ---------------------------------------------------------------- terraform
  {
    decision: 'deny',
    re: /\bterraform\s+(-\S+\s+)*destroy\b/,
    reason:
      'terraform destroy tears down real infrastructure and its data. If this is genuinely ' +
      'intended, run it yourself, from a plan you have read, against the environment you ' +
      'meant. See the aws-change-review skill for what to check first.',
  },
  {
    decision: 'deny',
    re: /\bterraform\s+(-\S+\s+)*apply\b(?!.*(-target|\btfplan\b|\.tfplan\b|\.plan\b))/,
    reason:
      'terraform apply without a saved plan file applies whatever the current state and ' +
      'variables produce, which is not what was reviewed. Produce a plan (terraform plan ' +
      '-out=tfplan), review it, then apply that file.',
  },
  {
    decision: 'ask',
    re: /\bterraform\s+state\s+(rm|mv|push|replace-provider)\b/,
    reason:
      'terraform state surgery is unrecoverable without a versioned backend. Confirm the ' +
      'state backend has versioning enabled and that you have the current version id.',
  },
  {
    decision: 'deny',
    re: /\bterraform\s+(-\S+\s+)*(force-unlock)\b/,
    reason:
      'force-unlock removes a lock another apply may still be holding. Two concurrent ' +
      'applies corrupt the state. Confirm no apply is running before doing this by hand.',
  },

  // ---------------------------------------------------------------------- aws
  {
    decision: 'deny',
    re: /\baws\s+s3\s+(rm|rb)\b.*(--recursive|--force)/,
    reason: 'A recursive S3 delete has no undo unless the bucket is versioned. Verify versioning first.',
  },
  {
    decision: 'deny',
    re: /\baws\s+(rds|dynamodb|elasticache|ecr|kafka)\s+delete-\S+/,
    reason:
      'This deletes a stateful AWS resource. Take and verify a snapshot, and run the deletion ' +
      'yourself once you have its identifier.',
  },
  {
    decision: 'deny',
    re: /\baws\s+sqs\s+purge-queue\b/,
    reason:
      'Purging a queue discards messages that represent state changes not yet applied. During ' +
      'an incident this is the action people regret. Drain to a DLQ or replay instead.',
  },
  {
    decision: 'ask',
    re: /\baws\s+(iam|kms|secretsmanager)\s+(delete|put|update|attach|detach|schedule-key-deletion)\S*/,
    reason:
      'This changes identity, key or secret configuration. Confirm the blast radius: which ' +
      'principals and which running workloads depend on it.',
  },
  {
    decision: 'ask',
    re: /\baws\s+ecs\s+(update-service|delete-service)\b/,
    reason: 'This changes a running service outside the deployment pipeline, producing drift the next apply will revert.',
  },

  // ----------------------------------------------------------------- database
  {
    decision: 'deny',
    re: /\b(drop\s+(table|database|schema)|truncate\s+table)\b/i,
    reason:
      'Destructive DDL. If this belongs to a migration, it belongs in the contract phase of an ' +
      'expand/contract migration, in its own release, not in an ad-hoc command.',
  },
  {
    decision: 'deny',
    re: /\bflyway([\s:]|-maven-plugin:)(-\S+\s+)*clean\b|\bflywayClean\b|\bliquibase[\s:](-\S+\s+)*drop-?all\b|\bdropAll\b/i,
    reason:
      'flyway clean / liquibase dropAll drops every object in the schema. This exists for local ' +
      'development and has destroyed production more than once. Run it yourself if you mean it.',
  },
  {
    decision: 'ask',
    re: /\b(delete\s+from\s+\w+|update\s+\w+\s+set\b)(?!.*\bwhere\b)/i,
    reason: 'An UPDATE or DELETE with no WHERE clause touches every row. Confirm that is intended.',
  },
  {
    decision: 'ask',
    re: /\bcreate\s+(unique\s+)?index\b(?!.*concurrently)/i,
    reason:
      'CREATE INDEX without CONCURRENTLY takes a lock that queues every query on the table for ' +
      'the duration. On a large table in production that is an outage.',
  },

  // ---------------------------------------------------------------------- git
  {
    decision: 'deny',
    re: /\bgit\s+push\b(?=.*(--force(?!-with-lease)|(^|\s)-f(\s|$)))(?=.*\b(main|master|release\/|prod))/,
    reason:
      'Force-pushing a shared branch rewrites history other people have pulled. Use ' +
      '--force-with-lease on your own branch, or revert with a new commit.',
  },
  {
    decision: 'ask',
    re: /\bgit\s+(reset\s+--hard|clean\s+-[a-z]*f|checkout\s+--\s+\.)/,
    reason: 'This discards uncommitted work with no undo. Confirm nothing in the working tree is needed.',
  },

  // ------------------------------------------------------------------ generic
  {
    decision: 'deny',
    re: /\brm\s+-[a-z]*r[a-z]*f?\s+(\/(\s|$)|\/\*|~\/?(\s|$)|\$HOME(\s|$))/,
    reason: 'This removes a root or home directory tree.',
  },
  {
    decision: 'ask',
    re: /\bkubectl\s+delete\b|\bdocker\s+(system\s+prune|volume\s+rm)\b/,
    reason: 'This deletes running resources or persisted volumes. Confirm the target namespace or volume.',
  },
];

/**
 * Join line continuations and drop `#` comments, so a word inside a comment does not
 * trigger a rule. Quoted strings are deliberately left intact: a destructive command
 * hidden in a quote is still a destructive command once the shell expands it.
 */
function normalise(command) {
  return stripComments(String(command).replace(/\\\r?\n/g, '').replace(/\\n/g, ' ')).trim();
}

/**
 * Drop `#` comments without touching a `#` inside a quoted string or a URL fragment.
 *
 * The blunt version of this deleted everything after the first hash anywhere on the
 * line, so `echo "tag # v2" && terraform destroy` lost its second segment before any
 * rule could see it. One stray hash disabled every rule at once, which is the worst
 * shape a guard bug can take.
 *
 * A comment is a `#` that opens a word outside quotes. Everything else is data.
 */
function stripComments(command) {
  let out = '';
  let quote = null;
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (quote) {
      out += c;
      if (c === quote && command[i - 1] !== '\\') quote = null;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      out += c;
      continue;
    }
    if (c === '#' && (i === 0 || /\s/.test(command[i - 1]))) {
      while (i < command.length && command[i] !== '\n') i++;
      out += '\n';
      continue;
    }
    out += c;
  }
  return out;
}

/**
 * Split a compound command into the pieces the shell will actually run.
 *
 * Matching the whole command line as one string is what lets `echo starting &&
 * terraform destroy` past a guard: the first word decides, and everything chained
 * behind it is never examined. Every segment is judged on its own.
 *
 * Each piece also records whether its output is piped into the next one, because that
 * is what separates printing a dangerous string from executing it.
 */
function segments(command) {
  const separator = /(\n|&&|\|\||;|(?<!\|)\|(?!\|))/g;
  const parts = [];
  let last = 0;
  let match;
  while ((match = separator.exec(command)) !== null) {
    parts.push({ text: command.slice(last, match.index), pipedInto: match[1] === '|' });
    last = match.index + match[0].length;
  }
  parts.push({ text: command.slice(last), pipedInto: false });

  return parts
    .map((part) => ({ text: part.text.replace(/\s+/g, ' ').trim(), pipedInto: part.pipedInto }))
    .filter((part) => part.text);
}

/** Commands whose message flags carry prose the shell never executes. */
const MESSAGE_COMMAND = /^(git|gh|glab|jj|hg)\b/;
const MESSAGE_FLAG =
  /(^|\s)(-m|-F|--message|--title|--body|--description)(=|\s+)("[^"]*"|'[^']*'|\S+)/g;

/**
 * Blank the prose carried by a message flag on a version-control command.
 */
function redactMessageArguments(text) {
  if (!MESSAGE_COMMAND.test(text)) return text;
  return text.replace(MESSAGE_FLAG, (match, lead, flag, separator, value) =>
    /\$\(|`/.test(value) ? match : lead + flag + (separator === '=' ? '=' : ' ') + '""');
}

/** A segment that only reads or prints cannot destroy anything, even if it names a rule. */
const EXPLAIN_ONLY = /^(man|help|echo|printf|cat|less|grep|rg|which|type)\b/;

function decide(payload) {
  if ((payload.tool_name || '') !== 'Bash') return null;
  const command = (payload.tool_input || {}).command;
  if (!command) return null;

  // A deny anywhere in the chain outranks an ask anywhere else, whatever the rule order.
  let pending = null;

  for (const segment of segments(normalise(command))) {
    if (EXPLAIN_ONLY.test(segment.text) && !segment.pipedInto) continue;

    const text = redactMessageArguments(segment.text);

    for (const rule of RULES) {
      if (!rule.re.test(text)) continue;
      const verdict = { decision: rule.decision, reason: `payment-grade guard: ${rule.reason}` };
      if (rule.decision === 'deny') return verdict;
      if (!pending) pending = verdict;
    }
  }

  return pending;
}

function main() {
  let raw = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (c) => { raw += c; });
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
