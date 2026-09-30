import { readFile, stat } from 'node:fs/promises';

const manifest = JSON.parse(await readFile('manifest.json', 'utf8'));
const packageJson = JSON.parse(await readFile('package.json', 'utf8'));
const versions = JSON.parse(await readFile('versions.json', 'utf8'));

if (manifest.version !== packageJson.version) {
  throw new Error('manifest.json and package.json versions differ');
}
if (versions[manifest.version] !== manifest.minAppVersion) {
  throw new Error('versions.json does not map the current plugin version to minAppVersion');
}
if (!/^\d+\.\d+\.\d+$/u.test(manifest.version)) {
  throw new Error('Plugin version must use x.y.z semantic versioning');
}
if (!manifest.isDesktopOnly) throw new Error('Shared Vaults must remain desktop-only');
if (manifest.id.includes('obsidian')) throw new Error('Plugin id may not contain obsidian');
if (!manifest.description.endsWith('.') || manifest.description.length > 250) {
  throw new Error('Manifest description must end with a period and contain at most 250 characters');
}

for (const file of ['README.md', 'LICENSE', 'SECURITY.md', 'CHANGELOG.md', 'CONTRIBUTING.md', 'THIRD-PARTY-NOTICES.md', 'main.js', 'manifest.json', 'styles.css']) {
  if (!(await stat(file)).isFile()) throw new Error(`Missing release file: ${file}`);
}

if (packageJson.private !== true) throw new Error('The plugin package must not be published to npm');
if (packageJson.license !== 'MIT') throw new Error('package.json must declare the selected MIT license');
if (Object.keys(packageJson.dependencies ?? {}).join(',') !== 'yaml') {
  throw new Error('The runtime dependency allowlist changed; review and update this release check deliberately');
}
if ((await stat('main.js')).size > 1024 * 1024) throw new Error('main.js exceeds the reviewed 1 MiB bundle bound');

const sources = await Promise.all(['src/core.ts', 'src/main.ts', 'src/operation-gate.ts', 'src/recovery.ts']
  .map((file) => readFile(file, 'utf8')));
const source = sources.join('\n');
for (const prohibited of [/\bfetch\s*\(/u, /\bXMLHttpRequest\b/u, /\bWebSocket\b/u, /\beval\s*\(/u, /new\s+Function\b/u, /shell\s*:\s*true/u]) {
  if (prohibited.test(source)) throw new Error(`Source contains prohibited pattern: ${prohibited}`);
}

const readme = await readFile('README.md', 'utf8');
if (/\.\.\//u.test(readme)) throw new Error('Public README contains a parent-relative link');
for (const disclosure of ['system Git', 'Git Credential Manager', 'collects no telemetry', 'desktop-only']) {
  if (!readme.includes(disclosure)) throw new Error(`README is missing disclosure: ${disclosure}`);
}

console.log(`Release structure valid for ${manifest.id} ${manifest.version}`);
