# Contributing to electron-cast

How to set up the repository, what each check does, the rules the code follows, and how a release is made.

## Setup

You need Node 20 or later (CI uses 24). Running the TypeScript examples directly needs a Node that strips types (22.18 or 24).

```sh
git clone https://github.com/adammpkins/electron-cast.git
cd electron-cast
npm ci
```

There are no runtime dependencies and none are to be added: `dependencies` stays empty. Electron is an optional peer dependency
and is not installed by `npm ci`.

## The checks

| Command | What it does | Needs |
|---|---|---|
| `npm run check` | Typecheck, lint (oxlint), the unit tests, and the documentation checks. This is what CI and the publish workflow run | Nothing but `npm ci`; no network |
| `npm run build` | Compiles the ES module build to `dist/` and the CommonJS build to `dist/cjs/`, marks the CommonJS folder, and stamps the build time (the start of the fallback CRL's 20-week window) | |
| `npm test` | The unit tests alone (`node --test` on `test/**/*.test.ts`), on Node's own test runner | |
| `npm run smoke` | Builds, then runs the built package in a real Electron under a fake network | An Electron in `smoke/.out/electron` (below) |
| `npm run canary` | Downloads Google's Cast sender SDK for Chrome stable, beta and dev, and the Chromium in Electron, and checks as text that it still speaks the envelope electron-cast translates | Network |
| `npm run docs:check` | The documentation checks alone (part of `npm run check`) | Nothing |
| `npm run docs:check:chromium` | Fetches each Chromium file linked from the docs and looks for each symbol | Network; run when you touch a citation |

### The unit tests

They are plain `node:test` files under `test/`, with fakes for everything outside the process: a fake receiver (a TLS server on
127.0.0.1 with a test-only certificate, `test/client/fake-receiver.ts`), a fake discovery socket, fake clients and a fake
`ipcMain`. No test opens a real network connection to a device. A change needs a test that fails without it.

### The smoke test

It loads the **built** package by name inside a real Electron with a sandboxed preload, and drives it from a page. It is the
only check that proves the preload bundles and the `exports` map is right. Electron is installed into its own folder because
it is an optional peer dependency:

```sh
npm i --prefix smoke/.out/electron --no-package-lock electron@45
npm run smoke
```

CI runs it on Electron 35, 40 and the latest, on Linux, Windows and macOS. On Linux it needs a display (`xvfb-run`) and
Electron's sandbox helper allowed; see `.github/workflows/ci.yml` for the steps CI takes.

### The SDK canary

Google can change its Cast sender SDK per Chrome major without an electron-cast release, and the stand-in depends on what it
sends. `tools/sdk-canary.mjs` fetches the SDK for the current Chrome channels and for the Chromium inside Electron 45 and
compares it with `tools/sdk-canary-baseline.json`. The downloaded JavaScript is only ever searched as text and never run. A
weekly workflow (`.github/workflows/sdk-canary.yml`) opens an issue when it fails and closes it when it passes again. Exit
codes: 0 compatible, 1 incompatible, 2 could not run. Update the baseline deliberately, with `--update-baseline`, after reading
what changed.

### The documentation checks

`npm run docs:check` (network-free) fails when:

- a public export is not mentioned in the API reference (`docs/API.md`, `docs/MAIN-API.md`);
- a TypeScript block in the Markdown does not typecheck against the sources. Blocks that are fragments or signatures are marked
  with `no-check` after the language (` ```ts no-check `) or by `<!-- no-check -->` on the line before the block;
- a relative link or `#anchor` in the Markdown does not resolve.

Every file in `docs/` starts with a single `# Title` and a one-sentence summary paragraph, and docs pages link to each other with
relative links.

## The rules the code follows

### Behave as Chrome, and cite Chromium

electron-cast is Chrome's Cast support for Electron. When the library has a choice to make (what to check, which error to
return, what to do after a navigation), the answer is what Chrome does, and the code says where Chrome does it, by file and
symbol, in the comment next to the code.

- Read the Chromium source on `main` before writing the citation. Do not cite from memory or from a search snippet.
- Cite the file and the function or constant, not a line number.
- Add a row to [the Chromium map](docs/CHROMIUM-MAP.md), run `npm run docs:check:chromium`, and note any difference in its
  "Differs" column.
- When the library deliberately differs from Chrome, say so and say why in the code, in [DESIGN.md](docs/DESIGN.md) and in
  the changelog. A silent difference is a bug.

### Nothing app-specific in `src/`

The library does not know which app uses it. A fix that only one app needs goes in that app, and the docs do not name the
apps that use the library. Docs may name a web page as an example (YouTube Music, say); `src/` may not.

### `mode: "chromecast"` is frozen

The legacy `chrome.cast` polyfill (`src/polyfill/install.ts`) gets bug fixes for crashes and security problems and nothing else:
no new features, no behaviour changes. New work goes on the presentation path.

### Security-sensitive code

The page is untrusted and the main process is trusted. Everything arriving over IPC is validated in the main process; the origin
and frame come from `event.senderFrame`, never from the message; a page can never name a host or port. Read
[SECURITY.md](SECURITY.md) before changing `src/electron/` or the client's authentication, and do not weaken a check to make
a test pass.

### Comments

Comments explain why, and cite Chromium where the behaviour is Chrome's. They do not narrate the change that introduced them.

## Probing real devices

Tests do not need a device. When you need to learn how a real one behaves, **read-only is the rule**: discover, connect,
authenticate, and read the receiver status. Do not launch an app, change the volume, stop playback or send media to a device that
is not yours to disturb, and never to someone else's. Discovery only asks: it never advertises or answers. Do not put a device's
address, serial number or certificate in a commit, an issue or a test fixture.

DIAL TVs are probed with `electron-cast dial-test` (`src/dial-test/`, built to `dist/cli.js`; [how a volunteer runs
it](README.md#test-a-dial-tv)). It uses the library's own SSDP discovery, description fetch, app info, launch and stop, so what
it reports is what the library does. Everything it does is read-only except opening and closing YouTube, which it does only
after asking. It scrubs its report once, at the end, in `src/dial-test/scrub.ts`; anything new that goes into the report is
scrubbed there, and the tests in `test/dial-test/` fail if a name, serial number, UDN, MAC, address or app-info value from
the fake device appears in it. Do not run it against devices that are not yours.

What the project has tested on real devices, and what it has not, is stated in the
[README](README.md#platforms-and-what-was-tested). New claims of support need a run on the platform or device, and the docs
say what the run covered and what it did not.

## Pull requests

- One change, one commit message that says what and why in plain words.
- Update [CHANGELOG.md](CHANGELOG.md) under `## Unreleased` for anything a user can see.
- Update the docs the change touches: the [API reference](docs/API.md) or [main-process API](docs/MAIN-API.md) for a public
  change, [DESIGN.md](docs/DESIGN.md) for behaviour, and the parity table in the README when Chrome parity changes.
- `npm run check` and `npm run build` pass.

## Release checklist

Releases are published by `.github/workflows/publish.yml` from a tag, with npm trusted publishing (no token is stored) and a
provenance attestation.

1. On `main`, with a clean tree: `npm ci`, `npm run check`, `npm run build`, and `npm run smoke` against the Electron you
   support. Run `npm run canary` and read the result.
2. Move the `## Unreleased` entries of the changelog under a new `## <version>` heading.
3. Set `version` in `package.json` (and the lockfile, with `npm install --package-lock-only`).
4. Commit.
5. Tag and push: `git tag v<version> && git push origin main v<version>`. The workflow refuses a tag that does not match
   `package.json`, skips a version already on npm, runs `npm run check`, and publishes.
6. Confirm the version on npm and that a fresh `npm i electron-cast` imports from `electron-cast`, `electron-cast/main` and
   `electron-cast/preload`.

The package's `files` list (`dist`, `src`, the docs and changelog) is what ships; check `npm pack --dry-run` shows the docs the
README links to.
