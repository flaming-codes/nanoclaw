import fs from 'fs';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./config.js', () => ({
  DATA_DIR: '/tmp/nanoclaw-instance-lock-test',
}));

import {
  _getLockFilePath,
  acquireInstanceLock,
  releaseInstanceLock,
} from './instance-lock.js';

describe('instance-lock', () => {
  const LOCK_FILE = _getLockFilePath();
  let readFileSyncSpy: ReturnType<typeof vi.spyOn>;
  let writeFileSyncSpy: ReturnType<typeof vi.spyOn>;
  let unlinkSyncSpy: ReturnType<typeof vi.spyOn>;
  let mkdirSyncSpy: ReturnType<typeof vi.spyOn>;
  let onSpy: ReturnType<typeof vi.spyOn>;
  let killSpy: ReturnType<typeof vi.spyOn>;
  let lockContents: string | undefined;

  beforeEach(() => {
    lockContents = undefined;

    mkdirSyncSpy = vi
      .spyOn(fs, 'mkdirSync')
      .mockImplementation(() => undefined as any);
    readFileSyncSpy = vi
      .spyOn(fs, 'readFileSync')
      .mockImplementation((path) => {
        if (path === LOCK_FILE && lockContents !== undefined)
          return lockContents as any;
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      });
    writeFileSyncSpy = vi.spyOn(fs, 'writeFileSync').mockImplementation(((
      filePath: fs.PathOrFileDescriptor,
      data: string | NodeJS.ArrayBufferView,
      options?: fs.WriteFileOptions,
    ) => {
      if (filePath !== LOCK_FILE) return;
      if (
        (options as { flag?: string } | undefined)?.flag === 'wx' &&
        lockContents !== undefined
      ) {
        throw Object.assign(new Error('EEXIST'), { code: 'EEXIST' });
      }
      lockContents = String(data);
    }) as any);
    unlinkSyncSpy = vi.spyOn(fs, 'unlinkSync').mockImplementation((path) => {
      if (path === LOCK_FILE) {
        lockContents = undefined;
        return;
      }
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });
    onSpy = vi.spyOn(process, 'on');
    killSpy = vi.spyOn(process, 'kill').mockImplementation(((pid: number) => {
      if (pid === 99999) return true;
      throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' });
    }) as any);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('acquires a new lock when no instance is running', () => {
    acquireInstanceLock();

    expect(mkdirSyncSpy).toHaveBeenCalled();
    expect(writeFileSyncSpy).toHaveBeenCalledWith(
      LOCK_FILE,
      expect.stringContaining(`"pid":${process.pid}`),
      { flag: 'wx' },
    );
    expect(onSpy).toHaveBeenCalledWith('exit', expect.any(Function));
  });

  it('throws when another live instance owns the lock', () => {
    lockContents = JSON.stringify({
      pid: 99999,
      startedAt: '2026-03-30T00:00:00.000Z',
      command: 'node dist/index.js',
    });

    expect(() => acquireInstanceLock()).toThrow(
      'NanoClaw is already running (pid 99999: node dist/index.js)',
    );
    expect(killSpy).toHaveBeenCalledWith(99999, 0);
  });

  it('replaces a stale lock and acquires it', () => {
    lockContents = JSON.stringify({
      pid: 11111,
      startedAt: '2026-03-30T00:00:00.000Z',
      command: 'node dist/index.js',
    });

    acquireInstanceLock();

    expect(unlinkSyncSpy).toHaveBeenCalledWith(LOCK_FILE);
    expect(writeFileSyncSpy).toHaveBeenCalledTimes(2);
    expect(lockContents).toContain(`"pid":${process.pid}`);
  });

  it('releases the lock only when owned by this process', () => {
    lockContents = JSON.stringify({
      pid: process.pid,
      startedAt: '2026-03-30T00:00:00.000Z',
      command: 'node dist/index.js',
    });

    releaseInstanceLock();

    expect(unlinkSyncSpy).toHaveBeenCalledWith(LOCK_FILE);
    expect(lockContents).toBeUndefined();
  });

  it('does not remove a lock owned by another process', () => {
    lockContents = JSON.stringify({
      pid: 99999,
      startedAt: '2026-03-30T00:00:00.000Z',
      command: 'node dist/index.js',
    });

    releaseInstanceLock();

    expect(unlinkSyncSpy).not.toHaveBeenCalled();
    expect(lockContents).toContain('99999');
  });
});
