# ObrikaNative

Repository for the **Obrika** native desktop client.

## Obrika Desktop

The Electron desktop application lives in [`electron/`](electron/). It loads the production web app at https://obrika.dereksolutions.com without modifying the web codebase.

```bash
cd electron
npm install
npm start
```

See [electron/README.md](electron/README.md) for full documentation on packaging, code signing, auto-update, and CI.
