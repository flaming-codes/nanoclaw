import fs from 'fs';
import path from 'path';

import { DATA_DIR } from './config.js';

interface LockState {
  pid: number;
  startedAt: string;
  command: string;
}

const LOCK_FILE = path.join(DATA_DIR, 'nanoclaw.pid');

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readLockState(): LockState | null {
  try {
    return JSON.parse(fs.readFileSync(LOCK_FILE, 'utf-8')) as LockState;
  } catch {
    return null;
  }
}

function removeLockIfOwned(): void {
  const lockState = readLockState();
  if (!lockState || lockState.pid !== process.pid) return;

  try {
    fs.unlinkSync(LOCK_FILE);
  } catch {
    // ignore cleanup failures during shutdown
  }
}

function writeLockFile(): void {
  fs.mkdirSync(path.dirname(LOCK_FILE), { recursive: true });
  const lockState: LockState = {
    pid: process.pid,
    startedAt: new Date().toISOString(),
    command: process.argv.join(' '),
  };
  fs.writeFileSync(LOCK_FILE, JSON.stringify(lockState), { flag: 'wx' });
}

export function acquireInstanceLock(): void {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      writeLockFile();
      process.on('exit', removeLockIfOwned);
      return;
    } catch (err) {
      const error = err as NodeJS.ErrnoException;
      if (error.code !== 'EEXIST') throw err;

      const existing = readLockState();
      if (
        existing &&
        existing.pid !== process.pid &&
        isProcessAlive(existing.pid)
      ) {
        throw new Error(
          `NanoClaw is already running (pid ${existing.pid}: ${existing.command})`,
        );
      }

      try {
        fs.unlinkSync(LOCK_FILE);
      } catch {
        // Another process may have already cleaned up the stale lock.
      }
    }
  }

  throw new Error('Failed to acquire NanoClaw instance lock');
}

export function releaseInstanceLock(): void {
  removeLockIfOwned();
}

export function _getLockFilePath(): string {
  return LOCK_FILE;
}
