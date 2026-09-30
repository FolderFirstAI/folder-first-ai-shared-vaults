import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import {
  connectSharedVaults,
  credentialConfigArguments,
  DeliveryError,
  gitChildEnvironment,
  isSupportedCredentialHelper,
  isUnsafeCredentialStore,
  inspectSharedVaults,
  parseEnrollment,
  refreshSharedVaults,
  restoreSharedVault,
  systemGitExecutableCandidates,
  validateTreeListing,
  windowsGitExecutableCandidates,
} from '../src/core.ts';
import { OperationGate } from '../src/operation-gate.ts';
import { recoveryGuidance } from '../src/recovery.ts';

interface RemoteFixture {
  remote: string;
  url: string;
  work: string;
}

interface Fixture {
  root: string;
  workspace: string;
  company: RemoteFixture;
  team: RemoteFixture;
  personalHash: string;
}

const fixedNow = (): Date => new Date('2026-09-29T12:00:00.000Z');
const deliveryOptions = { allowLocalTestUrls: true, now: fixedNow } as const;

function git(cwd: string | undefined, ...args: string[]): string {
  return execFileSync('git', args, {
    ...(cwd ? { cwd } : {}),
    encoding: 'utf8',
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function write(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, 'utf8');
}

function readNormalizedText(path: string): string {
  return readFileSync(path, 'utf8').replace(/\r\n/gu, '\n');
}

function makeRemote(root: string, name: string, files: Record<string, string>): RemoteFixture {
  const remote = join(root, 'origins', `${name}.git`);
  const work = join(root, 'stewards', name);
  mkdirSync(dirname(remote), { recursive: true });
  mkdirSync(work, { recursive: true });
  git(undefined, 'init', '--bare', '-b', 'main', remote);
  git(work, 'init', '-b', 'main');
  git(work, 'config', 'user.email', 'test@example.invalid');
  git(work, 'config', 'user.name', 'Practical AI OS test');
  for (const [path, content] of Object.entries(files)) write(join(work, path), content);
  git(work, 'add', '--all');
  git(work, 'commit', '-m', 'Initial approved content');
  const url = pathToFileURL(remote).href;
  git(work, 'remote', 'add', 'origin', url);
  git(work, 'push', '-u', 'origin', 'main');
  return { remote, url, work };
}

function commitAndPush(remote: RemoteFixture, message: string): string {
  git(remote.work, 'add', '--all');
  git(remote.work, 'commit', '-m', message);
  git(remote.work, 'push', 'origin', 'main');
  return git(remote.work, 'rev-parse', 'HEAD');
}

function enrollment(company: RemoteFixture, teams: Array<{ name: string; slug: string; remote: RemoteFixture }>): string {
  const lines = [
    'format_version: 1',
    'company:',
    `  repository_url: ${company.url}`,
    '  local_path: Shared/Company',
    '  approved_branch: main',
    'teams:',
  ];
  for (const team of teams) {
    lines.push(
      `  - name: ${team.name}`,
      `    repository_url: ${team.remote.url}`,
      `    local_path: Shared/Teams/${team.slug}`,
      '    approved_branch: main',
    );
  }
  return `${lines.join('\n')}\n`;
}

function hashPersonal(workspace: string): string {
  const folder = join(workspace, 'My Work');
  const payload = readdirSync(folder).sort().map((name) => `${name}\0${readFileSync(join(folder, name))}`).join('\0');
  return createHash('sha256').update(payload).digest('hex');
}

function fixture(t: test.TestContext): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'practical-ai-os-plugin-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const company = makeRemote(root, 'company', {
    'CONTEXT.md': '# Company context\n',
    'Context/Services.md': '# Services\nOriginal\n',
  });
  const team = makeRemote(root, 'sales', {
    'CONTEXT.md': '# Sales context\n',
    'Workflows/Proposal/CONTEXT.md': '# Proposal workflow\n',
  });
  const workspace = join(root, 'Practical AI OS');
  write(join(workspace, 'START-HERE.md'), '# Start here\n');
  write(join(workspace, 'SYSTEM-MANIFEST.yaml'), 'product: Practical AI OS\n');
  write(join(workspace, 'Shared', 'VAULTS.yaml'), enrollment(company, [{ name: 'Sales', slug: 'Sales', remote: team }]));
  write(join(workspace, 'My Work', 'private-note.md'), 'Never change this personal note.\n');
  return { root, workspace, company, team, personalHash: hashPersonal(workspace) };
}

test('strict enrollment accepts only prepared Company and Team destinations', () => {
  const valid = [
    'format_version: 1',
    'company:',
    '  repository_url: https://github.com/example/company.git',
    '  local_path: Shared/Company',
    '  approved_branch: main',
    'teams: []',
  ].join('\n');
  assert.equal(parseEnrollment(valid).length, 1);
  assert.throws(
    () => parseEnrollment(valid.replace('Shared/Company', 'My Work/Company')),
    (error: unknown) => error instanceof DeliveryError && error.code === 'invalid-config',
  );
  assert.throws(
    () => parseEnrollment(valid.replace('https://github.com/example/company.git', 'file:///tmp/company.git')),
    (error: unknown) => error instanceof DeliveryError && error.code === 'invalid-config',
  );
  assert.throws(
    () => parseEnrollment(`${valid}\nextra: true`),
    (error: unknown) => error instanceof DeliveryError && error.code === 'invalid-config',
  );
  assert.throws(
    () => parseEnrollment([
      'format_version: 1',
      'company:',
      '  repository_url: https://github.com/example/company.git',
      '  local_path: Shared/Company',
      '  approved_branch: main',
      'teams:',
      '  - name: Duplicate company',
      '    repository_url: https://github.com/example/company',
      '    local_path: Shared/Teams/Sales',
      '    approved_branch: main',
    ].join('\n')),
    (error: unknown) => error instanceof DeliveryError && error.code === 'invalid-config',
  );
  assert.throws(
    () => parseEnrollment([
      'format_version: 1',
      'company:',
      '  repository_url: https://github.com/example/company.git',
      '  local_path: Shared/Company',
      '  approved_branch: main',
      'teams:',
      '  - name: Reserved destination',
      '    repository_url: https://github.com/example/team.git',
      '    local_path: Shared/Teams/CON',
      '    approved_branch: main',
    ].join('\n')),
    (error: unknown) => error instanceof DeliveryError && error.code === 'invalid-config',
  );
});

test('unrecognized workspaces and invalid approved branches stop before shared or personal writes', async (t) => {
  const f = fixture(t);
  rmSync(join(f.workspace, 'START-HERE.md'));
  await assert.rejects(
    connectSharedVaults(f.workspace, deliveryOptions),
    (error: unknown) => error instanceof DeliveryError && error.code === 'invalid-workspace',
  );
  assert.equal(existsSync(join(f.workspace, 'Shared/Company')), false);
  assert.equal(hashPersonal(f.workspace), f.personalHash);

  write(join(f.workspace, 'START-HERE.md'), '# Start here\n');
  write(
    join(f.workspace, 'Shared/VAULTS.yaml'),
    enrollment(f.company, [{ name: 'Sales', slug: 'Sales', remote: f.team }]).replace('approved_branch: main', 'approved_branch: invalid branch'),
  );
  const report = await connectSharedVaults(f.workspace, deliveryOptions);
  assert.equal(report.sharedVaults[0]?.errorCode, 'invalid-config');
  assert.equal(existsSync(join(f.workspace, 'Shared/Company')), false);
  assert.equal(hashPersonal(f.workspace), f.personalHash);
});

test('only a deliberate connection permits credential-manager interaction', () => {
  assert.deepEqual(credentialConfigArguments(true), ['-c', 'credential.interactive=true']);
  assert.deepEqual(credentialConfigArguments(false), ['-c', 'credential.interactive=false']);
  assert.deepEqual(gitChildEnvironment(true, { PATH: '/safe/git' }), {
    PATH: '/safe/git', GIT_TERMINAL_PROMPT: '1', GCM_INTERACTIVE: '1', GCM_GUI_PROMPT: '1',
  });
  assert.deepEqual(gitChildEnvironment(false, { PATH: '/safe/git' }), {
    PATH: '/safe/git', GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: '0', GCM_GUI_PROMPT: '0',
  });
  assert.equal(isSupportedCredentialHelper('manager'), true);
  assert.equal(isSupportedCredentialHelper('manager-core'), true);
  assert.equal(isSupportedCredentialHelper("!'/Applications/GitHub Desktop.app/Contents/git-credential-manager'"), true);
  assert.equal(isSupportedCredentialHelper('/usr/local/bin/git-credential-manager'), true);
  assert.equal(isSupportedCredentialHelper('git-credential-manager'), false);
  assert.equal(isSupportedCredentialHelper('!echo unsafe; git-credential-manager'), false);
  assert.equal(isSupportedCredentialHelper("!'/Applications/GitHub Desktop.app/Contents/git-credential-manager' --extra"), false);
  assert.equal(isSupportedCredentialHelper('helper-that-mentions-git-credential-manager'), false);
  assert.equal(isSupportedCredentialHelper('osxkeychain'), false);
  assert.equal(isUnsafeCredentialStore('plaintext'), true);
  assert.equal(isUnsafeCredentialStore('cache'), true);
  assert.equal(isUnsafeCredentialStore('none'), true);
  assert.equal(isUnsafeCredentialStore('keychain'), false);
  assert.equal(isUnsafeCredentialStore('platform-default'), false);
});

test('repository tree limits reject oversized files, oversized collections and unsupported objects', () => {
  const entry = (path: string, size: number): string => `100644 blob ${'a'.repeat(40)} ${size}\t${path}\0`;
  assert.doesNotThrow(() => validateTreeListing(entry('Context/Services.md', 1024)));
  assert.throws(
    () => validateTreeListing(entry('Context/Huge.bin', (100 * 1024 * 1024) + 1)),
    (error: unknown) => error instanceof DeliveryError && error.code === 'unsafe-repository-tree',
  );
  assert.throws(
    () => validateTreeListing(Array.from({ length: 11 }, (_, index) => entry(`Context/${index}.bin`, 100 * 1024 * 1024)).join('')),
    (error: unknown) => error instanceof DeliveryError && error.code === 'unsafe-repository-tree',
  );
  assert.throws(
    () => validateTreeListing(`040000 tree ${'b'.repeat(40)} -\tContext\0`),
    (error: unknown) => error instanceof DeliveryError && error.code === 'unsafe-repository-tree',
  );
});

test('Windows Git discovery permits only deduplicated standard Git-for-Windows locations', () => {
  const candidates = windowsGitExecutableCandidates({
    ProgramFiles: 'D:\\Program Files',
    ProgramW6432: 'd:\\program files',
    'ProgramFiles(x86)': 'D:\\Program Files (x86)',
    LocalAppData: 'D:\\Users\\Employee\\AppData\\Local',
    UNSAFE_GIT_ROOT: 'D:\\Untrusted',
  });
  assert.deepEqual(candidates, [
    'D:\\Program Files\\Git\\cmd\\git.exe',
    'D:\\Program Files\\Git\\bin\\git.exe',
    'D:\\Program Files (x86)\\Git\\cmd\\git.exe',
    'D:\\Program Files (x86)\\Git\\bin\\git.exe',
    'C:\\Program Files\\Git\\cmd\\git.exe',
    'C:\\Program Files\\Git\\bin\\git.exe',
    'C:\\Program Files (x86)\\Git\\cmd\\git.exe',
    'C:\\Program Files (x86)\\Git\\bin\\git.exe',
    'D:\\Users\\Employee\\AppData\\Local\\Programs\\Git\\cmd\\git.exe',
    'D:\\Users\\Employee\\AppData\\Local\\Programs\\Git\\bin\\git.exe',
  ]);
  assert.equal(candidates.some((path) => path.includes('Untrusted')), false);
  assert.equal(systemGitExecutableCandidates('win32', { ProgramFiles: 'D:\\Program Files' }).includes('git'), false);
  assert.deepEqual(systemGitExecutableCandidates('darwin', { ProgramFiles: 'D:\\Program Files' }), ['git']);
});

test('connect, update and no-op use exact folders without touching personal work', async (t) => {
  const f = fixture(t);
  const connected = await connectSharedVaults(f.workspace, deliveryOptions);
  assert.deepEqual(
    connected.sharedVaults.map((item) => item.action),
    ['connected', 'connected'],
    JSON.stringify(connected, null, 2),
  );
  assert.equal(readNormalizedText(join(f.workspace, 'Shared/Company/Context/Services.md')), '# Services\nOriginal\n');
  assert.equal(readNormalizedText(join(f.workspace, 'Shared/Teams/Sales/CONTEXT.md')), '# Sales context\n');
  assert.equal(hashPersonal(f.workspace), f.personalHash);

  write(join(f.company.work, 'Context', 'Services.md'), '# Services\nApproved update\n');
  write(join(f.company.work, 'Context', 'New.md'), '# New approved note\n');
  rmSync(join(f.company.work, 'CONTEXT.md'));
  const incoming = commitAndPush(f.company, 'Update approved company context');
  const updated = await refreshSharedVaults(f.workspace, deliveryOptions);
  assert.equal(updated.sharedVaults[0]?.action, 'updated');
  assert.equal(updated.sharedVaults[0]?.commit, incoming);
  assert.equal(updated.sharedVaults[1]?.action, 'unchanged');
  assert.equal(existsSync(join(f.workspace, 'Shared/Company/CONTEXT.md')), false);
  assert.equal(readNormalizedText(join(f.workspace, 'Shared/Company/Context/Services.md')), '# Services\nApproved update\n');
  assert.equal(hashPersonal(f.workspace), f.personalHash);

  const noOp = await refreshSharedVaults(f.workspace, deliveryOptions);
  assert.deepEqual(noOp.sharedVaults.map((item) => item.action), ['unchanged', 'unchanged']);
  assert.equal(hashPersonal(f.workspace), f.personalHash);
});

test('one Company and multiple assigned Teams land at their prepared paths', async (t) => {
  const f = fixture(t);
  const operations = makeRemote(f.root, 'operations', {
    'CONTEXT.md': '# Operations context\n',
    'Context/Standards.md': '# Standards\n',
  });
  write(
    join(f.workspace, 'Shared/VAULTS.yaml'),
    enrollment(f.company, [
      { name: 'Sales', slug: 'Sales', remote: f.team },
      { name: 'Operations', slug: 'Operations', remote: operations },
    ]),
  );
  const report = await connectSharedVaults(f.workspace, deliveryOptions);
  assert.deepEqual(report.sharedVaults.map((item) => item.action), ['connected', 'connected', 'connected']);
  assert.equal(readNormalizedText(join(f.workspace, 'Shared/Teams/Sales/CONTEXT.md')), '# Sales context\n');
  assert.equal(readNormalizedText(join(f.workspace, 'Shared/Teams/Operations/CONTEXT.md')), '# Operations context\n');
  assert.equal(hashPersonal(f.workspace), f.personalHash);
});

test('local shared edits stop that shared vault without overwriting it', async (t) => {
  const f = fixture(t);
  await connectSharedVaults(f.workspace, deliveryOptions);
  const employeeFile = join(f.workspace, 'Shared/Company/Context/Services.md');
  write(employeeFile, '# Services\nEmployee edit\n');
  write(join(f.company.work, 'Context/Services.md'), '# Services\nApproved remote edit\n');
  commitAndPush(f.company, 'Remote edit');
  const report = await refreshSharedVaults(f.workspace, deliveryOptions);
  assert.equal(report.sharedVaults[0]?.action, 'failed');
  assert.equal(report.sharedVaults[0]?.errorCode, 'local-changes');
  assert.equal(readNormalizedText(employeeFile), '# Services\nEmployee edit\n');
  assert.equal(hashPersonal(f.workspace), f.personalHash);
});

test('confirmed restore removes only accidental shared edits and a later refresh gets approved changes', async (t) => {
  const f = fixture(t);
  await connectSharedVaults(f.workspace, deliveryOptions);
  const employeeFile = join(f.workspace, 'Shared/Company/Context/Services.md');
  const untracked = join(f.workspace, 'Shared/Company/accidental-note.md');
  write(employeeFile, '# Services\nEmployee edit\n');
  write(untracked, '# Accidental receiving-copy note\n');
  write(join(f.company.work, 'Context/Services.md'), '# Services\nApproved remote edit\n');
  const incoming = commitAndPush(f.company, 'Approved remote edit');

  const restored = await restoreSharedVault(f.workspace, 'Shared/Company', deliveryOptions);
  assert.equal(restored.operation, 'restore');
  assert.equal(restored.sharedVaults[0]?.action, 'restored');
  assert.equal(readNormalizedText(employeeFile), '# Services\nOriginal\n');
  assert.equal(existsSync(untracked), false);
  assert.equal(hashPersonal(f.workspace), f.personalHash);

  const refreshed = await refreshSharedVaults(f.workspace, deliveryOptions);
  assert.equal(refreshed.sharedVaults[0]?.action, 'updated');
  assert.equal(refreshed.sharedVaults[0]?.commit, incoming);
  assert.equal(readNormalizedText(employeeFile), '# Services\nApproved remote edit\n');
  assert.equal(hashPersonal(f.workspace), f.personalHash);
});

test('restore refuses a clean clone or local commit without changing shared or personal work', async (t) => {
  const f = fixture(t);
  await connectSharedVaults(f.workspace, deliveryOptions);
  const companyClone = join(f.workspace, 'Shared/Company');
  const clean = await restoreSharedVault(f.workspace, 'Shared/Company', deliveryOptions);
  assert.equal(clean.sharedVaults[0]?.errorCode, 'operation-failed');
  assert.equal(hashPersonal(f.workspace), f.personalHash);

  git(companyClone, 'config', 'user.email', 'employee@example.invalid');
  git(companyClone, 'config', 'user.name', 'Employee test');
  write(join(companyClone, 'unsupported-local-commit.md'), '# Unsupported local commit\n');
  git(companyClone, 'add', 'unsupported-local-commit.md');
  git(companyClone, 'commit', '-m', 'Unsupported local commit');
  write(join(companyClone, 'accidental-note.md'), '# Accidental note\n');
  const refused = await restoreSharedVault(f.workspace, 'Shared/Company', deliveryOptions);
  assert.equal(refused.sharedVaults[0]?.errorCode, 'divergent-history');
  assert.equal(existsSync(join(companyClone, 'unsupported-local-commit.md')), true);
  assert.equal(existsSync(join(companyClone, 'accidental-note.md')), true);
  assert.equal(hashPersonal(f.workspace), f.personalHash);
});

test('divergent local history and wrong origin are reported without repair', async (t) => {
  const f = fixture(t);
  await connectSharedVaults(f.workspace, deliveryOptions);
  const companyClone = join(f.workspace, 'Shared/Company');
  git(companyClone, 'config', 'user.email', 'employee@example.invalid');
  git(companyClone, 'config', 'user.name', 'Employee test');
  write(join(companyClone, 'local.md'), '# Local commit\n');
  git(companyClone, 'add', 'local.md');
  git(companyClone, 'commit', '-m', 'Unsupported local commit');
  write(join(f.company.work, 'remote.md'), '# Remote commit\n');
  commitAndPush(f.company, 'Remote commit');
  const divergence = await refreshSharedVaults(f.workspace, deliveryOptions);
  assert.equal(divergence.sharedVaults[0]?.errorCode, 'divergent-history');

  git(companyClone, 'switch', '-c', 'other');
  const wrongBranch = await inspectSharedVaults(f.workspace, deliveryOptions);
  assert.equal(wrongBranch[0]?.errorCode, 'wrong-branch');
  git(companyClone, 'switch', 'main');
  git(companyClone, 'remote', 'set-url', 'origin', f.team.url);
  const inspected = await inspectSharedVaults(f.workspace, deliveryOptions);
  assert.equal(inspected[0]?.errorCode, 'wrong-repository');
  assert.equal(hashPersonal(f.workspace), f.personalHash);
});

test('one unavailable repository does not block another approved update', async (t) => {
  const f = fixture(t);
  await connectSharedVaults(f.workspace, deliveryOptions);
  const offline = `${f.company.remote}.offline`;
  renameSync(f.company.remote, offline);
  write(join(f.team.work, 'Team-update.md'), '# Team update\n');
  const teamCommit = commitAndPush(f.team, 'Approved team update');
  const report = await refreshSharedVaults(f.workspace, deliveryOptions);
  assert.equal(report.sharedVaults[0]?.errorCode, 'remote-unavailable');
  assert.equal(report.sharedVaults[1]?.action, 'updated');
  assert.equal(report.sharedVaults[1]?.commit, teamCommit);
  assert.equal(readNormalizedText(join(f.workspace, 'Shared/Company/Context/Services.md')), '# Services\nOriginal\n');
  const serialized = JSON.stringify(report);
  assert.doesNotMatch(serialized, /file:\/\//u);
  assert.doesNotMatch(serialized, /Never change this personal note/u);
  assert.doesNotMatch(serialized, /# Team update/u);
  assert.equal(hashPersonal(f.workspace), f.personalHash);
});

test('Connect rechecks existing remote access without changing receiving copies', async (t) => {
  const f = fixture(t);
  await connectSharedVaults(f.workspace, deliveryOptions);
  const companyFile = join(f.workspace, 'Shared/Company/Context/Services.md');
  const companyBefore = readFileSync(companyFile, 'utf8');
  const offline = `${f.company.remote}.offline`;
  renameSync(f.company.remote, offline);

  const unavailable = await connectSharedVaults(f.workspace, deliveryOptions);
  assert.equal(unavailable.sharedVaults[0]?.errorCode, 'remote-unavailable');
  assert.equal(unavailable.sharedVaults[1]?.action, 'connected');
  assert.equal(readFileSync(companyFile, 'utf8'), companyBefore);
  assert.equal(hashPersonal(f.workspace), f.personalHash);

  renameSync(offline, f.company.remote);
  const restored = await connectSharedVaults(f.workspace, deliveryOptions);
  assert.equal(restored.sharedVaults[0]?.action, 'connected');
  assert.equal(readFileSync(companyFile, 'utf8'), companyBefore);
  assert.equal(hashPersonal(f.workspace), f.personalHash);
});

test('unsafe repository trees and linked destinations are refused', async (t) => {
  const f = fixture(t);
  symlinkSync('Context/Services.md', join(f.company.work, 'linked-note.md'));
  commitAndPush(f.company, 'Add forbidden symlink');
  const unsafeTree = await connectSharedVaults(f.workspace, deliveryOptions);
  assert.equal(unsafeTree.sharedVaults[0]?.errorCode, 'unsafe-repository-tree');
  assert.equal(existsSync(join(f.workspace, 'Shared/Company')), false);

  const external = join(f.root, 'external');
  mkdirSync(external);
  mkdirSync(join(f.workspace, 'Shared/Teams'), { recursive: true });
  rmSync(join(f.workspace, 'Shared/Teams/Sales'), { recursive: true, force: true });
  symlinkSync(external, join(f.workspace, 'Shared/Teams/Sales'));
  const linked = await connectSharedVaults(f.workspace, deliveryOptions);
  assert.equal(linked.sharedVaults[1]?.errorCode, 'unsafe-path');
  assert.deepEqual(readdirSync(external), []);
  assert.equal(hashPersonal(f.workspace), f.personalHash);
});

test('Git submodules are refused before a shared vault is placed', async (t) => {
  const f = fixture(t);
  const linkedCommit = git(f.team.work, 'rev-parse', 'HEAD');
  git(f.company.work, 'update-index', '--add', '--cacheinfo', `160000,${linkedCommit},Context/Linked-Repository`);
  git(f.company.work, 'commit', '-m', 'Add forbidden Git submodule');
  git(f.company.work, 'push', 'origin', 'main');
  const report = await connectSharedVaults(f.workspace, deliveryOptions);
  assert.equal(report.sharedVaults[0]?.errorCode, 'unsafe-repository-tree');
  assert.equal(existsSync(join(f.workspace, 'Shared/Company')), false);
  assert.equal(hashPersonal(f.workspace), f.personalHash);
});

test('repository-controlled checkout filters and Git LFS configuration are refused before placement', async (t) => {
  const attributesFixture = fixture(t);
  write(join(attributesFixture.company.work, '.gitattributes'), '*.md filter=unsafe-filter\n');
  commitAndPush(attributesFixture.company, 'Add forbidden checkout filter');
  const attributes = await connectSharedVaults(attributesFixture.workspace, deliveryOptions);
  assert.equal(attributes.sharedVaults[0]?.errorCode, 'unsafe-repository-tree');
  assert.equal(existsSync(join(attributesFixture.workspace, 'Shared/Company')), false);
  assert.equal(hashPersonal(attributesFixture.workspace), attributesFixture.personalHash);

  const lfsFixture = fixture(t);
  write(join(lfsFixture.company.work, '.lfsconfig'), '[lfs]\nurl = https://example.invalid/lfs\n');
  commitAndPush(lfsFixture.company, 'Add unsupported Git LFS configuration');
  const lfs = await connectSharedVaults(lfsFixture.workspace, deliveryOptions);
  assert.equal(lfs.sharedVaults[0]?.errorCode, 'unsafe-repository-tree');
  assert.equal(existsSync(join(lfsFixture.workspace, 'Shared/Company')), false);
  assert.equal(hashPersonal(lfsFixture.workspace), lfsFixture.personalHash);
});

test('case-colliding repository paths are refused before a shared vault is placed', async (t) => {
  const f = fixture(t);
  const existingBlob = git(f.company.work, 'rev-parse', 'HEAD:Context/Services.md');
  git(f.company.work, 'update-index', '--add', '--cacheinfo', `100644,${existingBlob},Context/services.md`);
  git(f.company.work, 'commit', '-m', 'Add case-colliding path');
  git(f.company.work, 'push', 'origin', 'main');
  const report = await connectSharedVaults(f.workspace, deliveryOptions);
  assert.equal(report.sharedVaults[0]?.errorCode, 'unsafe-repository-tree');
  assert.equal(existsSync(join(f.workspace, 'Shared/Company')), false);
  assert.equal(hashPersonal(f.workspace), f.personalHash);
});

test('Windows-incompatible repository paths and nonempty destinations are refused', async (t) => {
  const f = fixture(t);
  const existingBlob = git(f.company.work, 'rev-parse', 'HEAD:Context/Services.md');
  // Fixture setup only: admit an invalid NTFS path into the synthetic remote so
  // the plugin's pre-check can prove it refuses the tree before checkout.
  git(f.company.work, '-c', 'core.protectNTFS=false', 'update-index', '--add', '--cacheinfo', `100644,${existingBlob},Context/bad:name.md`);
  git(f.company.work, 'commit', '-m', 'Add Windows-incompatible path');
  git(f.company.work, 'push', 'origin', 'main');
  write(join(f.workspace, 'Shared/Teams/Sales/keep.md'), '# Existing local material\n');
  const report = await connectSharedVaults(f.workspace, deliveryOptions);
  assert.equal(report.sharedVaults[0]?.errorCode, 'unsafe-repository-tree');
  assert.equal(report.sharedVaults[1]?.errorCode, 'destination-not-empty');
  assert.equal(readNormalizedText(join(f.workspace, 'Shared/Teams/Sales/keep.md')), '# Existing local material\n');
  assert.equal(existsSync(join(f.workspace, 'Shared/Company')), false);
  assert.equal(hashPersonal(f.workspace), f.personalHash);
});

test('repository hooks are disabled during refresh', async (t) => {
  const f = fixture(t);
  await connectSharedVaults(f.workspace, deliveryOptions);
  const companyClone = join(f.workspace, 'Shared/Company');
  const marker = join(f.root, 'hook-ran.txt');
  const hook = join(companyClone, '.git/hooks/post-merge');
  write(hook, `#!/bin/sh\nprintf hook > ${JSON.stringify(marker)}\n`);
  chmodSync(hook, 0o755);
  write(join(f.company.work, 'Context/Services.md'), '# Services\nHook test update\n');
  commitAndPush(f.company, 'Hook isolation update');
  const report = await refreshSharedVaults(f.workspace, deliveryOptions);
  assert.equal(report.sharedVaults[0]?.action, 'updated');
  assert.equal(existsSync(marker), false);
  assert.equal(lstatSync(hook).isFile(), true);
  assert.equal(hashPersonal(f.workspace), f.personalHash);
});

test('rewritten remote history and an already-cancelled refresh preserve existing files', async (t) => {
  const f = fixture(t);
  await connectSharedVaults(f.workspace, deliveryOptions);
  const employeeFile = join(f.workspace, 'Shared/Company/Context/Services.md');
  const previous = readFileSync(employeeFile, 'utf8');

  git(f.company.work, 'checkout', '--orphan', 'rewritten');
  git(f.company.work, 'rm', '-rf', '.');
  write(join(f.company.work, 'Context/Services.md'), '# Services\nRewritten history\n');
  git(f.company.work, 'add', '--all');
  git(f.company.work, 'commit', '-m', 'Rewrite approved branch');
  git(f.company.work, 'push', '--force', 'origin', 'rewritten:main');

  const rewritten = await refreshSharedVaults(f.workspace, deliveryOptions);
  assert.equal(rewritten.sharedVaults[0]?.errorCode, 'divergent-history');
  assert.equal(readFileSync(employeeFile, 'utf8'), previous);
  assert.equal(hashPersonal(f.workspace), f.personalHash);

  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    refreshSharedVaults(f.workspace, { ...deliveryOptions, signal: controller.signal }),
    (error: unknown) => error instanceof DeliveryError && error.code === 'operation-failed',
  );
  assert.equal(readFileSync(employeeFile, 'utf8'), previous);
  assert.equal(hashPersonal(f.workspace), f.personalHash);
});

test('plugin-wide operation gate permits only one active Git operation and cancels safely', () => {
  const gate = new OperationGate();
  const first = gate.start();
  assert.ok(first);
  assert.equal(gate.start(), undefined);

  gate.finish(new AbortController());
  assert.equal(gate.start(), undefined);

  gate.finish(first);
  const second = gate.start();
  assert.ok(second);
  gate.cancel();
  assert.equal(second.signal.aborted, true);

  const third = gate.start();
  assert.ok(third);
  gate.finish(third);
  assert.ok(gate.start());
});

test('recovery guidance preserves shared changes and never requests a credential', () => {
  const local = recoveryGuidance('local-changes') ?? '';
  assert.match(local, /My Work\/Inbox/);
  assert.match(local, /Restore approved copy/u);
  assert.match(local, /Do not edit, delete, commit or push/u);
  assert.doesNotMatch(local, /reset|discard|password|token/i);

  const credential = recoveryGuidance('credential-manager-unavailable') ?? '';
  assert.match(credential, /Do not paste a password or token/u);
  assert.match(credential, /Connect vaults/u);
  const remote = recoveryGuidance('remote-unavailable') ?? '';
  assert.match(remote, /approved copy was kept/u);
  assert.match(remote, /Connect vaults/u);
  assert.match(remote, /Refresh all/u);
});
