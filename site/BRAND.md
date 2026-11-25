# Brand

How electron-cast looks and talks. This page is for contributors: if you add a page, a diagram or an image, keep to it.

## The idea: on air

electron-cast puts your app on air. The identity borrows from broadcast engineering: a well-made technical manual, and
the tally light on a camera that tells everyone this one is live. The page is paper and ink. There is one signal colour,
tally red-orange, and it is used for the one thing to look at: the live state, the primary action.

## Mark

![The electron-cast mark: a square-cornered letter c with a red square passing out through its opening](/brand/mark.svg)

A square-cornered lowercase **c** built from one heavy stroke, open on the right, with a **tally square** straddling the
opening. The c is the library and the first letter of cast. The square is the signal being handed over, and the one lit
thing in the picture. It is not the Google Cast icon (a screen with waves), Chrome's ring or Electron's atom, and it
should never be drawn with waves, rings or orbits.

The vector geometry lives in `brand/mark.json` on a 64-unit grid (two flat layers, the c and the square). It is the source
of truth for every file below; change it there and rebuild.

| File | Use |
|---|---|
| `brand/mark.svg` | Colour, on paper |
| `brand/mark-on-dark.svg` | Colour, on ink |
| `brand/mark-mono-ink.svg`, `brand/mark-mono-white.svg` | One colour: stamps, print, embossing |
| `brand/app-icon.svg`, `favicon.svg` | The mark on an ink tile |
| `brand/wordmark.svg`, `brand/wordmark-on-dark.svg` | The name alone |
| `brand/lockup.svg`, `brand/lockup-on-dark.svg` | Mark and wordmark together (the default) |
| `brand/og.png`, `brand/og.svg` | Social card, 1200 by 630 |

**Wordmark.** `electron-cast` in lowercase, Archivo ExtraBold at its condensed width, outlined to paths so it needs no font.

**Clear space.** Keep at least the width of the tally square free on every side.

**Minimum size.** The mark: 16 px. The lockup: 120 px wide.

**Never** recolour the square to anything but tally (or ink or paper in the mono versions), stretch the mark, put it on a
busy photo, add a glow or shadow, or enclose it in a circle.

## Palette

| Name | Hex | Role |
|---|---|---|
| Ink | `#15130F` | Text on paper, the dark theme's ground, the TV bezel |
| Paper | `#F4F1EA` | The light theme's ground, text on ink |
| Tally | `#FF4A1C` | Dots, fills and large marks. 5.5:1 on ink, 3.0:1 on paper, so not for small text |
| Tally, text on paper | `#B02A06` | Tally as small text or a thin rule on paper. 5.9:1 on paper |
| Tally, text on ink | `#FF6B47` | Tally as small text on ink. 6.6:1 on ink |
| Graphite | `#5A564E` | Secondary text. 6.5:1 on paper |
| Rule | `#D7D2C7` | Hairlines and the blueprint grid |

Dark mode is the control room: ink ground, paper text, the same tally. Ink on tally is 5.5:1, so the primary button
carries ink text. There are no other hues: no teal or cyan (too close to Electron's own colour), no Chrome four-colour,
no purple. There is no gradient anywhere.

## Type

All fonts are self-hosted (the `@fontsource` packages in `site/`); nothing loads from a font CDN.

| Role | Font | Use |
|---|---|---|
| Display and text | Archivo (variable, width and weight axes) | Headings at the condensed end and heavy, like equipment labels. Body at normal width |
| Code and labels | Commit Mono | Code, file paths, diagram labels, annotations, sidenotes |

Sentence case in headings. Small mono labels may be capitals where they read as a panel marking (`SRC`, `ON AIR`).

## Motifs

1. **The tally dot.** The mark's square, used as a marker and as the "on air" light. It is lit only when something is
   live: for example when the visitor really is casting from the demo. Otherwise it is a dull grey square.
2. **Signal-flow diagrams.** Boxes, arrows and mono labels, like a broadcast block diagram. One box is lit.
3. **The blueprint grid.** A 40 px hairline grid behind the hero and the social card only, at 7 to 10 percent.
4. **NO SIGNAL.** A greyscale test card, the screen's fallback when no Cast device or no Chrome is found.
5. **The manual grid.** Numbered sections (01, 02), hairline rules, a left rail, Chromium citations as margin
   sidenotes on wide screens. Square corners, or 2 px at most. Flat: no shadows except a hard 1 px offset where
   something is pressed.

## Voice

Plain, specific and a little dry. The project tells you what it does, what it checks and what it does not do yet, and
sounds like a person who has stood in front of a TV waiting for it to show the picture.

Do:

- Name the thing: `selectDevice`, `cast_auth_util.cc`, Nest Hub Max. Give numbers only when they are real (8 devices, 20 weeks).
- Say what is untested. "macOS is not tested" is a feature of the docs.
- Keep sentences short. Use active verbs and the second person.
- Allow one dry joke per page at most, and never at the reader's expense.

Don't:

- Use buzzwords: seamless, effortless, powerful, robust, unlock, supercharge, blazing, game-changing, elevate, leverage.
- Make claims about Google or Chrome you cannot tie to source. Cite the Chromium file.
- Use emoji, exclamation marks, or "simply" and "just".
- Lean on em dashes. Use a full stop or a comma.
- Imply an endorsement. electron-cast is not affiliated with Google or the Electron project.

## Rebuilding the assets

Every file under `site/public/brand/`, plus the favicon set, is built by `site/brand/build.mjs` from the mark
(`site/brand/mark.json`). From `site/`:

```sh
python brand/instance.py node_modules/@fontsource-variable/archivo/files/archivo-latin-wdth-normal.woff2 brand/.cache/archivo-wordmark.ttf wght=800 wdth=70
python brand/instance.py node_modules/@fontsource-variable/archivo/files/archivo-latin-wdth-normal.woff2 brand/.cache/archivo-card.ttf wght=500 wdth=100
npm run brand
```

The first two lines cut static instances of Archivo so the wordmark and banner text can be outlined (needs Python with
`fonttools` and `brotli`). The built files are committed, so a normal site build does not need either.
