import { app, dialog, DownloadItem, BrowserWindow, WebContents } from 'electron';
import path from 'node:path';
import { logger } from './logger';

/**
 * Windows opened only to receive a file (Drive "download" uses window.open).
 * The navigation is aborted once the download starts, so the window stays blank
 * unless we close it when the save finishes.
 */
const downloadShells = new WeakSet<WebContents>();

function isBlankDocumentUrl(url: string): boolean {
  return !url || url === 'about:blank' || url.startsWith('about:');
}

/** A popup that should appear only if it actually loads a page. */
export function markDownloadShell(window: BrowserWindow): void {
  const webContents = window.webContents;
  if (webContents.isDestroyed()) return;
  downloadShells.add(webContents);

  const revealIfDocument = (): void => {
    if (webContents.isDestroyed() || window.isDestroyed()) return;
    if (isBlankDocumentUrl(webContents.getURL())) return;
    downloadShells.delete(webContents);
    if (!window.isVisible()) window.show();
  };

  webContents.on('did-finish-load', revealIfDocument);
  webContents.on('did-fail-load', (_event, errorCode, _description, _url, isMainFrame) => {
    // -3 is ERR_ABORTED, which is what a download does to the popup navigation.
    if (!isMainFrame || errorCode === -3) return;
    downloadShells.delete(webContents);
    if (!window.isDestroyed() && !window.isVisible()) window.show();
  });
}

function closeDownloadShell(webContents: WebContents): void {
  if (webContents.isDestroyed() || !downloadShells.has(webContents)) return;
  const host = BrowserWindow.fromWebContents(webContents);
  downloadShells.delete(webContents);
  if (!host || host.isDestroyed()) return;
  logger.info('Closing blank window left open by a file download');
  host.close();
}

export function setupDownloads(webContents: WebContents): void {
  webContents.session.on('will-download', (_event, item: DownloadItem, wc) => {
    const filename = item.getFilename();
    logger.info(`Download started: ${filename}`);

    const defaultPath = path.join(app.getPath('downloads'), filename);

    item.setSaveDialogOptions({
      title: 'Save file',
      defaultPath,
      buttonLabel: 'Save',
    });

    item.once('done', (_doneEvent, state) => {
      if (state === 'completed') {
        logger.info(`Download completed: ${item.getSavePath()}`);
      } else if (state === 'cancelled') {
        logger.info(`Download cancelled: ${filename}`);
      } else if (state === 'interrupted') {
        logger.error(`Download interrupted: ${filename}`);
        const hostWindow = BrowserWindow.fromWebContents(wc);
        const dialogParent =
          hostWindow && !hostWindow.isDestroyed() && !downloadShells.has(wc) ? hostWindow : undefined;
        const options = {
          type: 'error' as const,
          title: 'Download failed',
          message: `Could not download "${filename}".`,
          detail: 'The download was interrupted. Please try again.',
        };
        const shown = dialogParent
          ? dialog.showMessageBox(dialogParent, options)
          : dialog.showMessageBox(options);
        shown.catch(() => undefined);
      }
      closeDownloadShell(wc);
    });
  });
}

export function setupSessionDownloads(): void {
  app.on('session-created', (session) => {
    session.on('will-download', (_event, item) => {
      logger.debug(`Session download: ${item.getFilename()}`);
    });
  });
}
