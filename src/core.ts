import { spawn } from 'node:child_process';
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  rmdir,
  writeFile,
} from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep, win32 } from 'node:path';
import { clearTimeout as clearNodeTimeout, setTimeout as setNodeTimeout } from 'node:timers';
import { parseDocument } from 'yaml';
import { terminateProcessTree } from './process-tree.ts';

const MAX_CONFIG_BYTES = 64 * 1024;
const MAX_GIT_OUTPUT_BYTES = 256 * 1024;
const MAX_TREE_OUTPUT_BYTES = 8 * 1024 * 1024;
const GIT_TIMEOUT_MS = 120_000;
const MAX_REPOSITORY_FILES = 25_000;
const MAX_REPOSITORY_FILE_BYTES = 100 * 1024 * 1024;
const MAX_REPOSITORY_TOTAL_BYTES = 1024 * 1024 * 1024;
const MAX_REPOSITORY_PATH_BYTES = 220;
const COMPANY_PATH = 'Shared/Company';
const TEAM_PREFIX = 'Shared/Teams/';
const SAFE_TEAM = /^[A-Za-z0-9_-]+$/;
const SAFE_GITHUB_URL = /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\.git)?$/;
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;
const WINDOWS_GIT_COMMAND = 'git';

export type SharedVaultRole = 'company' | 'team';
export type SharedVaultAction = 'connected' | 'updated' | 'unchanged' | 'restored' | 'failed';
export type LocalState = 'connected' | 'not-connected' | 'needs-attention';

export type DeliveryErrorCode =
  | 'invalid-config'
  | 'invalid-workspace'
  | 'unsafe-path'
  | 'destination-not-empty'
  | 'git-unavailable'
  | 'credential-manager-unavailable'
  | 'remote-unavailable'
  | 'wrong-repository'
  | 'wrong-branch'
  | 'local-changes'
  | 'divergent-history'
  | 'unsafe-repository-tree'
  | 'operation-timeout'
  | 'operation-failed';

export interface SharedVaultConfig {
  role: SharedVaultRole;
  name: string;
  repositoryUrl: string;
  localPath: string;
  approvedBranch: string;
}

export interface ParseOptions {
  allowLocalTestUrls?: boolean;
}

export interface DeliveryOptions extends ParseOptions {
  now?: () => Date;
  gitExecutable?: string;
  signal?: AbortSignal;
  credentialInteractive?: boolean;
}

function environmentValue(environment: NodeJS.ProcessEnv, name: string): string | undefined {
  const expected = name.toLocaleLowerCase('en-US');
  return Object.entries(environment).find(([key]) => key.toLocaleLowerCase('en-US') === expected)?.[1];
}

/**
 * Return only the conventional, absolute Git-for-Windows executable paths.
 * A normally launched GUI app can retain an older PATH even though PowerShell
 * sees a newly installed Git. This does not search arbitrary directories.
 */
export function windowsGitExecutableCandidates(
  environment: NodeJS.ProcessEnv = process.env,
): string[] {
  const roots = [
    environmentValue(environment, 'ProgramFiles'),
    environmentValue(environment, 'ProgramW6432'),
    environmentValue(environment, 'ProgramFiles(x86)'),
    'C:\\Program Files',
    'C:\\Program Files (x86)',
  ].filter((root): root is string => typeof root === 'string' && win32.isAbsolute(root));
  const localAppData = environmentValue(environment, 'LocalAppData');
  const candidates = roots.flatMap((root) => [
    win32.join(root, 'Git', 'cmd', 'git.exe'),
    win32.join(root, 'Git', 'bin', 'git.exe'),
  ]);
  if (typeof localAppData === 'string' && win32.isAbsolute(localAppData)) {
    candidates.push(
      win32.join(localAppData, 'Programs', 'Git', 'cmd', 'git.exe'),
      win32.join(localAppData, 'Programs', 'Git', 'bin', 'git.exe'),
    );
  }
  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    const key = candidate.toLocaleLowerCase('en-US');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function systemGitExecutableCandidates(
  platform: NodeJS.Platform = process.platform,
  environment: NodeJS.ProcessEnv = process.env,
): string[] {
  return platform === 'win32'
    ? windowsGitExecutableCandidates(environment)
    : [WINDOWS_GIT_COMMAND];
}

export interface SharedVaultResult {
  role: SharedVaultRole;
  name: string;
  localPath: string;
  action: SharedVaultAction;
  checkedAt: string;
  commit?: string;
  errorCode?: DeliveryErrorCode;
  message: string;
}

export interface LocalSharedVaultStatus {
  role: SharedVaultRole;
  name: string;
  localPath: string;
  state: LocalState;
  commit?: string;
  errorCode?: DeliveryErrorCode;
  message: string;
}

export interface DeliveryReport {
  checkedAt: string;
  operation: 'connect' | 'refresh' | 'restore';
  sharedVaults: SharedVaultResult[];
}

interface GitOptions {
  cwd?: string;
  gitExecutable: string;
  hooksDirectory: string;
  attributesFile: string;
  allowLocalTestUrls: boolean;
  errorCode: DeliveryErrorCode;
  errorMessage: string;
  credentialInteractive: boolean;
  maxOutputBytes?: number;
  signal?: AbortSignal;
}

export class DeliveryError extends Error {
  readonly code: DeliveryErrorCode;

  constructor(code: DeliveryErrorCode, safeMessage: string) {
    super(safeMessage);
    this.name = 'DeliveryError';
    this.code = code;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function expectExactKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const extras = Object.keys(value).filter((key) => !allowed.includes(key));
  if (extras.length > 0) {
    throw new DeliveryError('invalid-config', `${label} contains unsupported fields.`);
  }
}

function expectString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() !== value || value.length === 0) {
    throw new DeliveryError('invalid-config', `${label} must be a nonempty string without surrounding spaces.`);
  }
  if (/[\t\r\n\0]/u.test(value)) {
    throw new DeliveryError('invalid-config', `${label} contains an unsupported control character.`);
  }
  return value;
}

function validateRepositoryUrl(url: string, allowLocalTestUrls: boolean): void {
  if (SAFE_GITHUB_URL.test(url)) return;
  if (allowLocalTestUrls && url.startsWith('file://')) return;
  throw new DeliveryError('invalid-config', 'Repository URLs must be canonical GitHub HTTPS URLs.');
}

/**
 * Git accepts both the conventional repository URL and its optional `.git`
 * spelling. Treat them as one enrollment target, so a prepared configuration
 * cannot receive the same repository twice under different spellings.
 */
function repositoryKey(url: string): string {
  return url.replace(/\.git$/iu, '').toLocaleLowerCase('en-US');
}

function parseSharedVault(
  role: SharedVaultRole,
  value: unknown,
  options: ParseOptions,
  position?: number,
): SharedVaultConfig {
  if (!isRecord(value)) throw new DeliveryError('invalid-config', `${role} shared vault must be a mapping.`);
  const allowed = role === 'company'
    ? ['repository_url', 'local_path', 'approved_branch']
    : ['name', 'repository_url', 'local_path', 'approved_branch'];
  expectExactKeys(value, allowed, role === 'company' ? 'Company shared vault' : `Team ${position ?? ''}`.trim());
  const repositoryUrl = expectString(value.repository_url, `${role} repository_url`);
  const localPath = expectString(value.local_path, `${role} local_path`);
  const approvedBranch = expectString(value.approved_branch, `${role} approved_branch`);
  validateRepositoryUrl(repositoryUrl, options.allowLocalTestUrls === true);

  let name = 'Company';
  if (role === 'company') {
    if (localPath !== COMPANY_PATH) {
      throw new DeliveryError('invalid-config', `Company must use ${COMPANY_PATH}.`);
    }
  } else {
    name = expectString(value.name, 'Team name');
    if (!localPath.startsWith(TEAM_PREFIX)) {
      throw new DeliveryError('invalid-config', 'Team paths must be under Shared/Teams/.');
    }
    const slug = localPath.slice(TEAM_PREFIX.length);
    if (!SAFE_TEAM.test(slug) || WINDOWS_RESERVED.test(slug)) {
      throw new DeliveryError(
        'invalid-config',
        'Team destination must use one simple approved folder name compatible with supported employee computers.',
      );
    }
  }
  return { role, name, repositoryUrl, localPath, approvedBranch };
}

export function parseEnrollment(text: string, options: ParseOptions = {}): SharedVaultConfig[] {
  let value: unknown;
  try {
    const document = parseDocument(text, { prettyErrors: false, uniqueKeys: true });
    if (document.errors.length > 0) throw new Error('YAML parse failed');
    value = document.toJS({ maxAliasCount: 0 });
  } catch {
    throw new DeliveryError('invalid-config', 'Shared/VAULTS.yaml is not valid supported YAML.');
  }
  if (!isRecord(value)) throw new DeliveryError('invalid-config', 'Shared vault configuration must be a mapping.');
  expectExactKeys(value, ['format_version', 'company', 'teams'], 'Shared vault configuration');
  if (value.format_version !== 1) {
    throw new DeliveryError('invalid-config', 'Shared vault configuration format_version must be 1.');
  }
  const company = parseSharedVault('company', value.company, options);
  if (!Array.isArray(value.teams)) throw new DeliveryError('invalid-config', 'teams must be a list.');
  const teams = value.teams.map((team, index) => parseSharedVault('team', team, options, index + 1));
  const sharedVaults = [company, ...teams];
  const paths = new Set<string>();
  const urls = new Set<string>();
  for (const sharedVault of sharedVaults) {
    const pathKey = sharedVault.localPath.toLocaleLowerCase('en-US');
    const urlKey = repositoryKey(sharedVault.repositoryUrl);
    if (paths.has(pathKey)) throw new DeliveryError('invalid-config', 'Shared vault destinations must be unique.');
    if (urls.has(urlKey)) throw new DeliveryError('invalid-config', 'Each configured repository must be unique.');
    paths.add(pathKey);
    urls.add(urlKey);
  }
  return sharedVaults;
}

function comparePath(value: string): string {
  return process.platform === 'win32' ? value.toLocaleLowerCase('en-US') : value;
}

function isWithin(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

async function lstatIfPresent(path: string): Promise<Awaited<ReturnType<typeof lstat>> | undefined> {
  try {
    return await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

async function systemGitExecutable(options: DeliveryOptions): Promise<string | undefined> {
  if (options.gitExecutable) return options.gitExecutable;
  const candidates = systemGitExecutableCandidates();
  for (const candidate of candidates) {
    if (candidate === WINDOWS_GIT_COMMAND) return candidate;
    const info = await lstatIfPresent(candidate);
    if (info?.isFile() && !info.isSymbolicLink()) return candidate;
  }
  return undefined;
}

async function requireWorkspace(workspaceInput: string): Promise<{ workspace: string; shared: string; config: string }> {
  const workspace = await realpath(workspaceInput).catch(() => {
    throw new DeliveryError('invalid-workspace', 'The selected workspace folder is unavailable.');
  });
  for (const marker of ['START-HERE.md', 'SYSTEM-MANIFEST.yaml']) {
    const markerPath = join(workspace, marker);
    const info = await lstatIfPresent(markerPath);
    if (!info?.isFile() || info.isSymbolicLink()) {
      throw new DeliveryError('invalid-workspace', 'This folder is not a recognized Folder First AI Workspace.');
    }
  }
  const shared = join(workspace, 'Shared');
  const sharedInfo = await lstatIfPresent(shared);
  if (!sharedInfo?.isDirectory() || sharedInfo.isSymbolicLink()) {
    throw new DeliveryError('unsafe-path', 'Shared must be a normal folder inside the workspace.');
  }
  const sharedReal = await realpath(shared);
  if (comparePath(sharedReal) !== comparePath(shared)) {
    throw new DeliveryError('unsafe-path', 'Shared redirects outside its expected location.');
  }
  const config = join(shared, 'VAULTS.yaml');
  const configInfo = await lstatIfPresent(config);
  if (!configInfo?.isFile() || configInfo.isSymbolicLink() || configInfo.size > MAX_CONFIG_BYTES) {
    throw new DeliveryError('invalid-config', 'Shared/VAULTS.yaml is missing, linked or too large.');
  }
  return { workspace, shared, config };
}

async function loadSharedVaults(workspaceInput: string, options: ParseOptions): Promise<{
  workspace: string;
  shared: string;
  sharedVaults: SharedVaultConfig[];
}> {
  const { workspace, shared, config } = await requireWorkspace(workspaceInput);
  const text = await readFile(config, 'utf8');
  return { workspace, shared, sharedVaults: parseEnrollment(text, options) };
}

function destinationFor(workspace: string, localPath: string): string {
  const destination = resolve(workspace, ...localPath.split('/'));
  const permittedCompany = resolve(workspace, 'Shared', 'Company');
  const permittedTeams = resolve(workspace, 'Shared', 'Teams');
  if (
    comparePath(destination) !== comparePath(permittedCompany)
    && !isWithin(permittedTeams, destination)
  ) {
    throw new DeliveryError('unsafe-path', 'Shared vault destination is outside the approved Shared locations.');
  }
  return destination;
}

async function ensureNormalPath(workspace: string, destination: string): Promise<void> {
  if (!isWithin(workspace, destination)) {
    throw new DeliveryError('unsafe-path', 'Shared vault destination leaves the workspace.');
  }
  const rel = relative(workspace, destination);
  let cursor = workspace;
  for (const part of rel.split(sep)) {
    if (!part) continue;
    cursor = join(cursor, part);
    const info = await lstatIfPresent(cursor);
    if (info?.isSymbolicLink()) {
      throw new DeliveryError('unsafe-path', 'Shared vault path contains a symbolic link.');
    }
  }
}

async function ensureParent(workspace: string, destination: string): Promise<void> {
  const parent = dirname(destination);
  await ensureNormalPath(workspace, parent);
  const existing = await lstatIfPresent(parent);
  if (existing && !existing.isDirectory()) {
    throw new DeliveryError('unsafe-path', 'Shared vault parent is not a folder.');
  }
  if (!existing) await mkdir(parent, { recursive: true, mode: 0o700 });
  await ensureNormalPath(workspace, parent);
  const names = await readdir(parent);
  const expected = destination.slice(parent.length + 1);
  const collision = names.find((name) => name !== expected && name.toLocaleLowerCase('en-US') === expected.toLocaleLowerCase('en-US'));
  if (collision) throw new DeliveryError('unsafe-path', 'Shared vault destination has a case-insensitive name collision.');
}

export function credentialConfigArguments(credentialInteractive: boolean): string[] {
  return ['-c', `credential.interactive=${credentialInteractive ? 'true' : 'false'}`];
}

/**
 * Only a deliberate Connect may start Git Credential Manager's normal
 * browser/GUI sign-in. Refresh and restore must remain non-interactive.
 * Git's terminal-prompt flag is also observed by GCM, so it must agree with
 * the scoped credential.interactive setting above.
 */
export function gitChildEnvironment(
  credentialInteractive: boolean,
  environment: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const permitted = credentialInteractive ? '1' : '0';
  return {
    ...environment,
    GIT_TERMINAL_PROMPT: permitted,
    GCM_INTERACTIVE: permitted,
    GCM_GUI_PROMPT: permitted,
  };
}

export function isSupportedCredentialHelper(value: string): boolean {
  const helper = value.trim().toLocaleLowerCase('en-US');
  if (helper === 'manager' || helper === 'manager-core') return true;

  // macOS installations supplied by GitHub Desktop commonly configure GCM as
  // one quoted absolute shell-command path. Accept that exact shape, but do
  // not let a string pass merely because it mentions the expected executable.
  let command = helper.startsWith('!') ? helper.slice(1).trim() : helper;
  const quote = command[0];
  if (quote === "'" || quote === '"') {
    if (!command.endsWith(quote) || command.length < 3) return false;
    command = command.slice(1, -1);
  } else if (command.startsWith('/')) {
    // `git-credential-manager configure` writes GitHub Desktop's normal
    // macOS helper path with shell-escaped spaces (for example,
    // `/Applications/GitHub\\ Desktop.app/...`). Decode only that one safe
    // escape form. Reject unescaped whitespace and every other backslash
    // sequence rather than treating this as a general shell command.
    let path = '';
    for (let index = 0; index < command.length; index += 1) {
      const character = command.charAt(index);
      if (character === '\\') {
        if (command[index + 1] !== ' ') return false;
        path += ' ';
        index += 1;
      } else {
        if (/\s/u.test(character)) return false;
        path += character;
      }
    }
    command = path;
  } else if (/\s/u.test(command)) {
    return false;
  }
  if (/[\r\n\0;&|`$<>]/u.test(command)) return false;
  if (!isAbsolute(command) && !win32.isAbsolute(command)) return false;
  const executable = command.replace(/\\/gu, '/').split('/').at(-1);
  return executable === 'git-credential-manager'
    || executable === 'git-credential-manager-core'
    || executable === 'git-credential-manager.exe'
    || executable === 'git-credential-manager-core.exe';
}

export function isUnsafeCredentialStore(value: string): boolean {
  return ['plaintext', 'cache', 'none'].includes(value.trim().toLocaleLowerCase('en-US'));
}

function gitConfigArguments(
  hooksDirectory: string,
  attributesFile: string,
  allowLocalTestUrls: boolean,
  credentialInteractive: boolean,
): string[] {
  const args = [
    '-c', `core.hooksPath=${hooksDirectory}`,
    '-c', `core.attributesFile=${attributesFile}`,
    '-c', 'core.fsmonitor=false',
    '-c', 'core.untrackedCache=false',
    '-c', 'protocol.allow=never',
    '-c', 'protocol.https.allow=always',
    '-c', `protocol.file.allow=${allowLocalTestUrls ? 'always' : 'never'}`,
  ];
  return [...args, ...credentialConfigArguments(credentialInteractive)];
}

async function runGit(arguments_: string[], options: GitOptions): Promise<string> {
  const prefix = gitConfigArguments(
    options.hooksDirectory,
    options.attributesFile,
    options.allowLocalTestUrls,
    options.credentialInteractive,
  );
  return await new Promise<string>((resolvePromise, reject) => {
    if (options.signal?.aborted) {
      reject(new DeliveryError('operation-failed', 'The shared-vault operation was canceled.'));
      return;
    }
    const child = spawn(options.gitExecutable, [...prefix, ...arguments_], {
      cwd: options.cwd,
      detached: process.platform !== 'win32',
      shell: false,
      windowsHide: true,
      // Browser-based credential managers may prompt only for a deliberate
      // Connect. The plugin supplies no password/token field or terminal UI.
      env: gitChildEnvironment(options.credentialInteractive),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let outputBytes = 0;
    let exceeded = false;
    const maxOutputBytes = options.maxOutputBytes ?? MAX_GIT_OUTPUT_BYTES;
    const collect = (chunk: Buffer, retain: boolean): void => {
      outputBytes += chunk.length;
      if (outputBytes > maxOutputBytes) {
        exceeded = true;
        terminateProcessTree(child);
        return;
      }
      if (retain) stdout += chunk.toString('utf8');
    };
    child.stdout.on('data', (chunk: Buffer) => { collect(chunk, true); });
    child.stderr.on('data', (chunk: Buffer) => { collect(chunk, false); });
    const cancel = (): void => { terminateProcessTree(child); };
    options.signal?.addEventListener('abort', cancel, { once: true });
    const timer = setNodeTimeout(() => {
      terminateProcessTree(child);
      reject(new DeliveryError('operation-timeout', 'Git did not finish within the allowed time.'));
    }, GIT_TIMEOUT_MS);
    child.on('error', () => {
      clearNodeTimeout(timer);
      reject(new DeliveryError('git-unavailable', 'System Git is unavailable. Ask the implementer or IT for help.'));
    });
    child.on('close', (code) => {
      clearNodeTimeout(timer);
      options.signal?.removeEventListener('abort', cancel);
      if (exceeded) {
        reject(new DeliveryError('operation-failed', 'Git returned more diagnostic output than the plugin permits.'));
      } else if (options.signal?.aborted) {
        reject(new DeliveryError('operation-failed', 'The shared-vault operation was canceled.'));
      } else if (code !== 0) {
        reject(new DeliveryError(options.errorCode, options.errorMessage));
      } else {
        resolvePromise(stdout.trim());
      }
    });
  });
}

async function createRuntime(shared: string): Promise<{ scratch: string; hooks: string; attributes: string }> {
  const scratch = join(shared, '.folder-first-ai-delivery');
  const info = await lstatIfPresent(scratch);
  if (info?.isSymbolicLink() || (info && !info.isDirectory())) {
    throw new DeliveryError('unsafe-path', 'The plugin runtime folder is unsafe.');
  }
  await mkdir(scratch, { recursive: true, mode: 0o700 });
  const hooks = join(scratch, 'empty-hooks');
  const hookInfo = await lstatIfPresent(hooks);
  if (hookInfo?.isSymbolicLink() || (hookInfo && !hookInfo.isDirectory())) {
    throw new DeliveryError('unsafe-path', 'The plugin hook-isolation folder is unsafe.');
  }
  await mkdir(hooks, { recursive: true, mode: 0o700 });
  if ((await readdir(hooks)).length !== 0) {
    throw new DeliveryError('unsafe-path', 'The plugin hook-isolation folder is not empty.');
  }
  const attributes = join(scratch, 'empty-attributes');
  const attributesInfo = await lstatIfPresent(attributes);
  if (attributesInfo?.isSymbolicLink() || (attributesInfo && !attributesInfo.isFile())) {
    throw new DeliveryError('unsafe-path', 'The plugin attribute-isolation file is unsafe.');
  }
  if (!attributesInfo) await writeFile(attributes, '', { encoding: 'utf8', mode: 0o600 });
  return { scratch, hooks, attributes };
}

function validateRepositoryPath(path: string): void {
  const parts = path.split('/');
  if (Buffer.byteLength(path, 'utf8') > MAX_REPOSITORY_PATH_BYTES
      || path.startsWith('/') || path.includes('\\')
      || parts.some((part) => part === '' || part === '.' || part === '..')) {
    throw new DeliveryError('unsafe-repository-tree', 'Repository contains an unsafe path.');
  }
  for (const part of parts) {
    if (/[<>:"|?*\0]/u.test(part) || /[. ]$/u.test(part) || WINDOWS_RESERVED.test(part)) {
      throw new DeliveryError('unsafe-repository-tree', 'Repository contains a path incompatible with supported employee computers.');
    }
    if (part.toLocaleLowerCase('en-US') === '.git') {
      throw new DeliveryError('unsafe-repository-tree', 'Repository contains a reserved Git path.');
    }
  }
}

export function validateTreeListing(output: string): void {
  let files = 0;
  let totalBytes = 0;
  const paths = new Set<string>();
  for (const item of output.split('\0')) {
    if (!item) continue;
    files += 1;
    if (files > MAX_REPOSITORY_FILES) {
      throw new DeliveryError('unsafe-repository-tree', 'Repository contains more files than Shared Vaults supports.');
    }
    const tab = item.indexOf('\t');
    if (tab < 0) throw new DeliveryError('unsafe-repository-tree', 'Repository tree output is malformed.');
    const header = /^(\d+)\s+(\w+)\s+([0-9a-f]+)\s+(-|\d+)$/u.exec(item.slice(0, tab));
    if (!header) throw new DeliveryError('unsafe-repository-tree', 'Repository tree output is malformed.');
    const path = item.slice(tab + 1);
    const mode = header[1];
    const type = header[2];
    const sizeText = header[4];
    if (mode === '120000' || mode === '160000' || type === 'commit') {
      throw new DeliveryError('unsafe-repository-tree', 'Repository symlinks and submodules are not permitted.');
    }
    if (type !== 'blob' || sizeText === undefined || !/^\d+$/u.test(sizeText)) {
      throw new DeliveryError('unsafe-repository-tree', 'Repository tree contains an unsupported object.');
    }
    const size = Number(sizeText);
    if (!Number.isSafeInteger(size) || size > MAX_REPOSITORY_FILE_BYTES) {
      throw new DeliveryError('unsafe-repository-tree', 'Repository contains a file larger than Shared Vaults supports.');
    }
    totalBytes += size;
    if (!Number.isSafeInteger(totalBytes) || totalBytes > MAX_REPOSITORY_TOTAL_BYTES) {
      throw new DeliveryError('unsafe-repository-tree', 'Repository contents are larger than Shared Vaults supports.');
    }
    validateRepositoryPath(path);
    const fileName = path.split('/').at(-1)?.toLocaleLowerCase('en-US');
    if (fileName === '.gitattributes' || fileName === '.lfsconfig') {
      throw new DeliveryError(
        'unsafe-repository-tree',
        'Repository-controlled checkout filters and Git LFS configuration are not supported.',
      );
    }
    const key = path.toLocaleLowerCase('en-US');
    if (paths.has(key)) {
      throw new DeliveryError('unsafe-repository-tree', 'Repository contains paths that collide on supported computers.');
    }
    paths.add(key);
  }
}

async function verifyTree(ref: string, git: GitOptions): Promise<void> {
  const output = await runGit(['ls-tree', '-r', '-z', '--full-tree', '-l', ref], {
    ...git,
    maxOutputBytes: MAX_TREE_OUTPUT_BYTES,
    errorCode: 'unsafe-repository-tree',
    errorMessage: 'Repository contents could not be inspected safely.',
  });
  validateTreeListing(output);
}

async function validateBranch(branch: string, git: GitOptions): Promise<void> {
  await runGit(['check-ref-format', '--branch', branch], {
    ...git,
    errorCode: 'invalid-config',
    errorMessage: 'An approved branch name is invalid.',
  });
}

async function requireExpectedClone(
  destination: string,
  sharedVault: SharedVaultConfig,
  git: GitOptions,
): Promise<{ head: string; status: string }> {
  const info = await lstatIfPresent(destination);
  if (!info?.isDirectory() || info.isSymbolicLink()) {
    throw new DeliveryError('unsafe-path', 'Configured shared vault is missing or is not a normal folder.');
  }
  const gitInfo = await lstatIfPresent(join(destination, '.git'));
  if (!gitInfo?.isDirectory() || gitInfo.isSymbolicLink()) {
    throw new DeliveryError('wrong-repository', 'Configured shared vault is not the expected standalone Git clone.');
  }
  const physical = await realpath(destination);
  if (comparePath(physical) !== comparePath(destination)) {
    throw new DeliveryError('unsafe-path', 'Configured shared vault redirects to another location.');
  }
  const top = await runGit(['rev-parse', '--show-toplevel'], {
    ...git,
    cwd: destination,
    errorCode: 'wrong-repository',
    errorMessage: 'Configured shared vault is not a valid Git clone.',
  });
  if (comparePath(await realpath(top)) !== comparePath(destination)) {
    throw new DeliveryError('wrong-repository', 'Configured shared vault is a nested or linked Git worktree.');
  }
  const origin = await runGit(['config', '--get', 'remote.origin.url'], {
    ...git,
    cwd: destination,
    errorCode: 'wrong-repository',
    errorMessage: 'Configured shared vault origin is missing.',
  });
  if (origin !== sharedVault.repositoryUrl) {
    throw new DeliveryError('wrong-repository', 'Configured shared vault points to a different repository.');
  }
  const branch = await runGit(['symbolic-ref', '--quiet', '--short', 'HEAD'], {
    ...git,
    cwd: destination,
    errorCode: 'wrong-branch',
    errorMessage: 'Configured shared vault is not on its approved branch.',
  });
  if (branch !== sharedVault.approvedBranch) {
    throw new DeliveryError('wrong-branch', 'Configured shared vault is not on its approved branch.');
  }
  const status = await runGit(['status', '--porcelain=v1', '--untracked-files=all'], {
    ...git,
    cwd: destination,
    errorCode: 'operation-failed',
    errorMessage: 'Configured shared vault status could not be checked.',
  });
  const head = await runGit(['rev-parse', 'HEAD'], {
    ...git,
    cwd: destination,
    errorCode: 'operation-failed',
    errorMessage: 'Configured shared vault revision could not be read.',
  });
  return { head, status };
}

async function requireCleanClone(destination: string, sharedVault: SharedVaultConfig, git: GitOptions): Promise<string> {
  const clone = await requireExpectedClone(destination, sharedVault, git);
  if (clone.status !== '') {
    throw new DeliveryError('local-changes', 'Local shared-vault edits were found; no update was applied.');
  }
  return clone.head;
}

async function cloneSharedVault(
  workspace: string,
  shared: string,
  sharedVault: SharedVaultConfig,
  gitBase: Omit<GitOptions, 'cwd' | 'errorCode' | 'errorMessage'>,
): Promise<string> {
  const destination = destinationFor(workspace, sharedVault.localPath);
  await ensureParent(workspace, destination);
  await ensureNormalPath(workspace, destination);
  const existing = await lstatIfPresent(destination);
  if (existing) {
    if (!existing.isDirectory() || existing.isSymbolicLink()) {
      throw new DeliveryError('unsafe-path', 'Shared vault destination is not a normal folder.');
    }
    if ((await readdir(destination)).length > 0) {
      throw new DeliveryError('destination-not-empty', 'Shared vault destination already contains files; setup stopped without changing them.');
    }
  }

  const { scratch } = await createRuntime(shared);
  const staging = await mkdtemp(join(scratch, 'clone-'));
  const git: GitOptions = {
    ...gitBase,
    cwd: staging,
    errorCode: 'remote-unavailable',
    errorMessage: 'Repository could not be downloaded. Check connection, sign-in and access.',
  };
  try {
    await runGit([
      'clone', '--no-checkout', '--single-branch', '--no-tags',
      '--branch', sharedVault.approvedBranch, sharedVault.repositoryUrl, staging,
    ], git);
    const stagingGit = { ...git, cwd: staging };
    const remoteRef = `refs/remotes/origin/${sharedVault.approvedBranch}`;
    await verifyTree(remoteRef, stagingGit);
    await runGit(['checkout', '--quiet', '-B', sharedVault.approvedBranch, '--track', `origin/${sharedVault.approvedBranch}`], {
      ...stagingGit,
      errorCode: 'operation-failed',
      errorMessage: 'Downloaded repository could not be prepared safely.',
    });
    const commit = await requireCleanClone(staging, sharedVault, stagingGit);
    const beforeInstall = await lstatIfPresent(destination);
    if (beforeInstall) {
      if (!beforeInstall.isDirectory() || beforeInstall.isSymbolicLink()) {
        throw new DeliveryError('unsafe-path', 'Shared vault destination changed during setup; no clone was installed.');
      }
      if ((await readdir(destination)).length > 0) {
        throw new DeliveryError('destination-not-empty', 'Shared vault destination changed during setup; no clone was installed.');
      }
      await rmdir(destination);
    }
    try {
      await rename(staging, destination);
    } catch {
      if (beforeInstall) await mkdir(destination, { recursive: false, mode: 0o700 }).catch(() => undefined);
      throw new DeliveryError('operation-failed', 'Downloaded shared vault could not be placed in the workspace.');
    }
    return commit;
  } finally {
    await rm(staging, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function refreshSharedVault(
  workspace: string,
  sharedVault: SharedVaultConfig,
  gitBase: Omit<GitOptions, 'cwd' | 'errorCode' | 'errorMessage'>,
): Promise<{ action: 'updated' | 'unchanged'; commit: string }> {
  const destination = destinationFor(workspace, sharedVault.localPath);
  await ensureNormalPath(workspace, destination);
  const git = { ...gitBase, cwd: destination } as GitOptions;
  const before = await requireCleanClone(destination, sharedVault, git);
  await runGit(['fetch', '--quiet', '--no-tags', 'origin', sharedVault.approvedBranch], {
    ...git,
    errorCode: 'remote-unavailable',
    errorMessage: 'Repository could not be checked. The previous local copy was kept.',
  });
  const afterFetch = await runGit(['status', '--porcelain=v1', '--untracked-files=all'], {
    ...git,
    errorCode: 'operation-failed',
    errorMessage: 'Local status could not be rechecked after download.',
  });
  if (afterFetch !== '') {
    throw new DeliveryError('local-changes', 'Local shared-vault edits appeared during refresh; no update was applied.');
  }
  const current = await runGit(['rev-parse', 'HEAD'], {
    ...git,
    errorCode: 'operation-failed',
    errorMessage: 'Local revision changed during refresh.',
  });
  if (current !== before) {
    throw new DeliveryError('divergent-history', 'Local shared-vault history changed during refresh; no update was applied.');
  }
  const incoming = await runGit(['rev-parse', 'FETCH_HEAD'], {
    ...git,
    errorCode: 'operation-failed',
    errorMessage: 'Downloaded revision could not be verified.',
  });
  await verifyTree(incoming, git);
  if (incoming === before) return { action: 'unchanged', commit: before };
  await runGit(['merge-base', '--is-ancestor', before, incoming], {
    ...git,
    errorCode: 'divergent-history',
    errorMessage: 'Shared-vault history diverged or has local commits; no update was applied.',
  });
  await runGit(['merge', '--ff-only', '--quiet', incoming], {
    ...git,
    errorCode: 'operation-failed',
    errorMessage: 'Fast-forward update could not be completed safely.',
  });
  const applied = await requireCleanClone(destination, sharedVault, git);
  if (applied !== incoming) {
    throw new DeliveryError('operation-failed', 'Applied revision did not match the verified download.');
  }
  return { action: 'updated', commit: applied };
}

/**
 * Deliberately contact the configured GitHub remote during Connect, even when
 * the receiving clone already exists. This gives Git Credential Manager a
 * safe, user-initiated opportunity to repair an expired or missing sign-in
 * without changing the local checkout.
 */
async function verifyRemoteConnection(
  destination: string,
  sharedVault: SharedVaultConfig,
  gitBase: Omit<GitOptions, 'cwd' | 'errorCode' | 'errorMessage'>,
): Promise<void> {
  await runGit(['ls-remote', '--exit-code', 'origin', `refs/heads/${sharedVault.approvedBranch}`], {
    ...gitBase,
    cwd: destination,
    errorCode: 'remote-unavailable',
    errorMessage: 'Repository access could not be confirmed. Check connection, sign-in and access.',
  });
}

/**
 * Discard only uncommitted changes from one validated receiving clone. This is
 * deliberately local-only: Refresh all remains the visible remote-update step.
 */
async function restoreLocalSharedVault(
  workspace: string,
  sharedVault: SharedVaultConfig,
  gitBase: Omit<GitOptions, 'cwd' | 'errorCode' | 'errorMessage'>,
): Promise<{ commit: string }> {
  const destination = destinationFor(workspace, sharedVault.localPath);
  await ensureNormalPath(workspace, destination);
  const git = { ...gitBase, cwd: destination } as GitOptions;
  const clone = await requireExpectedClone(destination, sharedVault, git);
  if (clone.status === '') {
    throw new DeliveryError('operation-failed', 'This shared vault has no local edits to restore. Use Refresh all to check for approved updates.');
  }

  // Do not erase local commits or rewritten history. Only an unchanged clone
  // with uncommitted working-tree material is eligible for this recovery.
  const trackedRemote = `refs/remotes/origin/${sharedVault.approvedBranch}`;
  await runGit(['rev-parse', '--verify', trackedRemote], {
    ...git,
    errorCode: 'divergent-history',
    errorMessage: 'Shared vault history could not be verified for safe restore.',
  });
  await runGit(['merge-base', '--is-ancestor', clone.head, trackedRemote], {
    ...git,
    errorCode: 'divergent-history',
    errorMessage: 'Shared vault has local commits or divergent history; restore was not applied.',
  });
  await runGit(['reset', '--hard', 'HEAD'], {
    ...git,
    errorCode: 'operation-failed',
    errorMessage: 'Shared vault could not be restored safely.',
  });
  await runGit(['clean', '-fd'], {
    ...git,
    errorCode: 'operation-failed',
    errorMessage: 'Shared vault could not remove local untracked files safely.',
  });
  const restored = await requireCleanClone(destination, sharedVault, git);
  if (restored !== clone.head) {
    throw new DeliveryError('operation-failed', 'Shared vault revision changed unexpectedly during restore.');
  }
  return { commit: restored };
}

async function baseGitOptions(shared: string, options: DeliveryOptions): Promise<{
  gitExecutable: string;
  hooksDirectory: string;
  attributesFile: string;
  allowLocalTestUrls: boolean;
  credentialInteractive: boolean;
}> {
  const { hooks, attributes } = await createRuntime(shared);
  const gitExecutable = await systemGitExecutable(options);
  if (!gitExecutable) {
    throw new DeliveryError(
      'git-unavailable',
      'A standard Git for Windows installation is unavailable. Ask the implementer or IT for help.',
    );
  }
  const base = {
    gitExecutable,
    hooksDirectory: hooks,
    attributesFile: attributes,
    allowLocalTestUrls: options.allowLocalTestUrls === true,
    credentialInteractive: options.credentialInteractive === true,
    ...(options.signal ? { signal: options.signal } : {}),
  };
  await runGit(['--version'], {
    ...base,
    errorCode: 'git-unavailable',
    errorMessage: 'System Git is unavailable. Ask the implementer or IT for help.',
  });
  return base;
}

async function configuredCredentialHelpers(
  git: Omit<GitOptions, 'cwd' | 'errorCode' | 'errorMessage'>,
): Promise<string[]> {
  const values: string[] = [];
  for (const key of ['credential.https://github.com.helper', 'credential.helper']) {
    try {
      const output = await runGit(['config', '--get-all', key], {
        ...git,
        errorCode: 'credential-manager-unavailable',
        errorMessage: 'Secure GitHub sign-in is not configured. Ask your implementation specialist or IT team for help.',
      });
      values.push(...output.split('\n').map((value) => value.trim()).filter(Boolean));
    } catch (error) {
      if (!(error instanceof DeliveryError) || error.code !== 'credential-manager-unavailable') throw error;
    }
  }
  return values;
}

async function requireSecureCredentialManager(
  git: Omit<GitOptions, 'cwd' | 'errorCode' | 'errorMessage'>,
  options: DeliveryOptions,
): Promise<void> {
  // Local synthetic fixtures deliberately use file:// remotes and do not need credentials.
  if (options.allowLocalTestUrls === true) return;
  const helpers = await configuredCredentialHelpers(git);
  if (!helpers.some(isSupportedCredentialHelper)) {
    throw new DeliveryError(
      'credential-manager-unavailable',
      'Secure GitHub sign-in is not configured. Ask your implementation specialist or IT team for help.',
    );
  }
  const store = await runGit(['config', '--get', '--default', 'platform-default', 'credential.credentialStore'], {
    ...git,
    errorCode: 'credential-manager-unavailable',
    errorMessage: 'Secure GitHub sign-in could not be checked. Ask your implementation specialist or IT team for help.',
  });
  if (isUnsafeCredentialStore(store)) {
    throw new DeliveryError(
      'credential-manager-unavailable',
      'GitHub sign-in is configured with an unsupported credential store. Ask your implementation specialist or IT team for help.',
    );
  }
}

function failedResult(sharedVault: SharedVaultConfig, checkedAt: string, error: unknown): SharedVaultResult {
  const deliveryError = error instanceof DeliveryError
    ? error
    : new DeliveryError('operation-failed', 'Shared vault operation failed without changing its reported status.');
  return {
    role: sharedVault.role,
    name: sharedVault.name,
    localPath: sharedVault.localPath,
    action: 'failed',
    checkedAt,
    errorCode: deliveryError.code,
    message: deliveryError.message,
  };
}

export async function connectSharedVaults(workspaceInput: string, options: DeliveryOptions = {}): Promise<DeliveryReport> {
  const { workspace, shared, sharedVaults } = await loadSharedVaults(workspaceInput, options);
  const git = await baseGitOptions(shared, { ...options, credentialInteractive: true });
  await requireSecureCredentialManager(git, options);
  const checkedAt = (options.now?.() ?? new Date()).toISOString();
  const results: SharedVaultResult[] = [];
  for (const sharedVault of sharedVaults) {
    try {
      await validateBranch(sharedVault.approvedBranch, { ...git, errorCode: 'invalid-config', errorMessage: 'Approved branch is invalid.' });
      const destination = destinationFor(workspace, sharedVault.localPath);
      const existing = await lstatIfPresent(destination);
      let commit: string;
      if (existing && existing.isDirectory() && await lstatIfPresent(join(destination, '.git'))) {
        commit = await requireCleanClone(destination, sharedVault, { ...git, cwd: destination } as GitOptions);
        await verifyRemoteConnection(destination, sharedVault, git);
      } else {
        commit = await cloneSharedVault(workspace, shared, sharedVault, git);
      }
      results.push({
        role: sharedVault.role,
        name: sharedVault.name,
        localPath: sharedVault.localPath,
        action: 'connected',
        checkedAt,
        commit,
        message: 'Shared vault is connected at its prepared workspace location.',
      });
    } catch (error) {
      results.push(failedResult(sharedVault, checkedAt, error));
    }
  }
  return { checkedAt, operation: 'connect', sharedVaults: results };
}

export async function refreshSharedVaults(workspaceInput: string, options: DeliveryOptions = {}): Promise<DeliveryReport> {
  const { workspace, shared, sharedVaults } = await loadSharedVaults(workspaceInput, options);
  const git = await baseGitOptions(shared, options);
  const checkedAt = (options.now?.() ?? new Date()).toISOString();
  const results: SharedVaultResult[] = [];
  for (const sharedVault of sharedVaults) {
    try {
      await validateBranch(sharedVault.approvedBranch, { ...git, errorCode: 'invalid-config', errorMessage: 'Approved branch is invalid.' });
      const refreshed = await refreshSharedVault(workspace, sharedVault, git);
      results.push({
        role: sharedVault.role,
        name: sharedVault.name,
        localPath: sharedVault.localPath,
        action: refreshed.action,
        checkedAt,
        commit: refreshed.commit,
        message: refreshed.action === 'updated' ? 'Approved shared files were updated.' : 'No new approved revision was found.',
      });
    } catch (error) {
      results.push(failedResult(sharedVault, checkedAt, error));
    }
  }
  return { checkedAt, operation: 'refresh', sharedVaults: results };
}

export async function restoreSharedVault(
  workspaceInput: string,
  localPath: string,
  options: DeliveryOptions = {},
): Promise<DeliveryReport> {
  const { workspace, shared, sharedVaults } = await loadSharedVaults(workspaceInput, options);
  const sharedVault = sharedVaults.find((item) => item.localPath === localPath);
  if (!sharedVault) {
    throw new DeliveryError('invalid-config', 'This shared vault is not configured for the workspace.');
  }
  const git = await baseGitOptions(shared, options);
  const checkedAt = (options.now?.() ?? new Date()).toISOString();
  try {
    await validateBranch(sharedVault.approvedBranch, {
      ...git,
      errorCode: 'invalid-config',
      errorMessage: 'Approved branch is invalid.',
    });
    const restored = await restoreLocalSharedVault(workspace, sharedVault, git);
    return {
      checkedAt,
      operation: 'restore',
      sharedVaults: [{
        role: sharedVault.role,
        name: sharedVault.name,
        localPath: sharedVault.localPath,
        action: 'restored',
        checkedAt,
        commit: restored.commit,
        message: 'Local shared edits were removed. Select Refresh all to check for newer approved files.',
      }],
    };
  } catch (error) {
    return { checkedAt, operation: 'restore', sharedVaults: [failedResult(sharedVault, checkedAt, error)] };
  }
}

export async function inspectSharedVaults(workspaceInput: string, options: DeliveryOptions = {}): Promise<LocalSharedVaultStatus[]> {
  const { workspace, shared, sharedVaults } = await loadSharedVaults(workspaceInput, options);
  const git = await baseGitOptions(shared, options);
  const statuses: LocalSharedVaultStatus[] = [];
  for (const sharedVault of sharedVaults) {
    try {
      await validateBranch(sharedVault.approvedBranch, { ...git, errorCode: 'invalid-config', errorMessage: 'Approved branch is invalid.' });
      const destination = destinationFor(workspace, sharedVault.localPath);
      const info = await lstatIfPresent(destination);
      if (!info) {
        statuses.push({ role: sharedVault.role, name: sharedVault.name, localPath: sharedVault.localPath, state: 'not-connected', message: 'Not connected on this computer.' });
        continue;
      }
      const commit = await requireCleanClone(destination, sharedVault, { ...git, cwd: destination } as GitOptions);
      statuses.push({ role: sharedVault.role, name: sharedVault.name, localPath: sharedVault.localPath, state: 'connected', commit, message: 'Connected locally. Remote updates have not been checked in this view.' });
    } catch (error) {
      const deliveryError = error instanceof DeliveryError
        ? error
        : new DeliveryError('operation-failed', 'Local shared vault could not be verified.');
      statuses.push({ role: sharedVault.role, name: sharedVault.name, localPath: sharedVault.localPath, state: 'needs-attention', errorCode: deliveryError.code, message: deliveryError.message });
    }
  }
  return statuses;
}
