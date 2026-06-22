# Static Assets

Static branding assets for Impress Designs (logos, icons, favicons).

## Layout

- `source/` — checked-in **SVG sources**, the source of truth.
- `assets.toml` — the **manifest**: one entry per source file listing its name,
  description, and the outputs to generate from it.
- `dist/` — the **build output** (copied sources, generated PNGs, `index.html`,
  and `index.json`). It is not tracked in git (see `.gitignore`); CI regenerates
  and syncs it to a Cloudflare R2 bucket.

## How the build works

`scripts/build.py` (the orchestrator, Python 3.14+) reads `assets.toml`, wipes
and recreates `dist/`, and for each asset:

1. copies the source file verbatim into `dist/` at the same relative path, then
2. renders each requested output alongside it by shelling out to the Node
   renderer `scripts/render.mjs`, which owns the image tooling
   ([sharp](https://sharp.pixelplumbing.com/)).

It assembles a single index of everything produced and writes it to
`dist/index.json` for machine consumers. The human-facing homepage
(`dist/index.html`) is rendered separately by [Eleventy](https://www.11ty.dev/)
from that same JSON — see `eleventy.config.js` and the template in `src/` — so
the two never drift.

The output schema in `assets.toml` is intentionally loose — keys under
`[[asset.output]]` are forwarded as JSON to the renderer. An asset with no
outputs is simply copied verbatim (e.g. a stylesheet that needs no render step).

## Logos

The full logo lockup lives in a single `source/logos/logo-full.svg`. Its paths
are tagged with semantic classes — `background` (rounded square), `monogram`
(the "ID" mark), and `wordmark` (the text + ®) — and a default `<style>` block
renders the full-colour version when the file is viewed directly.

The entire wordmark — IMPRESS, DESIGNS, and the ® — is a single colour.

Colour variants can be produced at build time rather than as separate files by
swapping that `<style>` block via the per-output `colors` map in `assets.toml`,
but the lockup currently ships only the full-colour PNG (`#264583` square and
wordmark). The icon likewise ships only its default-colour favicons (512, 192,
180, and 32px).

## Updating the logo

The two SVGs under `source/` are generated from the brand master, not
hand-authored. To refresh them after a logo change, follow
[the SVG-refresh runbook](runbooks/refreshing-the-source-svgs.md): export the mark from the master, run it through
`scripts/postprocess-svg.mjs` (which cleans the export and tags the recolourable
`background` / `monogram` / `wordmark` classes), then rebuild.

## Build

```sh
npm install          # installs sharp (Node renderer) and Eleventy
npm run build        # build:assets (python3 scripts/build.py) then build:site (eleventy)
```

`npm run build` runs two stages in order:

1. `build:assets` — `python3 scripts/build.py` copies/renders every asset into
   `dist/` and writes `dist/index.json`.
2. `build:site` — `eleventy` renders the homepage `dist/index.html` from that
   `dist/index.json`. (It reads `dist/index.json`, so always run `build:assets`
   first; `npx @11ty/eleventy --serve` likewise needs a prior `build:assets`.)

The build needs both **Node** (for `scripts/render.mjs` + sharp, and Eleventy)
and **Python 3.14+** (the orchestrator uses `tomllib` and `pathlib.Path.copy`).
