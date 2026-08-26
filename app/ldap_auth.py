"""
Directory sign-in (LDAP / Active Directory)
===========================================

There is no "sign in with LDAP" button, and there should not be one: directory
sign-in uses the SAME two fields as a password sign-in, so a second button would
be a second way to submit one form. What the screen does do when a directory is
configured is accept a bare username as well as an email, and say so — an option
that is configured, working and unadvertised is indistinguishable from one that
is not there.

Two ways in, both through that one form:

  * an EMAIL that already has a Legal Scout account — the local password is
    tried first, and only if it fails are the same credentials offered to the
    directory. An address with no account here is never sent on.
  * a USERNAME (`sAMAccountName`), which cannot match a Legal Scout account on
    its own. The directory resolves it and returns the person's `mail`, which
    is then matched to an account. This is the one path that necessarily sends
    an unrecognised identifier to the directory.

What proves the password
------------------------

Only one step does: the **rebind**. The flow is

    1. bind as LDAP_BIND_DN (a read-only service account), or anonymously
    2. search LDAP_BASE_DN with LDAP_USER_FILTER   -> the person's DN
    3. rebind as THAT DN with the password they typed
    4. resolve the directory's mail attribute back to a Legal Scout account

Step 1 proves nothing about the person — it proves the service account's own
password. Step 2 proves only that an entry exists. A version of this that
stopped after step 2 would authenticate anybody whose name is in the directory,
with any password at all, which is why step 3 is written as its own function
call and not as a flag on the search.

What this module deliberately does NOT do
-----------------------------------------

**It never creates an account.** A person the directory knows and Legal Scout
does not is refused, with a message telling them to ask an administrator.
Just-in-time provisioning is a later, separately switchable phase; until then
the set of people who may sign in is exactly the set an administrator typed in,
and the directory only decides whether they are who they say they are.

**It never changes a role.** Roles live in Postgres and are set in the admin
panel. Nothing in an LDAP group can grant one — the practical consequence being
that whoever administers the corporate directory cannot make themselves a Legal
Scout administrator by editing a group membership.
"""

from __future__ import annotations

import contextlib
import logging

logger = logging.getLogger("legalscout.ldap")


class LdapError(Exception):
    """Directory sign-in did not succeed. The message is for the LOG.

    Callers must not relay it to the browser: it distinguishes "no such entry"
    from "wrong password" from "the directory is unreachable", and handing those
    apart to an unauthenticated caller is an account-enumeration oracle. The
    login endpoint answers every one of them with the same flat 401.
    """


def _settings():
    """The effective settings: environment default, database override on top.

    ★ This indirection is the whole point of the Authentication settings tab.
    Reading `os.getenv` directly here — as this module did in phase 2 — makes
    that page decorative: an administrator saves a corrected host, the row is
    written, the page shows the new value, and sign-in goes on using the one
    from `.env` with nothing to indicate the difference. Every setting below
    must come through here.

    Falls back to the environment alone if the settings table cannot be read,
    which is exactly the phase-2 behaviour and a safe place to land.
    """
    from app import auth_settings

    return auth_settings.effective()


def ldap_enabled() -> bool:
    return bool(_settings().ldap_enabled)


def config() -> dict:
    """Read the directory settings fresh, every time.

    Not cached: a container that booted before its environment was complete
    would otherwise hold the wrong values for its whole life, an override saved
    in the admin panel would not be seen by the other uvicorn worker, and the
    settings are read once per sign-in, which is not a hot path.
    """
    s = _settings()
    return {
        "host": str(s.ldap_host).strip(),
        "port": int(s.ldap_port or 636),
        "use_ssl": bool(s.ldap_use_ssl),
        "start_tls": bool(s.ldap_start_tls),
        "validate_cert": bool(s.ldap_validate_cert),
        "ca_cert_file": str(s.ldap_ca_cert_file).strip(),
        "bind_dn": str(s.ldap_bind_dn).strip(),
        "bind_password": str(s.ldap_bind_password),
        "base_dn": str(s.ldap_base_dn).strip(),
        # The sign-in form collects an EMAIL, because the form is not changing.
        # So the default filter matches the mail attribute, not
        # sAMAccountName — that one needs a bare username and would match
        # nothing against what this app actually sends.
        "user_filter": str(s.ldap_user_filter),
        "email_attr": str(s.ldap_email_attr).strip() or "mail",
        "name_attr": str(s.ldap_name_attr).strip() or "cn",
        "allow_insecure": bool(s.ldap_allow_insecure),
        "timeout": int(s.ldap_timeout or 8),
        "auto_create": bool(s.ldap_auto_create),
        # Cosmetic — the words the admin panel uses for this directory.
        "label": str(s.ldap_label).strip() or "Corporate directory",
    }


def _require_transport_security(cfg: dict) -> None:
    """Refuse to put a password on the wire in clear text.

    Step 3 of the flow rebinds as the user, so their password crosses the
    network on every single sign-in. Without SSL or StartTLS it crosses it
    readable by anyone on the path, and `LDAP_VALIDATE_CERT=false` means the
    server on the other end is whoever answered.

    This is a refusal rather than a warning on purpose. A warning about a
    plaintext directory bind is a line in a log that nobody reads until after
    the credentials have been collected, and the failure it prevents is silent
    by nature — nothing breaks, nothing looks wrong, the passwords are simply
    also going somewhere else. Setting LDAP_ALLOW_INSECURE=true is available for
    a lab, and says exactly what it is.
    """
    if cfg["allow_insecure"]:
        logger.warning(
            "[LDAP] LDAP_ALLOW_INSECURE is set: the user's password may cross the network "
            "unencrypted, and the directory's identity may be unverified."
        )
        return
    if not (cfg["use_ssl"] or cfg["start_tls"]):
        raise LdapError(
            "refusing to bind without TLS — set LDAP_USE_SSL=true (port 636) or "
            "LDAP_START_TLS=true (port 389). LDAP_ALLOW_INSECURE=true overrides this."
        )
    if not cfg["validate_cert"]:
        raise LdapError(
            "refusing to bind with certificate validation disabled — set "
            "LDAP_VALIDATE_CERT=true, and LDAP_CA_CERT_FILE for a private CA. "
            "LDAP_ALLOW_INSECURE=true overrides this."
        )


def _server(cfg: dict):
    import ssl as _ssl

    from ldap3 import Server, Tls

    tls = None
    if cfg["use_ssl"] or cfg["start_tls"]:
        tls = Tls(
            validate=_ssl.CERT_REQUIRED if cfg["validate_cert"] else _ssl.CERT_NONE,
            ca_certs_file=cfg["ca_cert_file"] or None,
        )
    return Server(
        cfg["host"],
        port=cfg["port"],
        use_ssl=cfg["use_ssl"],
        tls=tls,
        get_info=None,
        connect_timeout=cfg["timeout"],
    )


def _connect(server, user, password, cfg, *, authentication=None):
    from ldap3 import SIMPLE, Connection

    conn = Connection(
        server,
        user=user or None,
        password=password or None,
        authentication=authentication or SIMPLE,
        auto_bind=False,
        receive_timeout=cfg["timeout"],
        raise_exceptions=False,
    )
    if cfg["start_tls"] and not cfg["use_ssl"] and not conn.start_tls():
        raise LdapError(f"StartTLS refused by the directory: {conn.result}")
    if not conn.bind():
        raise LdapError(f"bind failed: {conn.result}")
    return conn


def check_filter(user_filter: str) -> str | None:
    """Return a complaint about the search filter, or None if it looks sane.

    ★ A filter with several clauses and no operator joining them — for example
    `((a={username})(b={username})(c={username}))` — is not valid LDAP. It does
    not match "any of these"; the directory rejects it, every sign-in fails as
    a wrong password, and nothing says why. The fix is a leading `|`:
    `(|(a={username})(b={username})(c={username}))`.

    This is a lint, not a parser: it catches the mistake people actually make
    when writing an OR by hand, and stays quiet otherwise.
    """
    f = (user_filter or "").strip()
    if not f:
        return "The search filter is empty."
    if not (f.startswith("(") and f.endswith(")")):
        return "The search filter must be wrapped in parentheses."
    if "{username}" not in f:
        return "The search filter must contain {username}, or it can never match the person signing in."
    inner = f[1:-1]
    # More than one top-level clause with no operator in front of them.
    if inner.startswith("(") and inner.count("(") > 1 and inner[:1] not in ("|", "&", "!"):
        return (
            "The filter lists several conditions with nothing joining them. "
            "For 'match any of these', it needs a leading | — for example "
            "(|(sAMAccountName={username})(mail={username}))."
        )
    return None


def test_connection() -> dict:
    """Check the directory settings WITHOUT anybody's password.

    Binds as the service account and runs one search, which is exactly what
    steps 1 and 2 of a real sign-in do — so a pass here means the half of the
    flow an administrator can control actually works. It deliberately cannot
    test step 3 (the rebind that proves a password), because that needs a real
    person's credentials and this is a settings page.
    """
    cfg = config()
    out = {
        "host": f"{cfg['host']}:{cfg['port']}",
        "tls": "LDAPS" if cfg["use_ssl"] else ("StartTLS" if cfg["start_tls"] else "none"),
    }
    if not cfg["host"] or not cfg["base_dn"]:
        return {**out, "success": False, "error": "Host and base DN are both required."}

    complaint = check_filter(cfg["user_filter"])
    if complaint:
        return {**out, "success": False, "error": complaint}

    try:
        _require_transport_security(cfg)
    except LdapError as e:
        return {**out, "success": False, "error": str(e)}

    try:
        from ldap3 import ANONYMOUS

        server = _server(cfg)
        if cfg["bind_dn"]:
            conn = _connect(server, cfg["bind_dn"], cfg["bind_password"], cfg)
        else:
            conn = _connect(server, None, None, cfg, authentication=ANONYMOUS)
    except Exception as e:
        return {**out, "success": False, "error": f"Could not bind as the service account: {type(e).__name__}: {e}"}

    try:
        # A wildcard search proves the base DN is readable by this account.
        probe = cfg["user_filter"].replace("{username}", "*")
        ok = conn.search(search_base=cfg["base_dn"], search_filter=probe,
                         attributes=[cfg["email_attr"], cfg["name_attr"]], size_limit=5)
        n = len(conn.entries) if ok else 0
        sample = ""
        if n:
            e0 = conn.entries[0]
            sample = str(getattr(e0, cfg["email_attr"], "") or "").strip()
        return {
            **out,
            "success": True,
            "entries_found": n,
            "sample_attribute": bool(sample),
            "message": (
                f"Bound as the service account and searched {cfg['base_dn']} — "
                f"{n} matching entr{'y' if n == 1 else 'ies'} visible"
                + ("" if sample else f". ⚠ the first entry has no {cfg['email_attr']} attribute, "
                   f"so people found this way cannot be matched to a Legal Scout account")
            ),
        }
    except Exception as e:
        return {**out, "success": False, "error": f"Bound, but the search failed: {type(e).__name__}: {e}"}
    finally:
        with contextlib.suppress(Exception):
            conn.unbind()


def authenticate(username: str, password: str) -> tuple[str, str]:
    """Prove `password` belongs to `username`. Returns (email, display name).

    Raises LdapError for every failure, with a reason meant for the log only.
    """
    cfg = config()
    if not cfg["host"] or not cfg["base_dn"]:
        raise LdapError("LDAP_HOST and LDAP_BASE_DN must both be set")

    # ★★★ An empty password is refused HERE, before any bind is attempted.
    #
    # A simple bind carrying a valid DN and a zero-length password is an
    # *unauthenticated* simple bind (RFC 4513 §5.1.2), and a directory
    # configured to permit it answers SUCCESS — some Active Directory
    # deployments do. On that server, knowing any provisioned email address
    # would be enough to sign in as that person. A default OpenLDAP refuses it
    # server-side and ldap3 refuses it client-side, but neither is a property of
    # YOUR directory, and neither is something this code can check.
    #
    # The login endpoint also enforces a minimum length, so this guard is
    # redundant today. It is here anyway because it must not depend on a caller
    # remembering: this is the function that decides whether a password is
    # right, and a password that is not there is not right.
    if not password:
        raise LdapError("empty password refused before bind (RFC 4513 §5.1.2)")
    if not username:
        raise LdapError("empty username")

    _require_transport_security(cfg)

    from ldap3.utils.conv import escape_filter_chars

    # `{username}` is substituted with what the person typed, escaped, so a
    # value like `*)(objectClass=*` cannot re-shape the filter into one that
    # matches every entry in the directory.
    search_filter = cfg["user_filter"].replace("{username}", escape_filter_chars(username))

    server = _server(cfg)

    # Step 1 — the service account. Anonymous if no bind DN is configured; the
    # account needs READ on the base DN and nothing else. It never writes.
    from ldap3 import ANONYMOUS

    if cfg["bind_dn"]:
        conn = _connect(server, cfg["bind_dn"], cfg["bind_password"], cfg)
    else:
        conn = _connect(server, None, None, cfg, authentication=ANONYMOUS)

    try:
        # Step 2 — find the entry. Existence only; this proves nothing about
        # the person's password.
        ok = conn.search(
            search_base=cfg["base_dn"],
            search_filter=search_filter,
            attributes=[cfg["email_attr"], cfg["name_attr"]],
            size_limit=2,
        )
        if not ok or not conn.entries:
            raise LdapError(f"no directory entry matched {search_filter}")
        if len(conn.entries) > 1:
            # Two entries mean the filter does not identify one person, so
            # there is no single password that could be checked. Guessing at
            # the first is how the wrong account gets authenticated.
            raise LdapError(f"filter matched {len(conn.entries)} entries; it must match exactly one")

        entry = conn.entries[0]
        user_dn = entry.entry_dn
        email = str(getattr(entry, cfg["email_attr"], "") or "").strip().lower()
        name = str(getattr(entry, cfg["name_attr"], "") or "").strip()
    finally:
        conn.unbind()

    if not email:
        raise LdapError(f"directory entry {user_dn} has no {cfg['email_attr']} attribute")

    # Step 3 — THE password check. Rebinding as the person's own DN with the
    # password they typed is the only step in this function that authenticates
    # anybody. Everything above it establishes who we are asking about.
    user_conn = _connect(server, user_dn, password, cfg)
    user_conn.unbind()

    return email, (name or email)
