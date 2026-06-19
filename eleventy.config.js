import path from "node:path";

/**
 * Eleventy renders the human-facing homepage (dist/index.html) from the catalog
 * the asset build emits (dist/index.json). It writes into the same dist/ tree
 * the Python build populates; Eleventy never cleans its output dir, so the
 * copied sources and rendered PNGs are left untouched. Run `build:assets`
 * (which produces dist/index.json) before `build:site`.
 */
export default function (eleventyConfig) {
  // Ship the homepage stylesheet alongside the page (-> dist/styles/).
  eleventyConfig.addPassthroughCopy({ "src/styles": "styles" });

  // Link text shows the bare filename; mirrors Python's Path(file).name.
  eleventyConfig.addFilter("basename", (file) => path.basename(file));

  // Mirrors the old _colors_text(): "background: #264583; monogram: #ffffff".
  eleventyConfig.addFilter("coloursText", (colors) =>
    Object.entries(colors || {})
      .map(([cls, fill]) => `${cls}: ${fill}`)
      .join("; "),
  );

  return { dir: { input: "src", output: "dist" } };
}
