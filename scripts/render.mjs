#!/usr/bin/env node
/**
 * Render a single output asset from an SVG source.
 *
 * This is invoked once per requested output by the Python orchestrator
 * (scripts/build.py):
 *
 *   node scripts/render.mjs <inputPath> <outputPath> <specJson>
 *
 * `specJson` is one [[asset.output]] table from assets.toml serialized as JSON
 * (e.g. {"format":"png","width":512,"height":512} or a recolour variant with a
 * `colors` map). This script owns all rasterization semantics (sharp); the
 * orchestrator stays image-tooling agnostic and just forwards the spec.
 *
 * The full logo lockup ships as a single logo-full.svg whose paths are tagged
 * with semantic classes (`background`, `monogram`, `wordmark`). A `colors` map
 * (class name -> fill) recolours the source SVG before rasterizing by swapping
 * its <style> block, so one source yields every colour variant. `none` hides a
 * layer (e.g. the white variant drops the background square).
 */
import { readFile } from "node:fs/promises";
import sharp from "sharp";

// Replace the SVG's <style> block with target-specific fills. Swapping (rather
// than appending) the block keeps CSS source order irrelevant.
function applyColors(svg, colors) {
  const rules = Object.entries(colors)
    .map(([cls, fill]) => `    .${cls} { fill: ${fill}; }`)
    .join("\n");
  return svg.replace(/<style[^>]*>[\s\S]*?<\/style>/, `<style>\n${rules}\n  </style>`);
}

// High render density so the SVG is rasterized above the largest target size,
// then downscaled for crisp edges.
const DENSITY = 1200;

async function render(inputPath, outputPath, spec) {
  let svg = await readFile(inputPath, "utf8");
  if (spec.colors && Object.keys(spec.colors).length > 0) {
    svg = applyColors(svg, spec.colors);
  }

  // Square icons set both width & height; lockups set width and keep the source
  // aspect ratio (height is undefined, which sharp derives automatically).
  let pipeline = sharp(Buffer.from(svg), { density: DENSITY }).resize({
    width: spec.width,
    height: spec.height,
    fit: "contain",
    background: { r: 0, g: 0, b: 0, alpha: 0 },
  });

  switch (spec.format) {
    case "png":
      pipeline = pipeline.png({ compressionLevel: 9 });
      break;
    default:
      throw new Error(`Unsupported output format: ${JSON.stringify(spec.format)}`);
  }

  await pipeline.toFile(outputPath);
}

async function main() {
  const [inputPath, outputPath, specJson] = process.argv.slice(2);
  if (!inputPath || !outputPath || !specJson) {
    throw new Error("Usage: node scripts/render.mjs <inputPath> <outputPath> <specJson>");
  }
  const spec = JSON.parse(specJson);
  await render(inputPath, outputPath, spec);
  console.log(`✓ ${inputPath} → ${outputPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
