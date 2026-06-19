#!/usr/bin/env python3
"""Build the static-assets ``dist/`` tree from the ``assets.toml`` manifest.

This is the build orchestrator. It reads ``assets.toml`` (the declarative
manifest of every source asset and its requested outputs), then for each asset:

* copies the source file verbatim into ``dist/`` at the same relative path, and
* renders each requested output alongside that copy by shelling out to the Node
  renderer (``scripts/render.mjs``), which owns all image tooling (sharp).

It also assembles a single in-memory index of everything produced, writes it to
``dist/index.json`` for machine consumers, and renders ``dist/index.html`` from
that *same* structure so the two artifacts can never drift.

Requires Python 3.14+ (uses ``pathlib.Path.copy``).
"""

import html
import json
import subprocess
import sys
import tomllib
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
SOURCE_DIR = REPO_ROOT / "source"
DIST_DIR = REPO_ROOT / "dist"
MANIFEST = REPO_ROOT / "assets.toml"
RENDER_SCRIPT = REPO_ROOT / "scripts" / "render.mjs"

PAGE_TITLE = "Impress Designs Static Assets"
ROOT_GROUP_LABEL = "(root)"


def clean_dist() -> None:
    """Remove and recreate ``dist/`` so no stale outputs survive a rename/drop.

    Implemented with pathlib's own walk/unlink/rmdir (no ``shutil``). Guarded so
    we only ever delete the orchestrator-computed ``dist`` directory, never a
    path that the manifest could influence.
    """
    assert DIST_DIR == REPO_ROOT / "dist", "refusing to clean unexpected path"
    if DIST_DIR.exists():
        for parent, dirs, files in DIST_DIR.walk(top_down=False):
            for name in files:
                (parent / name).unlink()
            for name in dirs:
                (parent / name).rmdir()
        DIST_DIR.rmdir()
    DIST_DIR.mkdir(parents=True)


def ensure_within(path: Path, base: Path, label: str) -> Path:
    """Resolve ``path`` and confirm it stays inside ``base`` (reject traversal)."""
    resolved = path.resolve()
    if not resolved.is_relative_to(base.resolve()):
        raise SystemExit(f"{label} path escapes {base}: {path}")
    return resolved


def group_for(rel_file: str) -> str:
    """Folder header for an asset: its parent dir relative to ``source/``."""
    parent = Path(rel_file).parent.as_posix()
    return ROOT_GROUP_LABEL if parent == "." else parent


def render_output(input_path: Path, output_path: Path, spec: dict) -> None:
    """Invoke the Node renderer for one output; fail the build if it errors."""
    try:
        subprocess.run(
            ["node", str(RENDER_SCRIPT), str(input_path), str(output_path), json.dumps(spec)],
            check=True,
            capture_output=True,
            text=True,
        )
    except subprocess.CalledProcessError as err:
        sys.stderr.write(err.stderr or "")
        raise SystemExit(f"render failed for {output_path}") from err
    if not output_path.is_file():
        raise SystemExit(f"renderer reported success but {output_path} is missing")


def build_index() -> dict:
    """Copy + render every asset, returning the index dict that drives output."""
    with MANIFEST.open("rb") as handle:
        manifest = tomllib.load(handle)

    # Group assets by folder while preserving manifest order for reproducibility.
    groups: dict[str, list[dict]] = {}

    for asset in manifest.get("asset", []):
        rel_file = asset["file"]
        src_path = ensure_within(SOURCE_DIR / rel_file, SOURCE_DIR, "source")
        if not src_path.is_file():
            raise SystemExit(f"missing source asset: {rel_file}")

        # Copy the original verbatim to the same relative position in dist/.
        dest_path = ensure_within(DIST_DIR / rel_file, DIST_DIR, "dist output")
        dest_path.parent.mkdir(parents=True, exist_ok=True)
        src_path.copy(dest_path)  # pathlib.Path.copy (3.14+), replaces shutil.copy2

        # Render each requested output alongside the copied original.
        outputs: list[dict] = []
        for output in asset.get("output", []):
            spec = {key: value for key, value in output.items() if key != "file"}
            out_path = ensure_within(dest_path.parent / output["file"], DIST_DIR, "dist output")
            out_path.parent.mkdir(parents=True, exist_ok=True)
            render_output(src_path, out_path, spec)
            outputs.append({"file": out_path.relative_to(DIST_DIR).as_posix(), **spec})

        groups.setdefault(group_for(rel_file), []).append(
            {
                "name": asset["name"],
                "description": asset["description"],
                "source": Path(rel_file).as_posix(),
                "outputs": outputs,
            }
        )

    return {
        "name": PAGE_TITLE,
        "groups": [{"name": name, "assets": assets} for name, assets in groups.items()],
    }


def _esc(value: object) -> str:
    return html.escape(str(value), quote=True)


def _colors_text(colors: dict) -> str:
    return "; ".join(f"{cls}: {fill}" for cls, fill in colors.items())


def render_html(index: dict) -> str:
    """Render the human-facing index page from the same dict as index.json."""
    lines = [
        "<!doctype html>",
        '<html lang="en">',
        "  <head>",
        '    <meta charset="utf-8" />',
        '    <meta name="viewport" content="width=device-width, initial-scale=1" />',
        f"    <title>{_esc(index['name'])}</title>",
        "  </head>",
        "  <body>",
        f"    <h1>{_esc(index['name'])}</h1>",
    ]
    for group in index["groups"]:
        lines.append(f"    <h2>{_esc(group['name'])}</h2>")
        for asset in group["assets"]:
            source = _esc(asset["source"])
            lines.append(f"    <h3>{_esc(asset['name'])}</h3>")
            lines.append(f"    <p>{_esc(asset['description'])}</p>")
            lines.append(f'    <p>Source: <a href="{source}"><code>{source}</code></a></p>')
            if not asset["outputs"]:
                lines.append("    <p>Copied verbatim (no transformations).</p>")
                continue
            lines.append("    <table>")
            lines.append("      <thead>")
            lines.append(
                "        <tr><th>Output</th><th>Format</th><th>Width</th>"
                "<th>Height</th><th>Colours</th></tr>"
            )
            lines.append("      </thead>")
            lines.append("      <tbody>")
            for output in asset["outputs"]:
                href = _esc(output["file"])
                name = _esc(Path(output["file"]).name)
                fmt = _esc(output.get("format", "—"))
                width = _esc(output.get("width", "—"))
                height = _esc(output.get("height", "—"))
                colours = output.get("colors")
                colours_cell = _esc(_colors_text(colours)) if colours else "—"
                lines.append(
                    f'        <tr><td><a href="{href}">{name}</a></td>'
                    f"<td>{fmt}</td><td>{width}</td><td>{height}</td>"
                    f"<td>{colours_cell}</td></tr>"
                )
            lines.append("      </tbody>")
            lines.append("    </table>")
    lines.append("  </body>")
    lines.append("</html>")
    return "\n".join(lines) + "\n"


def main() -> None:
    clean_dist()
    index = build_index()

    # Build the full index first, then serialize both artifacts from it so the
    # machine-readable JSON and the HTML page can never drift out of sync.
    (DIST_DIR / "index.json").write_text(
        json.dumps(index, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
    )
    (DIST_DIR / "index.html").write_text(render_html(index), encoding="utf-8")

    total = sum(len(asset["outputs"]) for group in index["groups"] for asset in group["assets"])
    print(f"✓ dist/ ← {total} output(s) across {len(index['groups'])} group(s)")


if __name__ == "__main__":
    main()
