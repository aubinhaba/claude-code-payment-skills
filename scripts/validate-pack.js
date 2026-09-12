#!/usr/bin/env node
'use strict';

/**
 * Structural validation of the payment-grade plugin.
 *
 * Plain Node, no dependencies — the same constraint the hooks hold to, so it runs
 * anywhere the pack runs.
 *
 *   node scripts/validate-pack.js
 *
 * What it is actually for: a skill whose frontmatter name does not match its directory,
 * or a hook whose path does not resolve, fails silently at install time. Claude Code
 * does not report it — the skill simply never loads and the guard never fires. This
 * turns that silence into a non-zero exit.
 *
 * `claude plugin validate` does not cover this ground: pointed at the repository it
 * checks the marketplace manifest and nothing else, and none of its modes enumerates a
 * SKILL.md or reads hooks.json.
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');

const errors = [];
const checks = [];

function fail(file, message) {
  errors.push(`${path.relative(ROOT, file).replace(/\\/g, '/')}: ${message}`);
}

function pass(message) {
  checks.push(message);
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    fail(file, `invalid JSON: ${err.message}`);
    return null;
  }
}

/** Returns the raw frontmatter block, or null when the file does not open with one. */
function frontmatter(file) {
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  if (lines[0] !== '---') return null;
  const end = lines.indexOf('---', 1);
  if (end === -1) return null;
  return lines.slice(1, end);
}

function requireKeys(file, keys) {
  const block = frontmatter(file);
  if (!block) {
    fail(file, 'missing YAML frontmatter (the file must start with ---)');
    return null;
  }
  for (const key of keys) {
    const line = block.find((l) => l.startsWith(`${key}:`));
    if (!line) {
      fail(file, `frontmatter is missing "${key}:"`);
      continue;
    }
    if (!line.slice(key.length + 1).trim()) {
      fail(file, `frontmatter key "${key}:" is empty`);
    }
  }
  return block;
}

// 1. Guard scripts parse as JavaScript.
{
  const scripts = fs
    .readdirSync(path.join(ROOT, 'scripts'))
    .filter((n) => n.startsWith('guard-') && n.endsWith('.js'))
    .map((n) => path.join(ROOT, 'scripts', n));

  if (scripts.length === 0) fail(path.join(ROOT, 'scripts'), 'no guard scripts found');
  for (const script of scripts) {
    try {
      // Node strips the shebang before parsing; `new Function` does not.
      new Function(fs.readFileSync(script, 'utf8').replace(/^#!.*/, ''));
    } catch (err) {
      fail(script, `syntax error: ${err.message}`);
    }
  }
  pass(`${scripts.length} guard scripts parsed`);
}

// 2. The plugin manifest and the marketplace entry agree with each other.
{
  const pluginPath = path.join(ROOT, '.claude-plugin', 'plugin.json');
  const marketPath = path.join(ROOT, '.claude-plugin', 'marketplace.json');
  const plugin = readJson(pluginPath);
  const market = readJson(marketPath);

  if (plugin) {
    for (const key of ['name', 'version', 'description']) {
      if (!plugin[key]) fail(pluginPath, `missing "${key}"`);
    }
    // hooks/hooks.json is loaded automatically. Naming it again in the manifest makes
    // Claude Code skip it as a duplicate and, in some modes, report a hook-load failure.
    for (const entry of [].concat(plugin.hooks || [])) {
      if (typeof entry !== 'string') continue;
      if (path.normalize(entry) === path.normalize('./hooks/hooks.json')) {
        fail(pluginPath, '"hooks" names hooks/hooks.json, which is loaded automatically; list only additional hook files');
      } else if (!fs.existsSync(path.join(ROOT, entry))) {
        fail(pluginPath, `"hooks" points at a missing file: ${entry}`);
      }
    }
  }

  if (plugin && market) {
    const entry = (market.plugins || []).find((p) => p.name === plugin.name);
    if (!entry) {
      fail(marketPath, `no plugins[] entry named "${plugin.name}"`);
    } else if (entry.version !== plugin.version) {
      // A stale marketplace version installs the wrong thing without any error.
      fail(marketPath, `version "${entry.version}" does not match plugin.json "${plugin.version}"`);
    }
  }
  pass('plugin manifest and marketplace entry agree');
}

// 3. Every wired hook resolves to a real script, and uses a form Claude Code executes.
{
  const hooksPath = path.join(ROOT, 'hooks', 'hooks.json');
  const config = readJson(hooksPath);
  let wired = 0;

  for (const matchers of Object.values((config && config.hooks) || {})) {
    for (const matcher of matchers) {
      for (const hook of matcher.hooks || []) {
        wired += 1;

        // The documented hook schema is a single `command` string. `args` is not part
        // of it, and a runtime that ignores the key runs bare `node` — which reads
        // stdin, produces nothing, and silently disables the guard.
        if (hook.args) {
          fail(
            hooksPath,
            'hook uses "args"; inline the script path into "command" so it runs on a ' +
              'runtime that only reads the documented `command` field'
          );
        }

        const script = String(hook.command || '').match(/[\w${}./-]+\.js/);
        if (!script) {
          fail(hooksPath, `hook command names no script: ${hook.command}`);
          continue;
        }
        const relative = script[0].replace(/^\$\{CLAUDE_PLUGIN_ROOT\}\//, '');
        if (!fs.existsSync(path.join(ROOT, relative))) {
          fail(hooksPath, `hook command references a missing file: ${relative}`);
        }
      }
    }
  }
  if (wired === 0) fail(hooksPath, 'no hooks wired');
  pass(`${wired} wired hooks resolve to existing scripts`);
}

// 4. Skills carry the frontmatter Claude Code needs to load them.
{
  const skillsDir = path.join(ROOT, 'skills');
  const dirs = fs
    .readdirSync(skillsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory());

  for (const dir of dirs) {
    const skill = path.join(skillsDir, dir.name, 'SKILL.md');
    if (!fs.existsSync(skill)) {
      fail(skill, 'skill directory has no SKILL.md');
      continue;
    }

    const block = requireKeys(skill, ['name', 'description']);
    if (!block) continue;

    // The directory name is the skill identity; a mismatch makes the skill unloadable.
    const declared = block.find((l) => l.startsWith('name:'));
    if (declared && declared.slice(5).trim() !== dir.name) {
      fail(skill, `frontmatter name "${declared.slice(5).trim()}" does not match directory "${dir.name}"`);
    }

    // The body stays in context for the rest of the session once the skill loads, so
    // length is a recurring cost. Long material belongs in references/.
    const lines = fs.readFileSync(skill, 'utf8').split(/\r?\n/).length;
    if (lines > 180) {
      fail(skill, `${lines} lines — move the long material into references/ (budget: 180)`);
    }

    // A reference file nobody points at is dead weight the reader still pays to skim.
    const refDir = path.join(skillsDir, dir.name, 'references');
    if (fs.existsSync(refDir)) {
      const body = fs.readFileSync(skill, 'utf8');
      for (const ref of fs.readdirSync(refDir)) {
        if (!body.includes(ref)) fail(skill, `never references references/${ref}`);
      }
    }
  }
  pass(`${dirs.length} skills checked`);
}

// 5. No IDE or machine-local artefact, and no build output, is tracked by git.
//
// The check is against what git tracks, not what sits on disk: a developer's .idea/ is
// their business, a committed one is the pack's. Outside a repository there is nothing
// to assert, so the check reports that rather than pretending to have run.
{
  const forbidden = [/(^|\/)\.idea\//, /(^|\/)\.vscode\//, /\.iml$/, /\.zip$/, /settings\.local\.json$/];
  const tracked = spawnSync('git', ['-C', ROOT, 'ls-files'], { encoding: 'utf8' });

  if (tracked.status !== 0) {
    pass('not a git repository — tracked-artefact check skipped');
  } else {
    const files = tracked.stdout.split('\n').filter(Boolean);
    for (const file of files) {
      if (forbidden.some((p) => p.test(file))) {
        fail(path.join(ROOT, file), 'IDE artefact or build output must not be committed');
      }
    }
    pass(`${files.length} tracked files carry no IDE artefact or build output`);
  }
}

// 6. The severity rubric has one source.
//
// Each review skill carries a copy so that one skill directory still works when copied on
// its own. Copies that must stay identical drift — these already had, between this
// repository and its private predecessor — so the copies are held to the canonical file.
{
  const rubricPath = path.join(ROOT, 'shared', 'severity-rubric.md');
  if (!fs.existsSync(rubricPath)) {
    fail(rubricPath, 'canonical severity rubric is missing');
  } else {
    const rubric = fs
      .readFileSync(rubricPath, 'utf8')
      .replace(/\r\n/g, '\n')
      .replace(/^<!--[\s\S]*?-->\s*/, '')
      .trim();
    let carriers = 0;
    for (const dir of fs.readdirSync(path.join(ROOT, 'skills'))) {
      const skill = path.join(ROOT, 'skills', dir, 'SKILL.md');
      if (!fs.existsSync(skill)) continue;
      const body = fs.readFileSync(skill, 'utf8').replace(/\r\n/g, '\n');
      // A review skill is one whose output opens with a VERDICT line.
      if (!/^VERDICT:/m.test(body)) continue;
      carriers += 1;
      if (!body.includes(rubric)) fail(skill, 'severity rubric differs from shared/severity-rubric.md');
    }
    if (carriers === 0) fail(rubricPath, 'no review skill carries the rubric');
    pass(`${carriers} review skills carry the canonical severity rubric`);
  }
}

for (const check of checks) console.log(`  ok  ${check}`);

if (errors.length > 0) {
  console.error(`\n${errors.length} problem(s):`);
  for (const error of errors) console.error(`  x   ${error}`);
  process.exit(1);
}

console.log('\nPack is valid.');
