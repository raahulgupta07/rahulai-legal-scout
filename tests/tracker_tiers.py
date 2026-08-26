"""
Tier 0-1 — the turns that produce NO document.

tracker_layer3 only scores a run that ends in a downloadable .docx, so the
cheapest and most common turns in the product are unmeasured: a plain question,
and a register lookup. Those are exactly where the "silent stop" lives — a turn
that streams reasoning and zero content, which for months looked like a stalled
agent and is really an empty `content` alongside a full `reasoning_content`.

Each case here asserts three things a document test cannot:

  * the turn produced VISIBLE text, not just reasoning;
  * facts that are in the register are actually in the answer;
  * nothing invented — a name that is NOT in the register must not appear.

The last one matters most. A fluent answer listing plausible Myanmar names is
indistinguishable from a correct one unless something checks the register.

Run (needs the app up and ADMIN_PASSWORD set):

    ADMIN_PASSWORD=... python3 tests/tracker_tiers.py
    ADMIN_PASSWORD=... python3 tests/tracker_tiers.py T2      # one tier
"""

import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from tracker_layer3 import login, start

# `expect_any` is satisfied by ONE of its entries — phrasing varies run to run
# and pinning a single spelling fails the case for a reason unrelated to the
# product. `forbid` is absolute.
CASES = [
    {
        "id": "T1",
        "why": "a plain question — no tool, no document. The bare silent-stop path.",
        "prompt": "What is this system for? Answer in two sentences.",
        "expect_any": [["legal", "document", "myanmar", "compan"]],
        "forbid": [],
        "min_chars": 40,
    },
    {
        "id": "T2",
        "why": "a register lookup. Every company must be real.",
        "prompt": "List every company you have on file. Names only.",
        "expect_all": ["CITY HOLDINGS", "CITY MART", "CM FOODS", "COMMERCE ACE", "PAHTAMA"],
        # Names that do not exist in this register. A model that pads a list
        # rather than admitting a short one reaches for exactly this shape.
        "forbid": ["ARCTIC SUN", "GOLDEN LOTUS", "EMERALD"],
        "min_chars": 30,
    },
    {
        "id": "T3",
        "why": "one company's board, read from the register.",
        "prompt": "Who are the directors of City Holdings Limited?",
        "expect_all": ["MIN MIN", "PHYOE MIN KYAW", "SOE MOE THU", "WIN WIN TINT"],
        # A CITY MART director who is NOT on CITY HOLDINGS' board. His presence
        # means the wrong company's register was read.
        "forbid": ["KYAW THU SOE"],
        "min_chars": 30,
    },
    {
        "id": "T4",
        "why": "the corporate-member relationship, stated in prose before any document.",
        "prompt": ("Who are the members of City Mart Holding Company Limited, and is any of them a company?"),
        "expect_all": ["CITY HOLDINGS"],
        "expect_any": [["compan", "corporate", "body corporate"]],
        "forbid": [],
        "min_chars": 30,
    },
]


def run_case(token, user_id, case):
    session = f"TIER {case['id']} — {int(time.time())}"
    print(f"\n{'=' * 76}\n[{case['id']}] {case['prompt']}\n  {case['why']}\n  session: {session}", flush=True)

    result = start(token, case["prompt"], session, user_id)
    content = result.get("content") or ""
    reasoning = result.get("reasoning") or ""
    low = content.lower()

    problems = []

    # A turn that thought and said nothing is the defect this tier exists for,
    # and it is NOT the same failure as a turn that produced nothing at all.
    if len(content) < case.get("min_chars", 1):
        if reasoning:
            problems.append(f"SILENT STOP — {len(content)} chars of content beside {len(reasoning)} chars of reasoning")
        else:
            problems.append(f"no output at all ({len(content)} chars, no reasoning)")

    for needle in case.get("expect_all", []):
        if needle.lower() not in low:
            problems.append(f"missing {needle!r}")

    for group in case.get("expect_any", []):
        if not any(alt.lower() in low for alt in group):
            problems.append(f"none of {group} present")

    for needle in case.get("forbid", []):
        if needle.lower() in low:
            problems.append(f"INVENTED or WRONG-REGISTER: {needle!r} is not a valid answer here")

    if result.get("error"):
        problems.append(f"stream error: {result['error']}")

    status = "PASS" if not problems else "FAIL"
    detail = "; ".join(problems) if problems else f"{len(content)} chars"
    print(f"  tools: {result.get('tools') or '(none)'}")
    print(f"  reply: {content[:160]!r}")
    print(f"  -> {status}: {detail}", flush=True)
    return {"status": status, "detail": detail, "session": session}


def main():
    wanted = {a.upper() for a in sys.argv[1:]}
    cases = [c for c in CASES if not wanted or c["id"].upper() in wanted]
    if not cases:
        sys.exit(f"No case matched {sorted(wanted)}; have {[c['id'] for c in CASES]}")

    token, user_id = login()
    rows = []
    for case in cases:
        try:
            rows.append((case["id"], run_case(token, user_id, case)))
        except Exception as e:
            print(f"  -> ERROR: {type(e).__name__}: {e}", flush=True)
            rows.append((case["id"], {"status": "ERROR", "detail": str(e)[:120], "session": "-"}))

    print(f"\n\n{'ID':<5} {'RESULT':<8} SESSION (open this in the app)")
    print("-" * 96)
    for cid, out in rows:
        print(f"{cid:<5} {out['status']:<8} {out['session']}")
        if out["status"] != "PASS":
            print(f"      {out['detail']}")
    failed = sum(1 for _, o in rows if o["status"] != "PASS")
    print(f"\nSUMMARY: PASS={len(rows) - failed}" + (f" · FAIL={failed}" if failed else ""))
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
