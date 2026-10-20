import { BrowserWindow, clipboard, Menu, MenuItem, WebContents } from 'electron';
import { isDevelopment } from './logger';

export function setupContextMenu(webContents: WebContents): void {
  webContents.on('context-menu', (_event, params) => {
    const menu = new Menu();

    if (params.isEditable) {
      menu.append(new MenuItem({
        label: 'Cut',
        role: 'cut',
        enabled: params.editFlags.canCut,
      }));
      menu.append(new MenuItem({
        label: 'Copy',
        role: 'copy',
        enabled: params.editFlags.canCopy,
      }));
      menu.append(new MenuItem({
        label: 'Paste',
        role: 'paste',
        enabled: params.editFlags.canPaste,
      }));
      menu.append(new MenuItem({ type: 'separator' }));
      menu.append(new MenuItem({
        label: 'Select All',
        role: 'selectAll',
        enabled: params.editFlags.canSelectAll,
      }));
    } else if (params.selectionText) {
      menu.append(new MenuItem({
        label: 'Copy',
        click: () => clipboard.writeText(params.selectionText),
      }));
    }

    if (params.linkURL) {
      menu.append(new MenuItem({ type: 'separator' }));
      menu.append(new MenuItem({
        label: 'Copy Link',
        click: () => clipboard.writeText(params.linkURL),
      }));
    }

    if (params.mediaType === 'image') {
      menu.append(new MenuItem({ type: 'separator' }));
      menu.append(new MenuItem({
        label: 'Copy Image',
        click: () => webContents.copyImageAt(params.x, params.y),
      }));
      menu.append(new MenuItem({
        label: 'Save Image As…',
        click: () => {
          webContents.downloadURL(params.srcURL);
        },
      }));
    }

    if (isDevelopment()) {
      menu.append(new MenuItem({ type: 'separator' }));
      menu.append(new MenuItem({
        label: 'Inspect Element',
        click: () => {
          webContents.inspectElement(params.x, params.y);
          if (!webContents.isDevToolsOpened()) {
            webContents.openDevTools({ mode: 'detach' });
          }
        },
      }));
    }

    if (menu.items.length > 0) {
      const win = BrowserWindow.fromWebContents(webContents);
      menu.popup({ window: win ?? undefined });
    }
  });
}
