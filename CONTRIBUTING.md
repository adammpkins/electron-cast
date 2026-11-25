# Contributing to electron-cast

Thanks for helping. electron-cast brings Chrome's Cast support to Electron, and the most useful things you can bring are
a bug fix, a doc fix, or a report from a device and a desktop we have not tried.

Start here:

- [Report a Cast device you tested](#test-on-real-devices): the most wanted contribution.
- [Fix a bug or a doc](#how-to-contribute): open a pull request directly.
- [Add a feature or change the API](#how-to-contribute): open an issue first.
- [Report a security problem](#security-issues): privately, never in an issue.

## How to contribute

| You want to | Do this |
|---|---|
| Fix a bug, or fix or improve the docs | Open a pull request. No issue needed. |
| Add a feature, or change the public API | Open an issue first. We agree on the Chromium behaviour it matches before you write code. |
| Report a bug | Open an issue with the bug form. |
| Say what works on your device or OS | Open an issue with the device report form. |
| Report a vulnerability | Use a [private advisory](#security-issues). |

There is no CLA and no sign-off line. By contributing you agree your work is licensed under the [MIT license](LICENSE), the
same as the project (inbound = outbound).

### AI-assisted contributions

Welcome. Use whatever tools help you. You do not need to say you used them.

You own what you submit. That means you understand every line, you ran it, and you can explain it in review. Check every
Chromium citation yourself, by opening the file: a tool can invent a source, a function name or a test result. Keep the pull
request small enough for a person to review.

## The rules

### Behave as Chrome, and cite Chromium

This is a hard rule. electron-cast does what Chrome does. When the library has a choice to make (what to check, which error
to return, what to do after a navigation), the answer is what Chrome does.

- **Every behaviour change cites the Chromium (or Open Screen) source it matches.** Give the file and the function, and link
  it on chromium.googlesource.com. Put the citation in the comment next to the code.
- Cite the file and the symbol, never a line number. Lines move.
- Read the source on `main` before you write the citation. Do not cite from memory or from a search snippet.
- Deviations are accepted only when Electron forces them. Each one is written down in [docs/DESIGN.md](docs/DESIGN.md) with
  the reason, and noted in the code and the changelog. A silent difference is a bug.
- App-specific features belong in the app, not in the library. `src/` never knows which app uses it.
- **`mode: "chromecast"` is frozen.** The legacy `chrome.cast` polyfill (`src/polyfill/install.ts`) gets fixes for crashes
  and security problems and nothing else. No new features. New work goes on the Presentation API path.
- **No runtime dependencies.** `dependencies` in `package.json` stays empty. Dev dependencies are fine when a tool needs
  one.

### Finding the Chromium source

Search and browse at [source.chromium.org](https://source.chromium.org/chromium/chromium/src), and link to
`https://chromium.googlesource.com/chromium/src/+/refs/heads/main/<path>`. Open Screen lives in
`https://chromium.googlesource.com/openscreen`. Where to look:

| Area | Path in Chromium |
|---|---|
| Media Router: sinks, routes, Cast sessions, Cast channels | `chrome/browser/media/router/` (the Cast provider is `providers/cast/`) |
| Media Router: shared parts, Presentation API plumbing | `components/media_router/` |
| Tab and desktop mirroring | `components/mirroring/` |
| The page-side Presentation API | `third_party/blink/renderer/modules/presentation/` |
| Cast protocol, discovery, authentication (Open Screen) | `cast/` in openscreen |

Add or update a row in [docs/CHROMIUM-MAP.md](docs/CHROMIUM-MAP.md): the electron-cast file, the Chromium file, the symbols,
what is mirrored, and how electron-cast differs. Then run the citation check, which needs the network:

```sh
npm run docs:check:chromium
```

It fetches each Chromium file linked from the map, looks for each cited symbol in it, and checks that every
Chromium-style path written in backticks in `docs/` exists. Chromium moves code around: a failure usually means the
citation needs updating, not that the library is wrong.

### Security-sensitive code

The page is untrusted and the main process is trusted. Everything that arrives over IPC is validated in the main process.
The origin and frame come from `event.senderFrame`, never from the message. A page never names a host or port. Read
[SECURITY.md](SECURITY.md) before you change `src/electron/` or the client's authentication, and do not weaken a check to
make a test pass.

### Comments

Comments explain why, and cite Chromium where the behaviour is Chrome's. They do not narrate the change that added them.

## Set up

You need Node 20 or later (the `engines` field in `package.json`). CI uses Node 24. Running TypeScript files directly, as
`node examples/discover.ts` does, needs a Node that strips types: 22.18 or later.

```sh
git clone https://github.com/adammpkins/electron-cast.git
cd electron-cast
npm ci
```

Electron is an optional peer dependency and `npm ci` does not install it. Only the smoke test and the live harnesses need
it, and they install it for you or tell you how.

| Command | What it does |
|---|---|
| `npm run check` | Typecheck, lint (oxlint), unit tests and the docs check. No network. This is the CI gate. |
| `npm run build` | Builds `dist/` (ES modules) and `dist/cjs/` (CommonJS). |
| `npm test` | The unit tests alone, on Node's own test runner. |
| `npm run typecheck`, `npm run lint` | Each step of `npm run check` on its own. |
| `npm run docs:check` | The docs checks alone. No network. |
| `npm run docs:check:chromium` | Checks the Chromium citations. Needs the network. |
| `npm run smoke` | Builds, then loads the built package in a real Electron with a fake network. |
| `npm run canary` | Checks Google's Cast sender SDK still speaks what we translate. Needs the network. |

Run one test file:

```sh
node --test --test-force-exit --test-timeout=20000 test/client/cast-client.test.ts
```

## Repository layout

| Path | What is there |
|---|---|
| `src/discovery/` | mDNS discovery of Cast devices, and the address policy |
| `src/dial/` | DIAL discovery and launch |
| `src/protocol/`, `src/client/` | The Cast v2 wire format, device authentication, and the channel client |
| `src/electron/` | The main-process manager, sessions, routes, media control, the network monitor, access code casting, and the preload |
| `src/mirroring/` | Tab and desktop mirroring: the Cast Streaming sender (`sender/`, `rtp/`, `rtcp/`, `transport/`), the session host, codec choice, statistics (`stats/`), and the Electron capture and utility process (`electron/`) |
| `src/polyfill/` | The page side: the stand-in Presentation API and the frozen `chrome.cast` polyfill |
| `src/cli.ts`, `src/dial-test/` | The `electron-cast` command (the package's `bin`, built to `dist/cli.js`) and its `dial-test` |
| `src/index.ts` | The package's main entry |
| `test/` | Unit tests, with fakes for everything outside the process |
| `smoke/` | The Electron smoke test, mirroring included |
| `tools/` | Docs checks, the SDK canary and the trace recorder |
| `examples/` | A small app (`electron-app/`), a discovery script (`discover.ts`), and the live mirroring harness that casts to a real device (`live-mirroring/`) |
| `docs/` | The documentation: API, design, the Chromium map, guides |
| `site/` | The documentation website (VitePress) |

## Test your change

CI runs two gates. Both must pass:

1. **`npm run check`** on Linux, Windows and macOS.
2. **The Electron smoke test** on Electron 35, 40 and the latest, on the same three systems.

New behaviour needs a test that fails without it. Use the fakes the tests already have: a fake receiver (a TLS server on
127.0.0.1, `test/client/fake-receiver.ts`), a fake discovery socket, fake clients and a fake `ipcMain`. **No test uses a
real device or the real network.**

### The smoke test

It loads the built package by name inside a real Electron with a sandboxed preload, and drives it from a page. Electron is
installed into its own folder:

```sh
npm i --prefix smoke/.out/electron --no-package-lock electron@45
npm run smoke
```

On Linux it needs a display (`xvfb-run`) and Electron's sandbox helper allowed. `.github/workflows/ci.yml` shows the steps.

### The SDK canary

Google can change its Cast sender SDK per Chrome major without an electron-cast release, and the stand-in depends on what the
SDK sends. `npm run canary` (`tools/sdk-canary.mjs`) fetches the SDK for Chrome stable, beta and dev, and for the Chromium in
Electron 45, and compares it with `tools/sdk-canary-baseline.json`. The downloaded JavaScript is only searched as text, never
run. A weekly workflow opens an issue when it fails. Exit codes: 0 compatible, 1 incompatible, 2 could not run. Update the
baseline deliberately, with `--update-baseline`, after reading what changed.

### The docs checks

`npm run docs:check` fails when a public export is missing from the API reference, a TypeScript block in the Markdown does
not typecheck, or a relative link or `#anchor` does not resolve. Mark a fragment or a signature with `no-check` after the
language (` ```ts no-check `) or put `<!-- no-check -->` on the line before the block.

## Test on real devices

The unit tests cannot tell us how real hardware behaves. We want reports, especially from:

- **macOS** (not tested yet).
- **Real Linux desktops**: GNOME and KDE, on X11 and on Wayland.
- **DIAL smart TVs.**
- **Two network adapters** (Wi-Fi and Ethernet, a VPN, a virtual switch).
- **Cast groups.**
- **Older Chromecasts.**

What has been tested, and what has not, is in the [README](README.md#platforms-and-what-was-tested). A report that fills a
gap is a real contribution, even if everything works.

### Send a device report

Open an issue with the **Device report** form (`.github/ISSUE_TEMPLATE/device-report.yml`). If you prefer to write it
yourself, this is what it needs:

```md
**OS and version:**
**Electron version:**
**electron-cast version:**
**Device model and Cast firmware:**
**Network:** IPv4 / IPv6 / both, how many adapters, Wi-Fi or wired
**What I tried:**
**What worked:**
**What failed:**
**Logs (scrubbed):**
```

### Run the live harnesses

These cast to a real device. The mirroring harness lives in `examples/live-mirroring/`. Build the library first, then:

```sh
npm run build
cd examples/live-mirroring
npm install
npm start                            # lists devices that can receive tab mirroring, then quits
npm run tab -- "<device name>"       # mirror the demo window
npm run desktop -- "<device name>"   # mirror the primary screen
```

DIAL TVs are probed with `electron-cast dial-test` (`src/dial-test/`, built to `dist/cli.js`; [how a volunteer runs
it](README.md#test-a-dial-tv)). It uses the library's own SSDP discovery, description fetch, app info, launch and stop, so what
it reports is what the library does. Everything it does is read-only except opening and closing YouTube, which it does only
after asking. It scrubs its report once, at the end, in `src/dial-test/scrub.ts`; anything new that goes into the report is
scrubbed there, and the tests in `test/dial-test/` fail if a name, serial number, UDN, MAC, address or app-info value from
the fake device appears in it. Do not run it against devices that are not yours.

The trace recorder (`tools/capture-trace.mjs`) runs one session against a device: it connects, launches the Default Media
Receiver, loads a public video, pauses, plays and stops, and always stops the app it launched. It scrubs names, ids and
addresses before it writes a file, and refuses to write if something still looks like an IP, MAC or id.

```sh
node tools/capture-trace.mjs --dry-run --out trace.json            # a fake receiver, no network
node tools/capture-trace.mjs --host <device ip> --out trace.json   # a real device
```

Each harness has a README or header comment with its options. The rules for all of them:

- **Use your own devices only.** Never cast to a device that is not yours to disturb.
- The live harnesses ask before they start casting. Read what the dialog says.
- The harnesses and the trace recorder play and stop media on the device you pick.

### Scrub before you post

Paste only scrubbed output. **Never post** device names, device ids, IP addresses, MAC addresses, Wi-Fi network names or
certificates. Not in an issue, a pull request, a test fixture or a commit. Replace them (`Living Room TV`, `192.0.2.10`)
and read the output again before you post it. The model and firmware are fine.

## Documentation

Docs are part of the change. A pull request that changes behaviour updates, as they apply:

- the [README](README.md) parity table, when Chrome parity changes;
- [docs/CHROMIUM-MAP.md](docs/CHROMIUM-MAP.md), for every new citation;
- [docs/DESIGN.md](docs/DESIGN.md), for behaviour and for every deviation from Chrome;
- the [API reference](docs/API.md) or [main-process API](docs/MAIN-API.md), for a public change;
- [CHANGELOG.md](CHANGELOG.md), under `## Unreleased`, for anything a user can see.

Each file in `docs/` starts with one `# Title` and a one-sentence summary, and pages link to each other with relative
links.

The website lives in `site/` and is built from `docs/`. To preview it:

```sh
cd site
npm ci
npm run dev
```

It is published at <https://adammpkins.github.io/electron-cast/>.

## Commits and pull requests

Commit messages are plain and in the imperative: "Bound pending media requests at Chrome's 1024". The first line says what
changed. The body, when there is one, says why. Run `git log` and match what you see.

Before you open a pull request:

- [ ] One change, with a clear description of what and why.
- [ ] Every behaviour change cites its Chromium source, and `npm run docs:check:chromium` passes.
- [ ] Any deviation from Chrome is in `docs/DESIGN.md` with the reason.
- [ ] New behaviour has tests that use the existing fakes.
- [ ] `npm run check` and `npm run build` pass. The smoke test passes if you touched `src/electron/` or `src/polyfill/`.
- [ ] Docs and `CHANGELOG.md` are updated.
- [ ] No runtime dependencies added, and nothing app-specific in `src/`.
- [ ] No device names, ids, addresses, MACs, Wi-Fi names or certificates anywhere.

## Security issues

Do not open a public issue for a security problem. Use GitHub's private vulnerability reporting: open the **Security** tab
of [the repository](https://github.com/adammpkins/electron-cast) and choose **Report a vulnerability**. [SECURITY.md](SECURITY.md)
says what to include and what the library trusts.

## Releases

Maintainers only. A release is published by `.github/workflows/publish.yml` from a tag, with npm trusted publishing and a
provenance attestation.

1. On `main`, with a clean tree: `npm ci`, `npm run check`, `npm run build` and `npm run smoke`. Run `npm run canary` and
   read the result.
2. Move the `## Unreleased` entries of the changelog under a new `## <version>` heading.
3. Set `version` in `package.json` and the lockfile (`npm install --package-lock-only`).
4. Commit, then tag and push: `git tag v<version> && git push origin main v<version>`. The workflow refuses a tag that does
   not match `package.json`, skips a version already on npm, runs `npm run check`, and publishes.
5. Confirm the version on npm, and that `electron-cast`, `electron-cast/main` and `electron-cast/preload` import from a fresh
   install.
