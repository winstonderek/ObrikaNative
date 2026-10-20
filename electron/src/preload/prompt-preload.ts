import { contextBridge, ipcRenderer } from 'electron';

const CHANNEL_JS_PROMPT_RESULT = 'obrika:js-prompt-result';
const ARG_PROMPT_ID = '--obrika-prompt-id=';

function readArg(prefix: string): string | null {
  const match = process.argv.find((arg) => arg.startsWith(prefix));
  return match ? match.slice(prefix.length) : null;
}

const promptId = readArg(ARG_PROMPT_ID) ?? '';

contextBridge.exposeInMainWorld('obrikaPrompt', {
  id: promptId,
  submit: (value: string) => ipcRenderer.send(CHANNEL_JS_PROMPT_RESULT, promptId, value),
  cancel: () => ipcRenderer.send(CHANNEL_JS_PROMPT_RESULT, promptId, null),
});

export {};
