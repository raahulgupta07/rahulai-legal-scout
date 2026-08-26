"""
Sign-in settings: environment default, overlaid by a database override.
=======================================================================

Phases 2 and 3 read their configuration straight from the environment, which
means changing a mistyped realm URL costs an `.env` edit, a `docker compose up`
and a restart — on the one instance, with everybody signed out. This module is
the layer that makes those settings editable from the admin panel instead.

The rule is one line: **the environment is the default; a row in `app_settings`
overrides it.** Nothing is cached in this process. That is not an oversight —
there are two uvicorn workers and no shared store, so a value cached at import
in one worker is stale in the other the moment somebody saves, and the setting
would appear to take effect or not depending on which worker answered. Sign-in
is not a hot path; it can afford one indexed lookup.

Two things this module refuses to do
------------------------------------

**It never returns a secret.** `oidc_client_secret` and `ldap_bind_password` can
be written and cannot be read back — the API reports whether each is set, never
what it is. A settings page that renders the current value of a secret puts it
in the DOM, in the browser's memory, and in any screenshot of that page.

**It validates an enum before writing, not after reading.** Storing
`signin_mode = "sso-only"` (a hyphen) would read back as an unrecognised value
and fall through to the default, so a deployment meant to be SSO-only would
quietly keep accepting passwords, with the admin panel showing the setting they
asked for.
"""

from __future__ import annotations

import logging
import os
from types import SimpleNamespace

from db.connection import get_db_conn

logger = logging.getLogger("legalscout.auth_settings")

SIGNIN_MODES = ("local", "hybrid", "sso_only")
OIDC_PROVIDER_TYPES = ("keycloak", "entra", "google", "generic")

# name -> (env var, kind, default). `kind` is "bool" | "int" | "str" | "secret".
#
# A "secret" behaves exactly like a "str" everywhere except that it is stripped
# from anything this module hands back to a caller.
SPEC: dict[str, tuple[str, str, object]] = {
    "signin_mode": ("SIGNIN_MODE", "str", "hybrid"),
    # --- directory ---
    "ldap_enabled": ("LDAP_ENABLED", "bool", False),
    "ldap_host": ("LDAP_HOST", "str", ""),
    "ldap_port": ("LDAP_PORT", "int", 636),
    "ldap_use_ssl": ("LDAP_USE_SSL", "bool", True),
    "ldap_start_tls": ("LDAP_START_TLS", "bool", False),
    "ldap_validate_cert": ("LDAP_VALIDATE_CERT", "bool", True),
    "ldap_ca_cert_file": ("LDAP_CA_CERT_FILE", "str", ""),
    "ldap_bind_dn": ("LDAP_BIND_DN", "str", ""),
    "ldap_bind_password": ("LDAP_BIND_PASSWORD", "secret", ""),
    "ldap_base_dn": ("LDAP_BASE_DN", "str", ""),
    "ldap_user_filter": ("LDAP_USER_FILTER", "str", "(mail={username})"),
    "ldap_email_attr": ("LDAP_EMAIL_ATTR", "str", "mail"),
    "ldap_name_attr": ("LDAP_NAME_ATTR", "str", "cn"),
    "ldap_label": ("LDAP_LABEL", "str", "Corporate directory"),
    "ldap_timeout": ("LDAP_TIMEOUT", "int", 8),
    "ldap_allow_insecure": ("LDAP_ALLOW_INSECURE", "bool", False),
    "ldap_auto_create": ("LDAP_AUTO_CREATE", "bool", False),
    # --- single sign-on ---
    "oidc_enabled": ("OIDC_ENABLED", "bool", False),
    "oidc_discovery_url": ("OIDC_DISCOVERY_URL", "str", ""),
    "oidc_client_id": ("OIDC_CLIENT_ID", "str", ""),
    "oidc_client_secret": ("OIDC_CLIENT_SECRET", "secret", ""),
    "oidc_redirect_uri": ("OIDC_REDIRECT_URI", "str", ""),
    "oidc_scopes": ("OIDC_SCOPES", "str", "openid email profile"),
    "oidc_label": ("OIDC_LABEL", "str", "single sign-on"),
    "oidc_provider_type": ("OIDC_PROVIDER_TYPE", "str", "keycloak"),
    "oidc_require_verified_email": ("OIDC_REQUIRE_VERIFIED_EMAIL", "bool", True),
    "oidc_timeout": ("OIDC_TIMEOUT", "int", 10),
    "oidc_auto_create": ("OIDC_AUTO_CREATE", "bool", False),
}

ENUMS: dict[str, tuple[str, ...]] = {
    "signin_mode": SIGNIN_MODES,
    "oidc_provider_type": OIDC_PROVIDER_TYPES,
}

SECRET_KEYS = frozenset(k for k, (_e, kind, _d) in SPEC.items() if kind == "secret")

# Written to app_settings under this prefix so these rows cannot collide with
# the model / SMTP / S3 settings already living in the same table.
PREFIX = "auth."


class SettingsError(Exception):
    """A rejected write. Safe to show an administrator; they made the request."""


def _coerce(raw: str, kind: str, default):
    if kind == "bool":
        return str(raw).strip().lower() in ("1", "true", "yes", "on")
    if kind == "int":
        try:
            return int(str(raw).strip())
        except (TypeError, ValueError):
            return default
    return str(raw)


def _from_env(name: str):
    env_var, kind, default = SPEC[name]
    raw = os.getenv(env_var)
    if raw is None or raw == "":
        return default
    return _coerce(raw, kind, default)


def _overrides() -> dict[str, str]:
    """Every stored override, as raw strings. Empty dict if the table cannot
    be read — the environment then stands on its own, which is the state the
    product shipped in for phases 2 and 3 and is a safe place to fall back to.
    """
    try:
        conn = get_db_conn()
        cur = conn.cursor()
        cur.execute("SELECT key, value FROM app_settings WHERE key LIKE %s", (PREFIX + "%",))
        rows = cur.fetchall()
        cur.close()
        conn.close()
    except Exception as e:
        logger.warning(f"[AUTH-SETTINGS] could not read overrides, using the environment: {e}")
        return {}
    return {k[len(PREFIX) :]: v for k, v in rows if k.startswith(PREFIX)}


def effective() -> SimpleNamespace:
    """The settings actually in force. Read fresh; never cached in-process."""
    ov = _overrides()
    out = {}
    for name, (_env, kind, default) in SPEC.items():
        if name in ov and ov[name] != "":
            out[name] = _coerce(ov[name], kind, default)
        else:
            out[name] = _from_env(name)
    # A value that is not one of the permitted ones falls back to the default
    # rather than being passed on. Writes are validated (see `update`), so this
    # only catches a row edited directly in SQL.
    for name, allowed in ENUMS.items():
        if out.get(name) not in allowed:
            out[name] = SPEC[name][2]
    return SimpleNamespace(**out)


def public_view() -> dict:
    """What an administrator may READ. Secrets are reported as set / not set.

    ★ Never returns a secret's value. A settings page that renders one puts it
    in the page's DOM, in the browser's memory, and in any screenshot taken of
    that page — for a value whose whole purpose is not to be seen.
    """
    cfg = effective()
    out = {}
    for name in SPEC:
        if name in SECRET_KEYS:
            out[name + "_set"] = bool(getattr(cfg, name, ""))
        else:
            out[name] = getattr(cfg, name)
    # Which fields came from a stored override rather than the environment —
    # so the page can say what it is actually editing.
    out["_overridden"] = sorted(_overrides().keys())
    return out


def update(updates: dict, actor: str) -> None:
    """Write overrides. Validates EVERYTHING before writing ANYTHING.

    ★ The validation pass is separate and complete, not per-key as it goes. A
    partial write leaves the settings half-applied — half from the form and
    half from before it — which is a state nobody chose and nobody can see.
    """
    if not isinstance(updates, dict) or not updates:
        raise SettingsError("No settings supplied")

    clean: dict[str, str] = {}
    for name, value in updates.items():
        if name not in SPEC:
            raise SettingsError(f"Unknown setting {name!r}")
        _env, kind, _default = SPEC[name]

        if name in ENUMS:
            # ★ Validated BEFORE the write. `signin_mode = "sso-only"` with a
            # hyphen would store fine and read back as unrecognised, falling
            # through to the default — so a deployment meant to be SSO-only
            # would go on accepting passwords while the settings page showed
            # exactly what the administrator asked for.
            if str(value) not in ENUMS[name]:
                raise SettingsError(f"{name} must be one of {', '.join(ENUMS[name])} — got {value!r}")
            clean[name] = str(value)
        elif kind == "bool":
            clean[name] = "true" if (value is True or str(value).strip().lower() in ("1", "true", "yes", "on")) else "false"
        elif kind == "int":
            try:
                clean[name] = str(int(value))
            except (TypeError, ValueError):
                raise SettingsError(f"{name} must be a whole number — got {value!r}") from None
        else:
            # A secret sent as an empty string means "leave it alone", not
            # "clear it". A settings form cannot show the current value, so it
            # posts blank on every save; treating that as a clear would wipe
            # the client secret the first time anybody edited an unrelated
            # field on the same page.
            if name in SECRET_KEYS and str(value) == "":
                continue
            clean[name] = str(value)

    if not clean:
        return

    conn = get_db_conn()
    try:
        cur = conn.cursor()
        for name, value in clean.items():
            cur.execute(
                "INSERT INTO app_settings (key, value, updated_by) VALUES (%s, %s, %s) "
                "ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, "
                "updated_by = EXCLUDED.updated_by, updated_at = NOW()",
                (PREFIX + name, value, actor),
            )
        conn.commit()
        cur.close()
    finally:
        conn.close()


def clear(name: str) -> None:
    """Drop one override, so the environment's value applies again."""
    if name not in SPEC:
        raise SettingsError(f"Unknown setting {name!r}")
    conn = get_db_conn()
    try:
        cur = conn.cursor()
        cur.execute("DELETE FROM app_settings WHERE key = %s", (PREFIX + name,))
        conn.commit()
        cur.close()
    finally:
        conn.close()
