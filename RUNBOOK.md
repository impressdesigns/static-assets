# Runbook — regenerating the source SVGs from the master

This is the procedure for refreshing `source/logos/logo-full.svg` and
`source/icons/icon.svg` from the master copy.

> The two SVGs in this repo are **generated artifacts** derived from the master —
> never hand-edit them. To change the mark, edit the master and regenerate.

The whole wordmark (IMPRESS, DESIGNS, and ®) is a single colour. The lockup is
built from three recolourable layers, matching the structure the build expects:

| Source file                  | What it is                   | Classes it carries                   |
|------------------------------|------------------------------|--------------------------------------|
| `source/logos/logo-full.svg` | icon + IMPRESS + DESIGNS + ® | `background`, `monogram`, `wordmark` |
| `source/icons/icon.svg`      | just the rounded-square mark | `background`, `monogram`             |

- `background` — the rounded square.
- `monogram` — the white "ID" knockout.
- `wordmark` — the entire wordmark (IMPRESS, DESIGNS, and ®), one colour.

The pipeline, end to end:

```
master copy --(SVG export)--> raw SVG --(postprocess-svg.mjs)--> source/*.svg --(npm run build)--> dist/ PNGs
```

Brand colours, for reference:

| Role  | Hex       | Reference    |
|-------|-----------|--------------|
| Blue  | `#264583` | Pantone 7687 |
| White | `#ffffff` | —            |
| Black | `#000000` | —            |

---

## Step 1 — Export from the master

Open the master copy in Affinity. You export **twice**, once per source file.

### 1a. Full logo → `logo-full.raw.svg`

1. Make sure the whole lockup (icon + IMPRESS + DESIGNS + ®) is visible and
   nothing is hidden.
2. **File → Export → SVG**, then click **More** to reveal all options. Set:
   - **Rasterise:** Nothing
   - **Text: Convert to curves** ← outlines the font so the file doesn't depend
     on the typeface being installed anywhere.
   - **Flatten transforms:** On ← bakes transforms into coordinates.
   - **Set viewBox:** On ← the build's rasterizer sizes off the viewBox.
   - **Use relative coordinates:** On (if offered; smaller output)
   - **Area:** Whole document
3. Export as `logo-full.raw.svg`.
4. **Sanity check:** open the file and confirm there are **zero `<text>`
   elements** — everything is `<path>`. If any `<text>` survived, "Convert to
   curves" didn't take; re-export.

### 1b. Mark only → `icon.raw.svg`

The icon is just the rounded square + the monogram knockout — no wordmark.

1. Hide the IMPRESS, DESIGNS, and ® layers so only the square + monogram remain,
   **or** duplicate the document and delete those three text objects.
2. Tighten the export area to the mark: set a square artboard around it, or select
   just the square + monogram and use **Area: Selection only**. You want a square
   `viewBox` snug to the mark — it feeds the 512/192/180/32px square favicons, so
   there must be no wordmark whitespace.
3. **File → Export → SVG**, same settings as 1a.
4. Export as `icon.raw.svg`.

> Keep the master copy as the single source of truth. The master and the raw
> exports do **not** belong in this repo — only the two processed SVGs do.

---

## Step 2 — Post-process

The raw exports carry editor cruft and write colour as inline fills on each path,
which would override the build's recolouring. The post-processor cleans them up
and tags the recolourable classes. From the repo root:

```sh
npm install   # installs the build + post-process tooling (sharp, svgo)

node scripts/postprocess-svg.mjs --kind=full logo-full.raw.svg > source/logos/logo-full.svg
node scripts/postprocess-svg.mjs --kind=icon icon.raw.svg      > source/icons/icon.svg
```

`postprocess-svg.mjs` runs SVGO (keeps the viewBox, folds transforms into
coordinates, strips editor cruft), tags each shape — white fill → `monogram`, the
square spanning the viewBox → `background`, everything else → `wordmark` — strips
the inline fills so the `<style>` block is the only colour source, and injects
that default `<style>` block. It exits non-zero with a clear message if it can't
classify a shape (for `--kind=icon` it also rejects any stray wordmark glyph), so
a bad export fails loudly rather than producing an untagged logo.

---

## Step 3 — Build and verify

```sh
npm run build   # python3 scripts/build.py → dist/
```

Then spot-check `dist/`:

- `dist/logos/logo-full-color.png` — `#264583` square, white monogram, and the
  whole wordmark (IMPRESS **and** DESIGNS) in the same blue.
- `dist/logos/logo-full-white.png` — square dropped, everything white.
- `dist/logos/logo-full-black.png` — black square and wordmark, white monogram.
- `dist/icons/icon-512.png` — blue square, white monogram, **square crop** (no
  wordmark whitespace). If there's letterbox space, the icon viewBox wasn't
  tightened in Step 1b.

Commit the two `source/*.svg` files. CI
(`.github/workflows/build-publish.yaml`) rebuilds `dist/` and publishes to GitHub
Pages on push to `main`; `dist/` itself is gitignored.

---

## Why two files instead of slicing the icon out of the full logo

The square + monogram geometry is identical in both, but the icon needs a
**square, tightly-cropped viewBox** for favicons and touch icons, whereas the
full logo's viewBox is wide to include the wordmark. Exporting them separately
from the master is simpler and less error-prone than deriving one from the other
in code, and the master is the single source either way.
