import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { app } from 'electron';
import { logger } from './logger';

function getUpdateExePath(): string {
  return path.resolve(path.dirname(process.execPath), '..', 'Update.exe');
}

export function isSquirrelInstall(): boolean {
  return process.platform === 'win32' && fs.existsSync(getUpdateExePath());
}

function runUpdateExe(args: string[]): void {
  const updateExe = getUpdateExePath();
  if (!fs.existsSync(updateExe)) {
    logger.warn(`Squirrel Update.exe not found at ${updateExe}`);
    return;
  }

  // Must wait — a detached 1s timeout often quits before shortcuts (and their
  // icons) are rewritten, which blanks the taskbar pin after an update.
  const result = spawnSync(updateExe, args, {
    windowsHide: true,
    timeout: 15_000,
  });
  if (result.error) {
    logger.warn(`Squirrel Update.exe ${args.join(' ')} failed`, result.error);
  } else if (result.status !== 0) {
    logger.warn(`Squirrel Update.exe ${args.join(' ')} exited ${result.status}`);
  }
}

/**
 * Squirrel.Windows relaunches the app on install/update/uninstall with a
 * `--squirrel-*` flag. Those runs must create or remove Start Menu shortcuts
 * (required for Windows toast notifications) and then quit.
 *
 * @returns true when this process should stop starting the UI.
 */
export function handleSquirrelWindowsEvents(): boolean {
  if (process.platform !== 'win32') return false;

  const squirrelEvent = process.argv[1];
  if (!squirrelEvent?.startsWith('--squirrel')) return false;

  const exeName = path.basename(process.execPath);

  switch (squirrelEvent) {
    case '--squirrel-install':
    case '--squirrel-updated':
      runUpdateExe([`--createShortcut=${exeName}`]);
      app.quit();
      return true;
    case '--squirrel-uninstall':
      runUpdateExe([`--removeShortcut=${exeName}`]);
      app.quit();
      return true;
    case '--squirrel-obsolete':
      app.quit();
      return true;
    default:
      return false;
  }
}
