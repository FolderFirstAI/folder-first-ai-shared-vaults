import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { terminateProcessTree } from '../src/process-tree.ts';

const delay = async (milliseconds: number): Promise<void> => {
  await new Promise<void>((resolvePromise) => { setTimeout(resolvePromise, milliseconds); });
};

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await delay(25);
  }
  throw new Error(`Timed out waiting for ${label}.`);
}

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForClose(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await Promise.race([
    new Promise<void>((resolvePromise) => { child.once('close', () => { resolvePromise(); }); }),
    delay(10_000).then(() => { throw new Error('Timed out waiting for the process tree to stop.'); }),
  ]);
}

test('termination stops a spawned process and its descendant', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'practical-ai-os-process-tree-'));
  const childPidFile = join(root, 'descendant.pid');
  const parentScript = join(root, 'parent.cjs');
  writeFileSync(parentScript, [
    "const { spawn } = require('node:child_process');",
    "const { writeFileSync } = require('node:fs');",
    `const descendant = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });`,
    `writeFileSync(${JSON.stringify(childPidFile)}, String(descendant.pid));`,
    'setInterval(() => {}, 1000);',
  ].join('\n'), 'utf8');

  const parent = spawn(process.execPath, [parentScript], {
    detached: process.platform !== 'win32',
    shell: false,
    stdio: 'ignore',
    windowsHide: true,
  });
  let descendantPid = 0;
  t.after(() => {
    terminateProcessTree(parent);
    if (descendantPid > 0 && isRunning(descendantPid)) {
      try { process.kill(descendantPid); } catch { /* already stopped */ }
    }
    rmSync(root, { recursive: true, force: true });
  });

  await waitFor(() => existsSync(childPidFile), 'descendant PID');
  descendantPid = Number.parseInt(readFileSync(childPidFile, 'utf8'), 10);
  assert.ok(parent.pid && isRunning(parent.pid));
  assert.ok(Number.isSafeInteger(descendantPid) && descendantPid > 0 && isRunning(descendantPid));

  terminateProcessTree(parent);
  await waitForClose(parent);
  await waitFor(() => !isRunning(descendantPid), 'descendant termination');
  assert.equal(isRunning(descendantPid), false);
});
