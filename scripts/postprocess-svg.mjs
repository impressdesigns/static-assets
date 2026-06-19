#!/usr/bin/env node
/**
 * Turn a raw SVG export of the brand mark into a clean, class-tagged,
 * recolourable source for this repo.
 *
 *   node scripts/postprocess-svg.mjs --kind=<full|icon> <raw.svg>
 *
 * Reads a raw export from the master copy (which carries editor cruft and writes
 * colour as inline `fill`/`style` on each path) and writes a cleaned source SVG
 * to STDOUT, ready to drop into `source/`:
 *
 *   node scripts/postprocess-svg.mjs --kind=full logo-full.raw.svg > source/logos/logo-full.svg
 *   node scripts/postprocess-svg.mjs --kind=icon icon.raw.svg      > source/icons/icon.svg
 *
 * What it does, in order:
 *   1. SVGO pass — keep the viewBox, fold transforms into coordinates, round
 *      coordinates, strip editor cruft (DOCTYPE, serif: namespace, comments,
 *      metadata). Never merges paths or distorts geometry.
 *   2. Tag each rendered shape with a semantic class:
 *        - white fill                         -> `monogram` (the "ID" knockout)
 *        - bbox spanning the viewBox height   -> `background` (the rounded square)
 *        - everything else                    -> `wordmark`
 *      Classification is colour-agnostic beyond "is it white": the wordmark lands
 *      in one layer (one colour) regardless of how the export coloured it.
 *   3. Strip the inline `fill` from every tagged shape so the injected <style>
 *      block is the only thing that sets colour — this is what lets the build
 *      recolour the mark by swapping that block (see scripts/render.mjs).
 *   4. Inject the default <style> block the renderer swaps at build time.
 *
 * The script is deterministic and idempotent, keeps STDOUT pure SVG (all
 * diagnostics go to STDERR), and exits non-zero with a clear message rather than
 * ever emitting an untagged logo.
 */
import { readFileSync } from "node:fs";
import { optimize } from "svgo";

const BRAND_BLUE = "#264583";
const WHITE = "#ffffff";

// A path counts as the background square when its bounding box spans at least
// this fraction of the viewBox *height*. The square is the full-height element
// in both the square icon and the wide lockup (where it covers only ~22% of the
// width), so height — not area — is the signal that works for both.
const HEIGHT_COVERAGE = 0.85;

// The default <style> blocks the renderer swaps at build time. They mirror the
// committed sources exactly (full logo keeps the CSS-variable theming hooks; the
// icon uses plain fills) so re-exporting produces a clean diff. Either form
// satisfies render.mjs's swap regex and does not affect the rasterised output.
const STYLE_FULL = `  <style>
    /* Default fills render the full-colour lockup when the file is viewed
       directly. Consumers that inline this SVG can recolour any layer by
       setting the matching CSS custom property (e.g. --logo-wordmark) so the
       mark can follow a light/dark theme without shipping multiple files. */
    .background { fill: var(--logo-square, ${BRAND_BLUE}); }
    .monogram  { fill: var(--logo-monogram, ${WHITE}); }
    .wordmark  { fill: var(--logo-wordmark, ${BRAND_BLUE}); }
  </style>`;

const STYLE_ICON = `  <style>
    .background { fill: ${BRAND_BLUE}; }
    .monogram  { fill: ${WHITE}; }
  </style>`;

function fail(message) {
  process.stderr.write(`postprocess-svg: ${message}\n`);
  process.exit(1);
}

const USAGE = "Usage: node scripts/postprocess-svg.mjs --kind=<full|icon> <raw.svg>";

function parseArgs(argv) {
  let kind = null;
  let input = null;
  for (const arg of argv) {
    if (arg.startsWith("--kind=")) kind = arg.slice("--kind=".length);
    else if (arg === "--kind") fail(`--kind needs a value (--kind=full or --kind=icon)\n${USAGE}`);
    else if (arg.startsWith("-")) fail(`unknown option: ${arg}\n${USAGE}`);
    else if (input === null) input = arg;
    else fail(`unexpected extra argument: ${arg}\n${USAGE}`);
  }
  if (kind !== "full" && kind !== "icon") {
    fail(`--kind must be "full" or "icon"${kind ? `, got "${kind}"` : ""}\n${USAGE}`);
  }
  if (input === null) fail(`missing input SVG\n${USAGE}`);
  return { kind, input };
}

// --- colour helpers ---------------------------------------------------------

// Pull a `fill:` declaration out of an inline `style` attribute, if present.
function fillFromStyle(style) {
  if (!style) return null;
  const match = /(?:^|;)\s*fill\s*:\s*([^;]+)/i.exec(style);
  return match ? match[1].trim() : null;
}

// Normalise a colour to canonical `#rrggbb` (or "none"/null) so white can be
// recognised however the export wrote it (#fff, #FFFFFF, white, rgb(255,...)).
function normalizeColour(value) {
  if (value == null) return null;
  let c = String(value).trim().toLowerCase();
  if (c === "" || c === "none") return c === "none" ? "none" : null;
  if (c === "white") return "#ffffff";
  if (c === "black") return "#000000";
  const rgb = /^rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)$/.exec(c);
  if (rgb) {
    return "#" + rgb.slice(1).map((n) => Math.min(255, +n).toString(16).padStart(2, "0")).join("");
  }
  const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/.exec(c);
  if (short) return `#${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}`;
  const full = /^#([0-9a-f]{6})$/.exec(c);
  if (full) return `#${full[1]}`;
  return c;
}

function resolveFill(node) {
  const attrs = node.attributes || {};
  const fromStyle = fillFromStyle(attrs.style);
  return normalizeColour(fromStyle != null ? fromStyle : attrs.fill);
}

// Remove `fill` (attribute and inline-style declaration) so the <style> block is
// the sole colour source; without this the inline fill overrides the recolour.
// Also drop the editor's no-op `stroke:none` — the mark is fills-only, so it is
// pure cruft; a meaningful coloured stroke would be left untouched.
function stripFill(node) {
  const attrs = node.attributes;
  delete attrs.fill;
  if (attrs.stroke === "none" || attrs.stroke === "transparent") delete attrs.stroke;
  if (attrs.style != null) {
    const kept = attrs.style
      .split(";")
      .map((d) => d.trim())
      .filter((d) => d && !/^fill\s*:/i.test(d) && !/^stroke\s*:\s*(none|transparent)$/i.test(d));
    if (kept.length) attrs.style = kept.join(";");
    else delete attrs.style;
  }
}

// --- geometry ---------------------------------------------------------------

// Bounding box of a path's `d`, handling absolute and relative commands and arc
// flag parsing. Control points expand the box slightly (a safe overestimate);
// that is harmless here because the background square is identified by spanning
// the viewBox, not by a precise area. Returns null if `d` can't be walked.
function bboxFromPathData(d) {
  if (!d) return null;
  const n = d.length;
  let i = 0;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  let cx = 0, cy = 0, sx = 0, sy = 0; // current point, subpath start
  let cmd = null;

  const skipSep = () => { while (i < n && (d[i] === " " || d[i] === "\t" || d[i] === "\n" || d[i] === "\r" || d[i] === ",")) i++; };
  function readNumber() {
    skipSep();
    const start = i;
    if (d[i] === "+" || d[i] === "-") i++;
    while (i < n && d[i] >= "0" && d[i] <= "9") i++;
    if (d[i] === ".") { i++; while (i < n && d[i] >= "0" && d[i] <= "9") i++; }
    if (d[i] === "e" || d[i] === "E") { i++; if (d[i] === "+" || d[i] === "-") i++; while (i < n && d[i] >= "0" && d[i] <= "9") i++; }
    if (i === start) return NaN;
    return parseFloat(d.slice(start, i));
  }
  function readFlag() {
    skipSep();
    const ch = d[i];
    if (ch === "0" || ch === "1") { i++; return ch === "1" ? 1 : 0; }
    return NaN;
  }
  const record = (x, y) => {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  };

  while (i < n) {
    skipSep();
    if (i >= n) break;
    const ch = d[i];
    if ((ch >= "A" && ch <= "Z") || (ch >= "a" && ch <= "z")) { cmd = ch; i++; }
    else if (cmd === null) return null; // numbers before any command
    if (cmd === null) return null;

    const rel = cmd >= "a" && cmd <= "z";
    const type = cmd.toUpperCase();
    switch (type) {
      case "M": {
        let x = readNumber(), y = readNumber();
        if (Number.isNaN(x) || Number.isNaN(y)) return null;
        if (rel) { x += cx; y += cy; }
        cx = x; cy = y; sx = x; sy = y; record(x, y);
        cmd = rel ? "l" : "L"; // subsequent implicit pairs are lineto
        break;
      }
      case "L": {
        let x = readNumber(), y = readNumber();
        if (Number.isNaN(x) || Number.isNaN(y)) return null;
        if (rel) { x += cx; y += cy; }
        cx = x; cy = y; record(x, y);
        break;
      }
      case "H": {
        let x = readNumber();
        if (Number.isNaN(x)) return null;
        if (rel) x += cx;
        cx = x; record(x, cy);
        break;
      }
      case "V": {
        let y = readNumber();
        if (Number.isNaN(y)) return null;
        if (rel) y += cy;
        cy = y; record(cx, y);
        break;
      }
      case "C": {
        let x1 = readNumber(), y1 = readNumber(), x2 = readNumber(), y2 = readNumber(), x = readNumber(), y = readNumber();
        if ([x1, y1, x2, y2, x, y].some(Number.isNaN)) return null;
        if (rel) { x1 += cx; y1 += cy; x2 += cx; y2 += cy; x += cx; y += cy; }
        record(x1, y1); record(x2, y2); record(x, y); cx = x; cy = y;
        break;
      }
      case "S":
      case "Q": {
        let a = readNumber(), b = readNumber(), x = readNumber(), y = readNumber();
        if ([a, b, x, y].some(Number.isNaN)) return null;
        if (rel) { a += cx; b += cy; x += cx; y += cy; }
        record(a, b); record(x, y); cx = x; cy = y;
        break;
      }
      case "T": {
        let x = readNumber(), y = readNumber();
        if (Number.isNaN(x) || Number.isNaN(y)) return null;
        if (rel) { x += cx; y += cy; }
        record(x, y); cx = x; cy = y;
        break;
      }
      case "A": {
        const rx = readNumber(), ry = readNumber(), rot = readNumber();
        const laf = readFlag(), sf = readFlag();
        let x = readNumber(), y = readNumber();
        if ([rx, ry, rot, laf, sf, x, y].some(Number.isNaN)) return null;
        if (rel) { x += cx; y += cy; }
        record(x, y); cx = x; cy = y; // arc endpoint (corner bulge ignored)
        break;
      }
      case "Z": {
        cx = sx; cy = sy;
        break;
      }
      default:
        return null;
    }
  }
  if (minX === Infinity) return null;
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

// Fillable shapes we classify. The background square is typically a (rounded)
// <rect> — SVGO does not convert rounded rects to paths — so we read geometry
// per shape rather than assuming everything is a <path>.
const RENDERABLE = new Set(["path", "rect", "circle", "ellipse", "polygon"]);

function bboxForElement(node) {
  const a = node.attributes || {};
  const num = (v, d = 0) => {
    const parsed = parseFloat(v);
    return Number.isFinite(parsed) ? parsed : d;
  };
  switch (node.name) {
    case "path":
      return bboxFromPathData(a.d || "");
    case "rect": {
      const w = num(a.width), h = num(a.height);
      if (!(w > 0) || !(h > 0)) return null;
      return { x: num(a.x), y: num(a.y), width: w, height: h };
    }
    case "circle": {
      const r = num(a.r);
      if (!(r > 0)) return null;
      return { x: num(a.cx) - r, y: num(a.cy) - r, width: 2 * r, height: 2 * r };
    }
    case "ellipse": {
      const rx = num(a.rx), ry = num(a.ry);
      if (!(rx > 0) || !(ry > 0)) return null;
      return { x: num(a.cx) - rx, y: num(a.cy) - ry, width: 2 * rx, height: 2 * ry };
    }
    case "polygon": {
      const nums = (a.points || "").match(/-?\d*\.?\d+(?:e[-+]?\d+)?/gi);
      if (!nums || nums.length < 2) return null;
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (let k = 0; k + 1 < nums.length; k += 2) {
        const x = +nums[k], y = +nums[k + 1];
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
      return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
    }
    default:
      return null;
  }
}

function parseViewBox(svgNode) {
  const attrs = svgNode.attributes || {};
  if (attrs.viewBox) {
    const parts = attrs.viewBox.trim().split(/[\s,]+/).map(Number);
    if (parts.length === 4 && parts.every(Number.isFinite)) {
      return { x: parts[0], y: parts[1], w: parts[2], h: parts[3] };
    }
  }
  const w = parseFloat(attrs.width);
  const h = parseFloat(attrs.height);
  if (Number.isFinite(w) && Number.isFinite(h)) return { x: 0, y: 0, w, h };
  return null;
}

// --- classification ---------------------------------------------------------

function classifyAndMutate(shapes, viewBox, kind) {
  if (shapes.length === 0) fail("no renderable shapes found outside <defs>; nothing to classify");

  const transformed = shapes.filter((s) => s.underTransform);
  if (transformed.length) {
    fail(
      `${transformed.length} shape(s) still carry a transform after optimisation; ` +
      `re-export with "Flatten transforms: On" so coordinates are in viewBox space`,
    );
  }

  let background = 0, monogram = 0, wordmark = 0;
  for (const s of shapes) {
    const existing = s.node.attributes.class;
    if (existing === "background" || existing === "monogram" || existing === "wordmark") {
      s.cls = existing; // already tagged — re-running is a fixed point
    } else if (s.fill === WHITE) {
      s.cls = "monogram";
    } else if (!s.bbox) {
      fail(`could not compute a bounding box for a <${s.node.name}>; cannot classify it`);
    } else {
      s.cls = s.bbox.height / viewBox.h >= HEIGHT_COVERAGE ? "background" : "wordmark";
    }
    if (s.cls === "background") background++;
    else if (s.cls === "monogram") monogram++;
    else wordmark++;
  }

  if (background === 0) {
    fail("no shape spans the viewBox height (>=85%); cannot identify the background square — check the export");
  }
  if (monogram === 0) {
    process.stderr.write("postprocess-svg: warning — no white (monogram) shape found; the knockout may be missing from the export\n");
  }
  if (kind === "icon" && wordmark > 0) {
    fail(`--kind=icon but ${wordmark} shape(s) are neither background nor monogram (a stray wordmark glyph?); refusing to emit`);
  }

  for (const s of shapes) {
    s.node.attributes.class = s.cls;
    stripFill(s.node);
  }
}

// SVGO plugin: collect rendered shapes (skipping anything inside <defs>/<clipPath>
// and the like), then classify + strip fills once the whole tree has been seen.
function classifyPlugin(kind) {
  const CONTAINERS = new Set(["defs", "clipPath", "mask", "pattern", "marker", "symbol"]);
  return {
    name: "id-classify",
    fn() {
      const shapes = [];
      let viewBox = null;
      let containerDepth = 0;
      let transformDepth = 0;
      const isTransformed = (node) => node.attributes && node.attributes.transform != null && node.attributes.transform !== "";
      return {
        element: {
          enter(node) {
            if (node.name === "svg" && viewBox === null) viewBox = parseViewBox(node);
            if (CONTAINERS.has(node.name)) containerDepth++;
            if (isTransformed(node)) transformDepth++;
            if (RENDERABLE.has(node.name) && containerDepth === 0) {
              shapes.push({
                node,
                fill: resolveFill(node),
                bbox: bboxForElement(node),
                underTransform: transformDepth > 0, // own or ancestor transform
              });
            }
          },
          exit(node) {
            if (isTransformed(node)) transformDepth--;
            if (CONTAINERS.has(node.name)) containerDepth--;
            if (node.name === "svg") {
              if (viewBox === null) fail("<svg> has no usable viewBox or width/height; cannot compute coverage");
              classifyAndMutate(shapes, viewBox, kind);
            }
          },
        },
      };
    },
  };
}

// --- string-level cleanup / injection ---------------------------------------

function stripSerifNamespace(svg) {
  return svg
    .replace(/\s+xmlns:serif="[^"]*"/g, "")
    .replace(/\s+serif:[\w-]+="[^"]*"/g, "");
}

// Replace any existing <style> block(s) with the canonical one, or insert it
// right after the <svg> open tag. Using render.mjs's own swap regex shape keeps
// this idempotent: a re-run finds the block we wrote and replaces it identically.
function injectStyle(svg, kind) {
  const block = kind === "full" ? STYLE_FULL : STYLE_ICON;
  // Drop any existing <style> block(s) whole-line so surrounding indentation is
  // left intact, then re-insert the canonical block right after the <svg> tag.
  let out = svg
    .replace(/^[ \t]*<style[^>]*>[\s\S]*?<\/style>[ \t]*\r?\n/gm, "")
    .replace(/[ \t]*<style[^>]*>[\s\S]*?<\/style>/g, "");
  if (!/<svg\b[^>]*>/.test(out)) fail("no <svg> element in optimised output");
  return out.replace(/(<svg\b[^>]*>)[ \t]*\r?\n?/, `$1\n${block}\n`);
}

function main() {
  const { kind, input } = parseArgs(process.argv.slice(2));

  let raw;
  try {
    raw = readFileSync(input, "utf8");
  } catch (err) {
    fail(`cannot read input SVG: ${input} (${err.code || err.message})`);
  }

  let result;
  try {
    result = optimize(raw, {
      path: input,
      multipass: false,
      js2svg: { pretty: true, indent: 2 },
      plugins: [
        {
          name: "preset-default",
          params: {
            overrides: {
              removeViewBox: false, // the rasterizer sizes off the viewBox
              mergePaths: false, // never merge — it would break per-path classes
              cleanupIds: false, // keep ids stable for clean diffs
              removeUselessStrokeAndFill: false, // keep fills so we can read them
              removeXMLProcInst: false, // keep <?xml?> to match the committed sources
            },
          },
        },
        classifyPlugin(kind),
      ],
    });
  } catch (err) {
    fail(`SVGO failed to process ${input}: ${err.message}`);
  }

  let out = result.data;
  out = stripSerifNamespace(out);
  out = injectStyle(out, kind);
  out = out.replace(/\s+$/, "") + "\n";
  process.stdout.write(out);
}

main();
