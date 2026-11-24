# electron-cast

Chromecast for Electron. Web pages that use the Google Cast sender API (`chrome.cast`) get a working
implementation, and your main process handles device discovery and the Cast v2 protocol. No native modules, and it
works with `sandbox: true` and `contextIsolation: true`.

Electron has no Presentation API or Media Router, and electron/electron#869 was closed in 2025 with no plans to add
one. This library fills that gap.

**Status: early development, not yet usable.** See [docs/DESIGN.md](docs/DESIGN.md).

## License

MIT
