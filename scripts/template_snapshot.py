#!/usr/bin/env python3
"""Before/after behaviour snapshot for legal document templates.

Why this exists
---------------
We are about to run LLM-driven "deep training" over the templates that
currently have no field_mapping. That training is non-deterministic: two runs
over the same template can produce different mappings, and a mapping that looks
richer is not automatically better. A template that today behaves acceptably
through the fallback heuristics can REGRESS once a learned mapping takes over --
the most dangerous shape of regression being a placeholder that used to be ASKED
of the user and is now silently AUTO-FILLED from a guess. Silent wrong values in
a legal document are far worse than one extra question.

So: capture the observable behaviour of every template BEFORE training, capture
it again AFTER, and diff. The change gets measured, not assumed.

Usage (inside the app container, where the product packages are importable):

    docker exec -i scout-api python - < scripts/template_snapshot.py snapshot /tmp/before.json
    ... run the deep training ...
    docker exec -i scout-api python - < scripts/template_snapshot.py snapshot /tmp/after.json
    docker exec -i scout-api python - < scripts/template_snapshot.py diff /tmp/before.json /tmp/after.json
"""

# MUST be the first product import. app.main and scout.agent import each other;
# importing app.main first primes the module so the cycle resolves. Without this
# line every subsequent import dies with an ImportError about a partially
# initialized module.
import app.main  # noqa: F401  (import for side effect: primes the circular import)

import glob
import json
import os
import sys

from scout.tools.smart_doc import prepare_document_data

TEMPLATE_GLOB = "/documents/legal/templates/*.docx"

DEFAULT_COMPANIES = "CITY HOLDINGS LIMITED,PAHTAMA GROUP COMPANY LIMITED"


def companies():
    """Companies to probe each template with.

    Two companies by default, because a mapping can be correct for the company
    whose data happens to be complete and wrong for one with gaps -- a
    single-company snapshot would hide exactly that class of regression.
    """
    raw = os.environ.get("SNAPSHOT_COMPANIES") or DEFAULT_COMPANIES
    return [c.strip() for c in raw.split(",") if c.strip()]


def template_names():
    return sorted(os.path.basename(p) for p in glob.glob(TEMPLATE_GLOB))


def probe(template_name, company_name):
    """Record what the pipeline does for one (template, company) pair.

    Any exception is captured as data rather than raised: one broken template
    must not cost us the snapshot of the other twelve, and "errored before,
    works now" (or the reverse) is itself a finding the diff should show.
    """
    try:
        result = prepare_document_data(template_name, company_name) or {}
    except Exception as exc:  # defensive on purpose -- see docstring
        return {"error": "%s: %s" % (type(exc).__name__, exc)}

    normalized = result.get("normalized_data") or {}
    validation = result.get("validation") or {}
    slot_requests = result.get("slot_requests") or []

    placeholders = []
    slots = []
    for req in slot_requests:
        if not isinstance(req, dict):
            continue
        name = req.get("placeholder")
        if not name:
            continue
        placeholders.append(name)
        slots.append({"placeholder": name, "kind": req.get("kind")})

    # The regression-critical axis: a placeholder is "auto-filled" when
    # normalized_data already carries a non-empty value for it, and "asked"
    # when it does not and the user will be prompted instead.
    auto_filled = sorted(
        p for p in set(placeholders) if _has_value(normalized.get(p))
    )
    asked = sorted(p for p in set(placeholders) if not _has_value(normalized.get(p)))

    return {
        "success": bool(result.get("success")),
        "available_fields": sorted(_as_names(validation.get("available_fields"))),
        "missing_fields": sorted(_as_names(validation.get("missing_fields"))),
        "placeholders": sorted(set(placeholders)),
        "auto_filled": auto_filled,
        "asked": asked,
        "slot_requests": sorted(slots, key=lambda s: (s["placeholder"], str(s["kind"]))),
    }


def _has_value(value):
    if value is None:
        return False
    if isinstance(value, str):
        return value.strip() != ""
    if isinstance(value, (list, dict, tuple, set)):
        return len(value) > 0
    return True


def _as_names(items):
    """Field lists are sometimes dicts, sometimes bare strings. Normalize."""
    out = []
    for item in items or []:
        if isinstance(item, dict):
            name = item.get("name") or item.get("field") or item.get("placeholder")
            if name:
                out.append(str(name))
        elif item is not None:
            out.append(str(item))
    return out


def cmd_snapshot(out_path):
    names = template_names()
    company_list = companies()
    data = {
        "template_glob": TEMPLATE_GLOB,
        "companies": company_list,
        "templates": {},
    }
    for name in names:
        per_company = {}
        for company in company_list:
            per_company[company] = probe(name, company)
        data["templates"][name] = per_company

    # sort_keys keeps the JSON byte-stable so a textual diff (and ours) shows
    # real behavioural change rather than dict-ordering noise.
    with open(out_path, "w") as fh:
        json.dump(data, fh, indent=2, sort_keys=True)
        fh.write("\n")

    print("snapshot: %d templates x %d companies -> %s"
          % (len(names), len(company_list), out_path))
    return 0


def _load(path):
    with open(path) as fh:
        return json.load(fh)


def cmd_diff(before_path, after_path):
    before = _load(before_path)
    after = _load(after_path)

    b_templates = before.get("templates") or {}
    a_templates = after.get("templates") or {}

    changed = 0
    improvements = 0
    regressions = 0

    for name in sorted(set(b_templates) | set(a_templates)):
        b_all = b_templates.get(name)
        a_all = a_templates.get(name)
        lines = []

        if b_all is None:
            lines.append("  template is NEW in after")
            b_all = {}
        if a_all is None:
            lines.append("  template MISSING in after")
            a_all = {}

        for company in sorted(set(b_all) | set(a_all)):
            b = b_all.get(company) or {}
            a = a_all.get(company) or {}
            b_err = b.get("error")
            a_err = a.get("error")

            if b_err and not a_err:
                lines.append("  [%s] errored BEFORE, works now: %s" % (company, b_err))
                improvements += 1
                continue
            if a_err and not b_err:
                lines.append("  [%s] REGRESSION RISK: errors now, worked before: %s"
                             % (company, a_err))
                regressions += 1
                continue
            if a_err and b_err:
                if a_err != b_err:
                    lines.append("  [%s] error changed: %s -> %s" % (company, b_err, a_err))
                continue

            b_asked = set(b.get("asked") or [])
            a_asked = set(a.get("asked") or [])
            b_auto = set(b.get("auto_filled") or [])
            a_auto = set(a.get("auto_filled") or [])

            # The headline risk: the user used to be asked, now the value is
            # produced by a learned mapping we have not verified.
            now_guessed = sorted(b_asked & a_auto)
            now_offered = sorted(b_auto & a_asked)

            for ph in now_guessed:
                lines.append("  [%s] REGRESSION RISK: now guessed, previously asked -- %s"
                             % (company, ph))
            regressions += len(now_guessed)

            for ph in now_offered:
                lines.append("  [%s] improved: now offered, previously guessed -- %s"
                             % (company, ph))
            improvements += len(now_offered)

            b_ph = set(b.get("placeholders") or [])
            a_ph = set(a.get("placeholders") or [])
            added = sorted(a_ph - b_ph)
            removed = sorted(b_ph - a_ph)
            if added:
                lines.append("  [%s] slot requests added (%d): %s"
                             % (company, len(added), ", ".join(added)))
            if removed:
                lines.append("  [%s] slot requests removed (%d): %s"
                             % (company, len(removed), ", ".join(removed)))

            for label, key in (("available_fields", "available_fields"),
                               ("missing_fields", "missing_fields")):
                b_set = set(b.get(key) or [])
                a_set = set(a.get(key) or [])
                gained = sorted(a_set - b_set)
                lost = sorted(b_set - a_set)
                if gained:
                    lines.append("  [%s] %s +%d: %s"
                                 % (company, label, len(gained), ", ".join(gained)))
                if lost:
                    lines.append("  [%s] %s -%d: %s"
                                 % (company, label, len(lost), ", ".join(lost)))

            if bool(b.get("success")) != bool(a.get("success")):
                lines.append("  [%s] success %s -> %s"
                             % (company, b.get("success"), a.get("success")))

        if lines:
            changed += 1
            print("=== %s" % name)
            for line in lines:
                print(line)
            print("")

    total = len(set(b_templates) | set(a_templates))
    print("--- summary ---")
    print("templates compared : %d" % total)
    print("templates changed  : %d" % changed)
    print("improvements       : %d" % improvements)
    print("regression risks   : %d" % regressions)
    if regressions:
        print("")
        print("Review every REGRESSION RISK line by hand. A placeholder that moved")
        print("from asked to guessed means a learned mapping is now filling a value")
        print("nobody confirmed -- verify it against the template before shipping.")
    return 0


def main(argv):
    if len(argv) < 2:
        print(__doc__)
        print("usage: template_snapshot.py snapshot <out.json>")
        print("       template_snapshot.py diff <before.json> <after.json>")
        return 0

    cmd = argv[1]
    try:
        if cmd == "snapshot" and len(argv) == 3:
            return cmd_snapshot(argv[2])
        if cmd == "diff" and len(argv) == 4:
            return cmd_diff(argv[2], argv[3])
    except Exception as exc:
        # Exit 0 always: this is a measurement aid, never a gate that can wedge
        # the training run it is meant to observe.
        print("template_snapshot failed: %s: %s" % (type(exc).__name__, exc))
        return 0

    print("usage: template_snapshot.py snapshot <out.json>")
    print("       template_snapshot.py diff <before.json> <after.json>")
    return 0


if __name__ == "__main__":
    main(sys.argv)
    sys.exit(0)
