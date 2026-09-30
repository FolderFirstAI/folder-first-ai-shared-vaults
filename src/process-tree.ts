import { spawn, type ChildProcess } from 'node:child_process';

/**
 * Stop the Git process and the helper processes it created.
 *
 * Unix children are launched as a process-group leader, so a negative PID
 * targets the whole group. Windows has no equivalent Node API; taskkill is a
 * standard operating-system command and receives only the numeric PID that
 * this plugin just spawned.
 */
export function terminateProcessTree(child: ChildProcess): void {
  const pid = child.pid;
  if (!pid) return;

  if (process.platform === 'win32') {
    const killer = spawn('taskkill.exe', ['/PID', String(pid), '/T', '/F'], {
      shell: false,
      windowsHide: true,
      stdio: 'ignore',
    });
    killer.once('error', () => { child.kill(); });
    return;
  }

  try {
    process.kill(-pid, 'SIGTERM');
  } catch {
    child.kill();
  }
}
