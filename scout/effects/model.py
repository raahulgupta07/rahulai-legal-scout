"""
The Effect record, and the before/after image rules.
===================================================

THE BEFORE-IMAGE DECISION
-------------------------
Before-images ARE stored. An effect row reading "person 42 updated" can be
displayed but never reversed, and reversibility is the whole reason this table
exists rather than a prettier view over ``activity_logs``. But a naive
"snapshot the row" would be unbounded: ``companies`` carries JSONB directors
and members, ``documents`` carries ``custom_data``. Three rules bound it:

  1. FIELD-SCOPED. For an update, only the keys whose value actually changed
     appear in before/after. A 40-column row where the sync filled one blank
     stores one key, not forty. ``diff_images`` computes this.
  2. INSERTS COST NOTHING. before is NULL; undo is "delete the row we created".
     Document generation — by volume the dominant effect — is an insert, so the
     common case adds no bulk at all.
  3. CAPPED, AND THE CAP FLIPS REVERSIBILITY. Over ``MAX_IMAGE_BYTES`` the
     image is replaced by a marker and ``reversible`` becomes False. A
     truncated image that still advertised itself as reversible would drive a
     WRONG undo — restoring a partial row over a complete one. Silently losing
     the ability to undo is recoverable; silently corrupting the record it was
     meant to protect is not.

Deletes are the exception to rule 1: the full row is stored, because no subset
of it is enough to re-insert. Deletes are rare and the cost is accepted.

Nothing in this module touches the database.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Any, Dict, Mapping, Optional, Tuple

# 64 KB of serialized JSON per image. Chosen against the real shapes: a
# people row diff is a few hundred bytes; a whole companies row with a long
# directors array is the case that blows past it, and that is exactly the case
# where a "reversal" from a truncated image would be silently wrong.
MAX_IMAGE_BYTES = 64 * 1024

OPS = ("insert", "update", "delete", "external")

_TRUNCATED_KEY = "_truncated"


class EffectError(ValueError):
    """Raised for a malformed effect. Never escapes ``recorder.record``."""


@dataclass
class Effect:
    """One side effect of one turn."""

    kind: str
    op: str
    turn_id: str = ""
    seq: int = 0
    session_id: Optional[str] = None
    actor_email: Optional[str] = None
    tool_name: Optional[str] = None
    target_table: Optional[str] = None
    target_id: Optional[str] = None
    target_label: Optional[str] = None
    before_image: Optional[Dict[str, Any]] = None
    after_image: Optional[Dict[str, Any]] = None
    reversible: bool = False
    irreversible_reason: Optional[str] = None
    meta: Dict[str, Any] = field(default_factory=dict)

    def as_row(self) -> Dict[str, Any]:
        """The column mapping the sink writes. JSONB values stay as dicts."""
        return {
            "turn_id": self.turn_id,
            "seq": self.seq,
            "session_id": self.session_id,
            "actor_email": self.actor_email,
            "tool_name": self.tool_name,
            "kind": self.kind,
            "op": self.op,
            "target_table": self.target_table,
            "target_id": self.target_id,
            "target_label": self.target_label,
            "before_image": self.before_image,
            "after_image": self.after_image,
            "reversible": self.reversible,
            "irreversible_reason": self.irreversible_reason,
        }


def _json_bytes(value: Any) -> int:
    return len(json.dumps(value, default=str).encode("utf-8"))


def _truncation_marker(value: Mapping[str, Any], size: int) -> Dict[str, Any]:
    """Stand-in for an image too large to keep.

    Keeps the key names — which are what an auditor reads to know WHAT changed —
    and drops only the values, which are what made it large.
    """
    return {
        _TRUNCATED_KEY: True,
        "_bytes": size,
        "_limit": MAX_IMAGE_BYTES,
        "_keys": sorted(str(k) for k in value.keys()),
    }


def is_truncated(image: Optional[Mapping[str, Any]]) -> bool:
    return bool(image) and bool(image.get(_TRUNCATED_KEY))


def cap_image(
    value: Optional[Mapping[str, Any]],
) -> Tuple[Optional[Dict[str, Any]], bool]:
    """Return (image, was_truncated). None passes through untouched."""
    if value is None:
        return None, False
    if not isinstance(value, Mapping):
        raise EffectError("image must be a mapping, got {}".format(type(value).__name__))
    try:
        size = _json_bytes(value)
    except Exception as exc:  # not JSON-serialisable even with default=str
        raise EffectError("image is not serialisable: {}".format(exc))
    if size <= MAX_IMAGE_BYTES:
        return dict(value), False
    return _truncation_marker(value, size), True


def diff_images(
    before: Optional[Mapping[str, Any]],
    after: Optional[Mapping[str, Any]],
) -> Tuple[Optional[Dict[str, Any]], Optional[Dict[str, Any]]]:
    """Reduce a pair of row snapshots to only the keys that actually changed.

    A key present in one side and absent from the other counts as changed, and
    is emitted on both sides — with the missing side carrying an explicit None
    rather than being omitted. Omitting it would make "the column was NULL" and
    "the column was not part of this write" indistinguishable at read time, and
    an undo cannot tell those apart safely.
    """
    if before is None and after is None:
        return None, None
    b = dict(before or {})
    a = dict(after or {})

    changed = [k for k in set(b) | set(a) if b.get(k) != a.get(k)]
    if not changed:
        # A write that changed nothing is still an effect worth recording (the
        # agent tried), but it has no image. Empty dicts, not None: None means
        # "no side existed", {} means "this side existed and nothing moved".
        return ({} if before is not None else None, {} if after is not None else None)

    b_out = {k: b.get(k) for k in changed} if before is not None else None
    a_out = {k: a.get(k) for k in changed} if after is not None else None
    return b_out, a_out


def decide_reversibility(
    op: str,
    target_table: Optional[str],
    target_id: Optional[str],
    before_image: Optional[Mapping[str, Any]],
    truncated: bool,
) -> Tuple[bool, Optional[str]]:
    """Whether this effect carries enough to be undone, and why not if not.

    Deliberately conservative: every path that is not provably reversible
    returns False with a reason. The default in the schema is False for the
    same reason — an effect nothing has proven reversible must not read as
    reversible.
    """
    if truncated:
        return False, "before/after image exceeded {} bytes and was truncated".format(
            MAX_IMAGE_BYTES
        )
    if op == "external":
        return False, "effect is outside this database"
    if not target_table or target_id is None or target_id == "":
        return False, "no target row identified"
    if op == "insert":
        # Undo is DELETE FROM target_table WHERE id = target_id. No before
        # image is needed and none is expected.
        return True, None
    if op in ("update", "delete"):
        if not before_image:
            return False, "no before image captured"
        return True, None
    return False, "unknown op {!r}".format(op)


def build_effect(
    kind: str,
    op: str,
    turn_id: str,
    seq: int,
    session_id: Optional[str] = None,
    actor_email: Optional[str] = None,
    tool_name: Optional[str] = None,
    target_table: Optional[str] = None,
    target_id: Optional[Any] = None,
    target_label: Optional[str] = None,
    before: Optional[Mapping[str, Any]] = None,
    after: Optional[Mapping[str, Any]] = None,
    diff: bool = True,
    meta: Optional[Dict[str, Any]] = None,
) -> Effect:
    """Validate, diff, cap, and decide reversibility. Raises EffectError.

    ``diff=False`` keeps both images whole — used for deletes, where the full
    row is the only correct before image.
    """
    if not kind or not isinstance(kind, str):
        raise EffectError("kind is required")
    if op not in OPS:
        raise EffectError("op must be one of {}, got {!r}".format(OPS, op))

    if op == "delete":
        diff = False

    if diff:
        b, a = diff_images(before, after)
    else:
        b = dict(before) if before is not None else None
        a = dict(after) if after is not None else None

    b, b_trunc = cap_image(b)
    a, a_trunc = cap_image(a)
    truncated = b_trunc or a_trunc

    tid = None if target_id is None else str(target_id)
    reversible, reason = decide_reversibility(op, target_table, tid, b, truncated)

    return Effect(
        kind=kind,
        op=op,
        turn_id=turn_id,
        seq=seq,
        session_id=session_id,
        actor_email=actor_email,
        tool_name=tool_name,
        target_table=target_table,
        target_id=tid,
        target_label=target_label,
        before_image=b,
        after_image=a,
        reversible=reversible,
        irreversible_reason=reason,
        meta=meta or {},
    )
