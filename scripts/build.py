#!/usr/bin/env python3
"""Build the static-assets ``dist/`` tree from the ``assets.toml`` manifest.

This is the build orchestrator. It reads ``assets.toml`` (the declarative
manifest of every source asset and its requested outputs), then for each asset:

* copies the source file verbatim into ``dist/`` at the same relative path, and
* renders each requested output alongside that copy by shelling out to the Node
  renderer (``scripts/render.mjs``), which owns all image tooling (sharp).

It also assembles a single in-memory index of everything produced and writes it
to ``dist/index.json`` for machine consumers. The human-facing homepage
(``dist/index.html``) is rendered separately by Eleventy from that *same* JSON
(see ``eleventy.config.js``), so the two artifacts can never drift.

Requires Python 3.14+ (uses ``pathlib.Path.copy``).
"""

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
    if DIST_DIR != REPO_ROOT / "dist":
        raise SystemExit(f"refusing to clean unexpected path: {DIST_DIR}")
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


def ensure_bare_filename(name: str, label: str) -> str:
    """Confirm an output ``file`` is a plain filename (no directory, no traversal).

    Per the manifest contract an output lands next to its copied source, so a
    value like ``../index.json`` (which would resolve back inside ``dist/`` and
    clobber a generated file) must be rejected.
    """
    if name in ("", ".", "..") or "/" in name or "\\" in name:
        raise SystemExit(f"{label}: output file must be a bare filename, got {name!r}")
    return name


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

    # Track every path we write under dist/ so two assets (or an output and a
    # copied source) can't silently clobber each other. index.json (written
    # here) and index.html (rendered post-build by Eleventy from that JSON) are
    # reserved up front so no manifest entry can occupy or overwrite either path.
    claimed: dict[Path, str] = {
        (DIST_DIR / "index.json").resolve(): "generated index.json",
        (DIST_DIR / "index.html").resolve(): "index.html (rendered by Eleventy)",
    }

    def claim(path: Path, label: str) -> Path:
        resolved = ensure_within(path, DIST_DIR, label)
        if resolved in claimed:
            raise SystemExit(
                f"output collision: {label} and {claimed[resolved]} both target "
                f"{resolved.relative_to(DIST_DIR)}"
            )
        claimed[resolved] = label
        return resolved

    for asset in manifest.get("asset", []):
        rel_file = asset["file"]
        src_path = ensure_within(SOURCE_DIR / rel_file, SOURCE_DIR, "source")
        if not src_path.is_file():
            raise SystemExit(f"missing source asset: {rel_file}")

        # Copy the original verbatim to the same relative position in dist/.
        dest_path = claim(DIST_DIR / rel_file, f"source copy {rel_file}")
        dest_path.parent.mkdir(parents=True, exist_ok=True)
        src_path.copy(dest_path)  # pathlib.Path.copy (3.14+), replaces shutil.copy2

        # Render each requested output alongside the copied original. `file` is a
        # bare filename by contract, so an output always lands next to its source
        # and can never traverse out of that directory.
        outputs: list[dict] = []
        for output in asset.get("output", []):
            filename = ensure_bare_filename(output["file"], f"output of {rel_file}")
            spec = {key: value for key, value in output.items() if key != "file"}
            out_path = claim(dest_path.parent / filename, f"output {rel_file} -> {filename}")
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


def main() -> None:
    clean_dist()
    index = build_index()

    # Build the full index first, then write it as JSON. Eleventy renders the
    # human-facing homepage from this same file (see eleventy.config.js), so the
    # JSON stays the single source of truth for both consumers and can't drift.
    (DIST_DIR / "index.json").write_text(
        json.dumps(index, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
    )

    total = sum(len(asset["outputs"]) for group in index["groups"] for asset in group["assets"])
    print(f"✓ dist/ ← {total} output(s) across {len(index['groups'])} group(s)")


if __name__ == "__main__":
    main()
