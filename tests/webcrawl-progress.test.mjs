import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { ProgressReporter, safeFailureCategory } from '../dist/compat/cli/progress.js';
import { reportPartialPublication } from '../dist/compat/cli.js';

test('progress reporter timestamps stages, rate-limits updates, and reports exact counts without a guessed total', () => {
  let time = 0;
  const lines = [];
  const reporter = new ProgressReporter((line) => lines.push(line), { now: () => time, timestamp: () => '2026-01-01T00:00:00.000Z' });
  reporter.setHost('fixture.example');
  reporter.begin('fetch');
  reporter.update({ completed: 1 });
  time = 9_999;
  reporter.update({ completed: 2 });
  time = 10_000;
  reporter.update({ completed: 3 });
  time = 10_125;
  reporter.finish({ completed: 3, captured: 3, failed: 0 });
  assert.equal(lines.length, 3);
  assert.match(lines[0], /host=fixture\.example.*fetching start/u);
  assert.match(lines[1], /fetching progress completed=3/u);
  assert.match(lines[2], /fetching complete completed=3 captured=3 failed=0 phase_ms=10125/u);
  assert.ok(lines.every((line) => !line.includes('%') && !line.includes('https://') && !line.includes('?')));
});

test('progress reporting is best-effort and failures expose only a safe category', () => {
  const reporter = new ProgressReporter(() => { throw new Error('sensitive output path'); });
  reporter.begin('preflight');
  reporter.fail('invalid_options');
  assert.equal(safeFailureCategory(new Error('output_file_already_exists: /private/path?token=secret')), 'output_conflict');
  assert.equal(safeFailureCategory(new Error('invalid_pages: https://private.example/?token=secret')), 'invalid_options');
});

test('progress-mode publication failure reports exact already-written paths as partial', () => {
  const lines = [];
  const paths = ['/private/run/audit.zip', '/private/run/audit.json', '/private/run/line\nbreak.html'];
  reportPartialPublication(paths, (line) => lines.push(line));
  assert.deepEqual(lines, [`[publication] status=partial outputs_already_written=${JSON.stringify(paths)}\n`]);

  reportPartialPublication([], (line) => lines.push(line));
  assert.equal(lines.length, 1);
});

function cli(args) {
  return spawnSync(process.execPath, ['dist/compat/cli.js', ...args], { encoding: 'utf8', timeout: 10_000 });
}

test('CLI --progress stays on stderr and rejects invalid options and collisions before discovery', async () => {
  const invalid = cli(['https://fixture.example/', '--progress', '--pages', '0']);
  assert.equal(invalid.status, 1);
  assert.equal(invalid.stdout, '');
  assert.match(invalid.stderr, /host=fixture\.example/u);
  assert.match(invalid.stderr, /failure category=invalid_options/u);
  assert.doesNotMatch(invalid.stderr, /private|https:|token=/u);
  assert.doesNotMatch(invalid.stderr, /discovery start|fetch start/u);

  const sensitive = cli(['https://fixture.example/?token=secret-value', '--progress']);
  assert.equal(sensitive.status, 1);
  assert.doesNotMatch(sensitive.stderr, /secret-value|token=|https:/u);

  const quietDefault = cli(['https://fixture.example/', '--pages', '0']);
  assert.equal(quietDefault.status, 1);
  assert.match(quietDefault.stderr, /invalid_pages/u);
  assert.doesNotMatch(quietDefault.stderr, /elapsed_ms=|failure category=/u);

  const batch = cli(['--batch', '/no/such/input.csv', '--progress']);
  assert.equal(batch.status, 1);
  assert.match(batch.stderr, /failure category=file_not_found action=check_input_files_and_output_directory/u);
  assert.doesNotMatch(batch.stderr, /no\/such|discovery start/u);

  const root = await mkdtemp(join(tmpdir(), 'webcrawl-progress-preflight-'));
  try {
    const out = join(root, 'occupied');
    await writeFile(`${out}.json`, 'keep');
    const collision = cli(['https://fixture.example/', '--out', out, '--no-pdf', '--no-pagespeed', '--progress']);
    assert.equal(collision.status, 1);
    assert.equal(collision.stdout, '');
    assert.match(collision.stderr, /failure category=output_conflict/u);
    assert.doesNotMatch(collision.stderr, /private|https:|token=|occupied|discovery start/u);
  } finally { await rm(root, { recursive: true, force: true }); }

  const incompatible = cli(['https://fixture.example/', '--progress', '--pdf', '--no-pdf']);
  assert.equal(incompatible.status, 1);
  assert.doesNotMatch(incompatible.stderr, /discovery start|fetch start/u);
});

test('CLI help advertises opt-in progress while default help remains quiet on stderr', () => {
  const result = cli(['--help']);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /\[--progress\]/u);
  assert.equal(result.stderr, '');
});

test('known failures provide allowlisted diagnostics and recovery actions without exposing error messages',()=>{
 const cases=[
  ['ERR_MODULE_NOT_FOUND','missing_dependency','install_package_dependencies'],
  ['EACCES','permission_denied','check_output_directory_permissions'],
  ['EPERM','permission_denied','check_output_directory_permissions'],
  ['ENOSPC','storage_full','free_disk_space_or_check_quota'],
  ['EDQUOT','storage_full','free_disk_space_or_check_quota'],
  ['EROFS','readonly_filesystem','choose_a_writable_output_directory'],
  ['ENOENT','file_not_found','check_input_files_and_output_directory'],
  ['EMFILE','resource_limit','close_other_processes_or_raise_file_limit'],
  ['ETIMEDOUT','operation_timeout','check_runtime_limits_and_retry'],
  ['ABORT_ERR','operation_aborted','retry_when_ready'],
  ['UNKNOWN_PRIVATE_CODE','operation_failed','inspect_audit_and_retry_if_appropriate'],
 ];
 for(const [code,category,action] of cases){
  const error=Object.assign(new Error('PRIVATE_PATH https://private.example/?token=SECRET private@example.test'),{code});
  const lines=[];const reporter=new ProgressReporter(line=>lines.push(line));
  assert.equal(safeFailureCategory(error),category);reporter.fail(safeFailureCategory(error));
  assert.match(lines.join(''),new RegExp(`failure category=${category} action=${action}`));
  assert.doesNotMatch(lines.join(''),/PRIVATE_|SECRET|https:|token=|@|UNKNOWN_PRIVATE_CODE/);
 }
 const browserError=new Error("browserType.launch: Executable doesn't exist at /PRIVATE_PATH");
 const lines=[];new ProgressReporter(line=>lines.push(line)).fail(safeFailureCategory(browserError));
 assert.match(lines.join(''),/category=browser_runtime_missing action=install_chromium_with_pnpm_exec_playwright_install_chromium/);
 assert.doesNotMatch(lines.join(''),/PRIVATE_PATH/);
});
