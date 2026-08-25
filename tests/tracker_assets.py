"""Static-asset contract checks.

Offline: no server, no container, no network. Run with

    python3 tests/tracker_assets.py

Exists because of a real failure. The browser reported

    The API version "4.0.379" does not match the Worker version "5.2.133"

while the server was serving 4.0.379 the whole time. Two things made that
possible, and each is now asserted here:

  1. `pdf.worker.min.mjs` is a COMMITTED binary. Bump `pdfjs-dist` in
     package.json and nothing re-copies it, so the API and the worker drift
     apart with no error until a PDF is opened.
  2. The worker was requested from a bare, unversioned path with no
     Cache-Control, on a port that hosts a different app every few weeks — so a
     browser could hand pdf.js a worker cached from something else entirely.
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
UI = ROOT / "agent-ui"

PASS = "\033[32mok\033[0m"
FAIL = "\033[31mBAD\033[0m"


class Results:
    def __init__(self) -> None:
        self.failed = 0
        self.total = 0

    def check(self, name: str, got, want) -> None:
        self.total += 1
        good = got == want
        if not good:
            self.failed += 1
        print(f"  {name:<58} {str(got)[:28]:<30} {PASS if good else FAIL}")
        if not good:
            print(f"      wanted: {want!r}")


def pinned_version() -> str | None:
    pkg = json.loads((UI / "package.json").read_text())
    dep = {**pkg.get("dependencies", {}), **pkg.get("devDependencies", {})}
    raw = dep.get("pdfjs-dist")
    return raw.lstrip("^~") if raw else None


def worker_version(path: Path) -> str | None:
    """pdf.js embeds its version as a bare string literal in the bundle."""
    blob = path.read_bytes()
    hits = sorted(set(re.findall(rb'"(\d+\.\d+\.\d{2,4})"', blob)))
    return hits[0].decode() if len(hits) == 1 else (hits[0].decode() if hits else None)


def main(mutant: str = "") -> int:
    r = Results()
    worker = UI / "public" / "pdf.worker.min.mjs"
    viewer = UI / "src" / "components" / "ui" / "PdfViewer.tsx"

    r.check("worker file is present", worker.is_file(), True)
    r.check("PdfViewer.tsx is present", viewer.is_file(), True)

    pinned = pinned_version()
    shipped = worker_version(worker) if worker.is_file() else None
    if mutant == "version_drift":
        # Sabotage: what a `pnpm up pdfjs-dist` does — bump the library and
        # leave the committed worker behind.
        pinned = "5.2.133"

    r.check("pdfjs-dist pinned in package.json", bool(pinned), True)
    r.check("shipped worker declares a version", bool(shipped), True)
    r.check("worker version == pinned library version", shipped, pinned)

    raw = viewer.read_text() if viewer.is_file() else ""
    # ★ Strip comments BEFORE scanning. The first version of this check reported
    # BAD against correct code, because the explanatory comment in PdfViewer.tsx
    # quotes the very string the check forbids. A source scan that can match its
    # own documentation measures the prose, not the program.
    src = "\n".join(
        ln for ln in raw.split("\n") if not ln.lstrip().startswith(("//", "*", "/*"))
    )
    if mutant == "bare_worker_path":
        # Sabotage: the original wiring — a fixed path a stale cache can satisfy.
        src = src.replace("`/pdf.worker.min.mjs?v=${pdfjsLib.version}`",
                          "'/pdf.worker.min.mjs'")

    keyed = bool(re.search(r"workerSrc\s*=\s*\n?\s*`/pdf\.worker\.min\.mjs\?v=\$\{[^}]*version\}`", src))
    r.check("workerSrc is keyed to the library version", keyed, True)
    r.check("no bare unversioned workerSrc remains",
            "'/pdf.worker.min.mjs'" in src, False)

    # ---- the version label in the rail --------------------------------------
    rail_p = UI / "src" / "components" / "shell" / "AppRail.tsx"
    rail_raw = rail_p.read_text() if rail_p.is_file() else ""
    rail = "\n".join(
        ln for ln in rail_raw.split("\n") if not ln.lstrip().startswith(("//", "*", "/*"))
    )
    if mutant == "hardcoded_version":
        # Sabotage: what shipped for five releases — a literal that never moved.
        rail = rail.replace("const APP_VERSION_FALLBACK = ''", "const APP_VERSION = 'v2'")
        rail = rail.replace(
            "Legal Scout{appVersion ? ` v${appVersion}` : ''}", "Legal Scout {APP_VERSION}"
        )
    r.check("rail reads the version from state, not a literal",
            "{appVersion" in rail, True)
    r.check("no hardcoded version literal in the rail",
            bool(re.search(r"APP_VERSION\s*=\s*'v?\d", rail)), False)
    r.check("rail fetches /api/version", "'/api/version'" in rail, True)

    # ---- the three places a release number is written -----------------------
    #
    # `/api/version` reads the root VERSION file; the rail renders what that
    # endpoint returns; the changelog panel renders CHANGELOG.md. Nothing tied
    # them together, so a release bumped CHANGELOG.md and package.json, shipped,
    # and the running app still reported the PREVIOUS version — the build had to
    # be discarded and re-cut. All three must name the same release.
    version_file = (ROOT / "VERSION").read_text().strip() if (ROOT / "VERSION").is_file() else ""
    pkg_p = UI / "package.json"
    pkg_version = ""
    if pkg_p.is_file():
        m = re.search(r'"version"\s*:\s*"([^"]+)"', pkg_p.read_text())
        pkg_version = m.group(1) if m else ""
    changelog_p = ROOT / "CHANGELOG.md"
    top_version = ""
    if changelog_p.is_file():
        m = re.search(r"^##\s*\[([^\]]+)\]", changelog_p.read_text(), re.M)
        top_version = m.group(1) if m else ""

    if mutant == "version_sources_drift":
        # Sabotage: exactly what shipped — CHANGELOG moved, VERSION did not.
        version_file = "0.0.0"

    r.check("VERSION file is set", bool(version_file), True)
    r.check("VERSION == agent-ui package.json", version_file == pkg_version, True)
    r.check("VERSION == newest CHANGELOG entry", version_file == top_version, True)

    # ---- changelog panel ----------------------------------------------------
    panel_p = UI / "src" / "components" / "shell" / "ChangelogPanel.tsx"
    panel = panel_p.read_text() if panel_p.is_file() else ""
    r.check("changelog panel exists", panel_p.is_file(), True)
    r.check("panel fetches /api/changelog", "'/api/changelog'" in panel, True)
    r.check("panel degrades to a message, not a crash",
            "Changelog unavailable" in panel, True)
    r.check("rail opens the panel", "ChangelogPanel" in rail_raw, True)

    # ---- worker self-heal ---------------------------------------------------
    viewer_raw = viewer.read_text() if viewer.is_file() else ""
    vsrc = "\n".join(
        ln for ln in viewer_raw.split("\n")
        if not ln.lstrip().startswith(("//", "*", "/*"))
    )
    if mutant == "no_self_heal":
        vsrc = vsrc.replace("cache: 'reload'", "").replace("createObjectURL", "")
    r.check("viewer refetches the worker bypassing the cache",
            "cache: 'reload'" in vsrc, True)
    r.check("viewer falls back to an uncacheable blob url",
            "createObjectURL" in vsrc, True)
    r.check("retry is bounded, not a loop",
            vsrc.count("does not match the Worker version") == 1, True)

    # ★ The real defect was never the cache: a browser EXTENSION injects
    # globalThis.pdfjsLib/pdfjsWorker at 5.2.133, and pdf.js reuses an existing
    # global WorkerMessageHandler instead of loading its own. Constructing the
    # Worker ourselves and passing it as workerPort bypasses that lookup, so no
    # page global can be picked up.
    if mutant == "no_worker_port":
        vsrc = vsrc.replace("workerPort", "workerSrcOnly")
    r.check("viewer owns its worker via workerPort", "workerPort" in vsrc, True)
    r.check("worker is constructed as a module worker",
            "{ type: 'module' }" in vsrc, True)
    r.check("worker is terminated on unmount", ".terminate()" in vsrc, True)

    main_py = (ROOT / "app" / "main.py").read_text()
    if mutant == "changelog_below_catchall":
        # Sabotage: move the endpoint below the frontend catch-all, where a GET
        # answers 200 with the frontend's HTML and never runs.
        block_at = main_py.index('@app.get("/api/changelog")')
        catch_at = main_py.index('@app.get("/{full_path:path}")')
        if block_at < catch_at:
            main_py = main_py[:block_at] + main_py[block_at:].replace(
                '@app.get("/api/changelog")', "@app.get_MOVED_BELOW", 1
            )
    changelog_line = next(
        (i for i, ln in enumerate(main_py.split("\n"))
         if ln.startswith('@app.get("/api/changelog")')), None
    )
    catchall_line = next(
        (i for i, ln in enumerate(main_py.split("\n"))
         if ln.strip().startswith('@app.get("/{full_path:path}")')), None
    )
    r.check("changelog route registered ABOVE the catch-all",
            changelog_line is not None
            and catchall_line is not None
            and changelog_line < catchall_line,
            True)
    if mutant == "no_cache_header":
        # Sabotage: revert to what shipped — no Cache-Control anywhere. Must
        # remove EVERY occurrence: the first version of this mutant replaced
        # only the literal `"Cache-Control": "no-cache"` pairs and left the
        # immutable branch intact, so the assertion still found the header and
        # the control read as inert.
        main_py = main_py.replace('"Cache-Control"', '"X-Nothing"')
        main_py = main_py.replace("max-age=31536000, immutable", "")
        main_py = main_py.replace('"no-cache"', '"0"')
    r.check("static serving sends Cache-Control", '"Cache-Control"' in main_py, True)
    # ★ This used to be `"max-age=31536000, immutable" in main_py` and it PASSED
    # while the header was never sent. `app.mount("/_next", StaticFiles(...))`
    # answers every /_next/* request before the catch-all is reached, so the
    # immutable branch in serve_frontend() was dead code for exactly the assets
    # it existed to serve. A text scan cannot see which code path RUNS — so
    # assert the thing that actually serves the bytes carries the header.
    if mutant == "plain_staticfiles":
        main_py = main_py.replace('_HashedStatic(directory=', "StaticFiles(directory=")
    mount_line = next(
        (ln for ln in main_py.split("\n") if 'app.mount("/_next"' in ln), ""
    )
    r.check("the /_next mount is the caching subclass",
            "_HashedStatic(" in mount_line, True)
    r.check("hashed assets marked immutable", "max-age=31536000, immutable" in main_py, True)
    # NOTE: offline, this can only prove the wiring. `curl -D-` against a live
    # container is the only thing that proves the header reaches the client —
    # which is how the original miss was found.
    r.check("unhashed assets revalidate", '"no-cache"' in main_py, True)

    print(f"\nSUMMARY: {r.total} checks · {r.failed} failed")
    return r.failed


MUTANTS = ["version_sources_drift", "version_drift", "bare_worker_path", "no_cache_header", "hardcoded_version", "changelog_below_catchall", "plain_staticfiles", "no_self_heal", "no_worker_port"]

if __name__ == "__main__":
    if "--controls" in sys.argv:
        base = main()
        print(f"\nbaseline failures: {base}\n")
        print(f"{'MUTANT':<24}{'BEFORE':>10}{'AFTER':>10}   VERDICT")
        inert = []
        for m in MUTANTS:
            print(f"\n--- {m} ---")
            after = main(m)
            moved = after > base
            if not moved:
                inert.append(m)
            print(f"{m:<24}{base:>10}{after:>10}   {'moved' if moved else 'INERT — measures nothing'}")
        if inert:
            print(f"\nFAIL: inert control(s): {', '.join(inert)}")
            sys.exit(1)
        print(f"\nPASS: {len(MUTANTS)}/{len(MUTANTS)} controls moved the number.")
        sys.exit(0)
    sys.exit(1 if main() else 0)
