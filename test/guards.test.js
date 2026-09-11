'use strict';

/**
 * Contract tests for the three guards.
 *
 */

const assert = require('node:assert');
const { test, describe } = require('node:test');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SCRIPTS = path.join(__dirname, '..', 'scripts');
const CARD = path.join(SCRIPTS, 'guard-card-data.js');
const BASH = path.join(SCRIPTS, 'guard-destructive-commands.js');
const STOP = path.join(SCRIPTS, 'guard-unverified-completion.js');

const BS = String.fromCharCode(92);
const CR = String.fromCharCode(13);
const NL = String.fromCharCode(10);

/** A published test PAN, and a Luhn-valid brand number that is not on the published list. */
const KNOWN_PAN = '4242424242424242';
const UNKNOWN_PAN = '4539578763621486';

function run(guard, payload) {
  const out = execFileSync(process.execPath, [guard], {
    input: typeof payload === 'string' ? payload : JSON.stringify(payload),
    encoding: 'utf8',
  });
  return out.trim() ? JSON.parse(out) : null;
}

/** The permission a PreToolUse guard returns; no output means it did not object. */
function decision(guard, payload) {
  const verdict = run(guard, payload);
  return verdict ? verdict.hookSpecificOutput.permissionDecision : 'allow';
}

const bash = (command) => decision(BASH, { tool_name: 'Bash', tool_input: { command } });

const write = (file_path, content) =>
  decision(CARD, { tool_name: 'Write', tool_input: { file_path, content } });

describe('guard-destructive-commands', () => {
  test('denies a destroy it can see plainly', () => {
    assert.equal(bash('terraform destroy -auto-approve'), 'deny');
  });

  test('judges every segment of a chain, not just the first', () => {
    assert.equal(bash('echo starting && terraform destroy'), 'deny');
  });

  test('a line continuation does not hide a destroy', () => {
    assert.equal(bash('terraform ' + BS + NL + '  destroy -auto-approve'), 'deny');
  });

  test('a line continuation does not hide a recursive S3 delete', () => {
    assert.equal(bash('aws s3 rm s3://bucket ' + BS + NL + '  --recursive'), 'deny');
  });

  test('a continuation is deleted, not spaced, so a split token rejoins', () => {
    assert.equal(bash('mvn flyway:' + BS + NL + 'clean'), 'deny');
  });

  test('a CRLF continuation behaves like a LF one', () => {
    assert.equal(bash('terraform ' + BS + CR + NL + 'destroy'), 'deny');
  });

  test('a stray hash does not disable the rest of the chain', () => {
    assert.equal(bash('echo "tag # v2" && terraform destroy'), 'deny');
  });

  test('printing a dangerous string is not running it', () => {
    assert.equal(bash('rg -n "drop table" --glob "*.sql"'), 'allow');
  });

  test('piping a dangerous string into a shell is running it', () => {
    assert.equal(bash('echo "terraform destroy" | bash'), 'deny');
  });

  test('an ordinary commit message is not a command', () => {
    assert.equal(bash('git commit -m "feat: drop table legacy_pan"'), 'allow');
    assert.equal(bash('git commit -m "add create index migration"'), 'allow');
    assert.equal(bash('git commit --message="drop schema old"'), 'allow');
  });

  test('a pull request title is not a command', () => {
    assert.equal(bash('gh pr create --title "truncate table job"'), 'allow');
  });

  test('a substitution inside a message argument is still judged', () => {
    assert.equal(bash('git commit -m "$(terraform destroy)"'), 'deny');
  });

  test('redacting a message does not excuse the rest of the chain', () => {
    assert.equal(bash('git commit -m "wip" && terraform destroy'), 'deny');
    assert.equal(bash('git commit -m "wip"; aws sqs purge-queue --queue-url u'), 'deny');
  });

  test('apply is allowed from a reviewed plan and denied without one', () => {
    assert.equal(bash('terraform apply tfplan'), 'allow');
    assert.equal(bash('terraform apply -auto-approve'), 'deny');
  });

  test('an ask rule asks', () => {
    assert.equal(bash('git reset --hard origin/main'), 'ask');
    assert.equal(bash('kubectl delete pod payments-0'), 'ask');
  });

  test('a deny anywhere outranks an ask anywhere', () => {
    assert.equal(bash('git reset --hard && terraform destroy'), 'deny');
    assert.equal(bash('terraform destroy && git reset --hard'), 'deny');
  });

  test('ordinary work is left alone', () => {
    assert.equal(bash('npm test'), 'allow');
    assert.equal(bash('git status'), 'allow');
    assert.equal(bash('mvn -q verify'), 'allow');
  });

  test('a malformed payload fails open rather than blocking the session', () => {
    assert.equal(run(BASH, 'not json at all'), null);
    assert.equal(run(BASH, {}), null);
  });
});

describe('guard-card-data', () => {
  test('denies a Luhn-valid card brand number in main source', () => {
    assert.equal(write('src/main/java/Pay.java', 'String pan = "' + UNKNOWN_PAN + '";'), 'deny');
  });

  test('allows a published test PAN in a test source', () => {
    assert.equal(write('src/test/java/PayTest.java', 'var pan = "' + KNOWN_PAN + '";'), 'allow');
  });

  test('asks rather than denies for a published test PAN in documentation', () => {
    assert.equal(write('README.md', 'Use the published test PAN ' + KNOWN_PAN + '.'), 'ask');
    assert.equal(write('docs/testing.adoc', 'card ' + KNOWN_PAN), 'ask');
  });

  test('an unknown card number in documentation is still a leak', () => {
    assert.equal(write('README.md', 'we charged ' + UNKNOWN_PAN + ' yesterday'), 'deny');
  });

  test('a published test PAN outside a test source is still refused', () => {
    assert.equal(write('src/main/resources/seed.sql', "values ('" + KNOWN_PAN + "')"), 'deny');
  });

  test('the guard does not block edits to itself', () => {
    assert.equal(write(CARD, "'" + KNOWN_PAN + "', '4111111111111111',"), 'allow');
  });

  test('the exemption is that one file, not the plugin directory', () => {
    assert.equal(write(BASH, 'const x = "' + KNOWN_PAN + '";'), 'deny');
  });

  test('denies obvious secrets', () => {
    assert.equal(write('src/main/java/A.java', 'k = "AKIAIOSFODNN7EXAMPLE";'), 'deny');
    assert.equal(write('src/main/java/B.java', '-----BEGIN ' + 'PRIVATE KEY-----'), 'deny');
    assert.equal(write('src/main/java/C.java', 'k = "sk_' + 'live_EXAMPLEEXAMPLENOTAREALKEY";'), 'deny');
  });

  test('denies logging a card number field', () => {
    assert.equal(write('src/main/java/L.java', 'log.info("pan={}", cardNumber);'), 'deny');
  });

  test('asks when a verification value sits next to persistence', () => {
    const content = ['@Column(name = "sec_val")', 'private String cvv;'].join(NL);
    assert.equal(write('src/main/java/Card.java', content), 'ask');
  });

  test('a long number that is not a card brand is left alone', () => {
    assert.equal(write('src/main/java/Id.java', 'long id = 9999999999999999L;'), 'allow');
  });

  test('reads the new text of an edit, not only a write', () => {
    assert.equal(
      decision(CARD, {
        tool_name: 'Edit',
        tool_input: {
          file_path: 'src/main/java/P.java',
          new_string: 'pan = "' + UNKNOWN_PAN + '";',
        },
      }),
      'deny');
  });

  test('reads every edit of a MultiEdit', () => {
    assert.equal(
      decision(CARD, {
        tool_name: 'MultiEdit',
        tool_input: {
          file_path: 'src/main/java/P.java',
          edits: [{ new_string: 'int a = 1;' }, { new_string: 'pan = "' + UNKNOWN_PAN + '";' }],
        },
      }),
      'deny');
  });

  test('a clean file passes', () => {
    assert.equal(write('src/main/java/Ok.java', 'int total = 42;'), 'allow');
  });

  test('a malformed payload fails open', () => {
    assert.equal(run(CARD, 'not json at all'), null);
  });
});

describe('guard-unverified-completion', () => {
  const use = (name, input) => ({ message: { content: [{ type: 'tool_use', name, input }] } });
  const edit = (file) => use('Write', { file_path: file });
  const ran = (command) => use('Bash', { command });

  function stop(entries, extra) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'payment-grade-'));
    const file = path.join(dir, 'transcript.jsonl');
    fs.writeFileSync(file, entries.map((e) => JSON.stringify(e)).join(NL));
    try {
      return run(STOP, Object.assign({ transcript_path: file }, extra || {}));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  test('blocks a source change that verified nothing', () => {
    const verdict = stop([edit('src/main/java/Pay.java')]);
    assert.equal(verdict.decision, 'block');
    assert.match(verdict.reason, /changed source and verified nothing/);
  });

  test('passes when a test run followed the change', () => {
    assert.equal(stop([edit('src/main/java/Pay.java'), ran('mvn -q verify')]), null);
  });

  test('a test run before the change proves nothing about it', () => {
    const verdict = stop([ran('mvn -q verify'), edit('src/main/java/Pay.java')]);
    assert.equal(verdict.decision, 'block');
    assert.match(verdict.reason, /last verification ran before those changes/);
  });

  test('printing a command is not running it', () => {
    assert.equal(stop([edit('src/main/java/Pay.java'), ran('echo mvn test')]).decision, 'block');
  });

  test('does not fire twice for one stop', () => {
    assert.equal(stop([edit('src/main/java/Pay.java')], { stop_hook_active: true }), null);
  });

  test('prose and CI config are not the running system', () => {
    assert.equal(stop([edit('README.md'), edit('.github/workflows/ci.yml')]), null);
  });

  test('a scratch file is not the running system', () => {
    const scratch = path.join(os.tmpdir(), 'claude', 'scratchpad', 'probe.js');
    assert.equal(stop([edit(scratch)]), null);
  });

  test('an unreadable transcript fails open', () => {
    assert.equal(run(STOP, { transcript_path: path.join(os.tmpdir(), 'nope-' + Date.now()) }), null);
    assert.equal(run(STOP, {}), null);
  });
});
