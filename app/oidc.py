"""
Single sign-on (OpenID Connect — Keycloak, Entra, Google, any compliant IdP)
===========================================================================

The provider proves WHO somebody is. The `users` table still decides what they
may do, and an administrator still has to have created their account. Nothing
in a token — no claim, no group, no role mapper — grants access here.

The flow, and what each step is actually for
--------------------------------------------

    GET /api/auth/sso/login
        mint state + nonce + PKCE verifier, put them in ONE signed HttpOnly
        cookie, redirect to the provider's authorize endpoint

    GET /api/auth/sso/callback?code=...&state=...
        1. state parameter must equal the state in the cookie   (CSRF)
        2. exchange the code, sending the PKCE verifier         (code interception)
        3. verify the id_token against the provider's JWKS      (forgery)
        4. nonce in the id_token must equal the one in the cookie (replay)
        5. resolve the email claim to a users row               (authorisation)
        6. hand the app's own JWT back in the URL FRAGMENT

Step 3 is the one that decides whether a token is real, and it is written
defensively for three reasons that have each caused a real vulnerability
somewhere:

* **The algorithm is pinned to the asymmetric ones.** Accepting whatever the
  token's header names allows the classic confusion attack: an attacker signs a
  token with HS256 using the provider's PUBLIC key as the HMAC secret, and a
  verifier that trusts the header validates it happily. The public key is, by
  definition, public.

* **There is no "use the first key in the JWKS" fallback.** On a key rotation
  the first key is the NEW one while the token in hand was signed by the old,
  so such a fallback turns a clear "unknown key id" into a confusing signature
  error — and, worse, encourages accepting a token that was verified against a
  key it was not signed with. An unknown `kid` refetches the JWKS exactly once.

* **The audience check accepts `aud` OR `azp`.** Keycloak puts `aud: "account"`
  in its id_tokens and names the client in `azp`, so a plain audience check
  rejects every real login against a default Keycloak realm. Accepting either
  is what the spec allows; accepting neither would be a product that does not
  work, and skipping the check entirely would accept a token minted for a
  different application on the same realm.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import logging
import os
import secrets
import time
from typing import Any

import httpx
import jwt

logger = logging.getLogger("legalscout.oidc")

# How long an in-flight sign-in may take between the redirect out and the
# callback coming back. Long enough for a password manager, a second factor and
# a consent screen; short enough that a state cookie left on a shared machine
# is not usable tomorrow.
SSO_FLOW_TTL = 600

_metadata_cache: dict[str, tuple[float, dict]] = {}
_jwks_cache: dict[str, tuple[float, dict]] = {}
METADATA_TTL = 3600.0
JWKS_TTL = 3600.0


class OidcError(Exception):
    """Sign-in did not succeed. The message is for the LOG, never the browser.

    It distinguishes a bad signature from an unknown account from a provider
    that is down, and handing those apart to an unauthenticated caller says
    which addresses have accounts here.
    """


def _settings():
    """Effective settings: environment default, database override on top.

    Reading `os.getenv` directly here would make the Authentication settings
    tab decorative — a saved correction would be stored, displayed, and then
    ignored by the code that actually signs people in. See ldap_auth._settings.
    """
    from app import auth_settings

    return auth_settings.effective()


def sso_enabled() -> bool:
    return bool(_settings().oidc_enabled)


def config() -> dict:
    """Read the provider settings fresh. Same reasoning as ldap_auth.config."""
    s = _settings()
    return {
        "discovery_url": str(s.oidc_discovery_url).strip(),
        "client_id": str(s.oidc_client_id).strip(),
        "client_secret": str(s.oidc_client_secret),
        "redirect_uri": str(s.oidc_redirect_uri).strip(),
        "scopes": str(s.oidc_scopes).strip(),
        "label": str(s.oidc_label).strip() or "single sign-on",
        # Cosmetic only — which logo and default label the sign-in screen shows.
        "provider_type": str(s.oidc_provider_type).strip().lower() or "keycloak",
        # Some providers omit email_verified entirely. Requiring it is right for
        # a provider that sends it and would lock out one that does not, so the
        # rule is: if the claim is PRESENT it must be true.
        "require_verified_email": bool(s.oidc_require_verified_email),
        "timeout": int(s.oidc_timeout or 10),
        "auto_create": bool(s.oidc_auto_create),
    }


# ---------------------------------------------------------------------------
# The signed flow cookie
# ---------------------------------------------------------------------------
#
# state, nonce and the PKCE verifier all travel in ONE HttpOnly cookie rather
# than in server memory, because there are two uvicorn workers and no shared
# store: a value stashed in one process is simply absent when the callback
# lands on the other, which would make sign-in fail roughly half the time and
# look like an intermittent provider fault.
#
# It is signed with the app's own secret so tampering is detectable. It is not
# encrypted, and does not need to be — none of the three values is a secret
# from the person holding the cookie; they are secrets from everybody ELSE, and
# HttpOnly plus the signature is what provides that.


def _b64u(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).decode().rstrip("=")


def _b64u_decode(txt: str) -> bytes:
    return base64.urlsafe_b64decode(txt + "=" * (-len(txt) % 4))


def _secret() -> bytes:
    key = os.getenv("JWT_SECRET_KEY", "")
    if not key:
        raise OidcError("JWT_SECRET_KEY is not set; the sign-in flow cannot be signed")
    return key.encode()


def new_flow() -> tuple[dict, str, str]:
    """Start a sign-in. Returns (flow, cookie_value, code_challenge).

    `flow` carries state, nonce and verifier. Everything the callback needs
    lives in the signed cookie and in the URL — nothing is kept in this
    process. That is not tidiness: there are two uvicorn workers and no shared
    store, so anything stashed in module state here is simply absent when the
    callback lands on the other worker, and sign-in would fail about half the
    time while looking like an intermittent provider fault.
    """
    flow = {
        "state": _b64u(secrets.token_bytes(24)),
        "nonce": _b64u(secrets.token_bytes(24)),
        "verifier": _b64u(secrets.token_bytes(48)),
        "exp": int(time.time()) + SSO_FLOW_TTL,
    }
    body = _b64u(json.dumps(flow, separators=(",", ":")).encode())
    sig = _b64u(hmac.new(_secret(), body.encode(), hashlib.sha256).digest())
    challenge = _b64u(hashlib.sha256(flow["verifier"].encode()).digest())
    return flow, f"{body}.{sig}", challenge


def read_flow(cookie_value: str, state_param: str) -> dict:
    """Validate the cookie and the state parameter against each other."""
    if not cookie_value:
        raise OidcError("no sign-in cookie on the callback (blocked, expired, or a forged callback)")
    try:
        body, sig = cookie_value.split(".", 1)
    except ValueError:
        raise OidcError("malformed sign-in cookie") from None

    expected = _b64u(hmac.new(_secret(), body.encode(), hashlib.sha256).digest())
    # compare_digest, not ==: a plain comparison returns as soon as two bytes
    # differ, and the time that takes is a measurement of how much of the
    # signature was right.
    if not hmac.compare_digest(sig, expected):
        raise OidcError("sign-in cookie signature does not verify")

    try:
        payload = json.loads(_b64u_decode(body))
    except Exception as e:
        raise OidcError(f"unreadable sign-in cookie: {e}") from None

    if int(payload.get("exp", 0)) < int(time.time()):
        raise OidcError("sign-in took too long; start again")
    if not state_param or not hmac.compare_digest(str(payload.get("state", "")), str(state_param)):
        # This is the CSRF check. Without it, an attacker can hand somebody a
        # callback URL carrying the attacker's own authorization code and sign
        # that person into the ATTACKER's account, where anything they then do
        # is visible to the attacker.
        raise OidcError("state parameter does not match the sign-in cookie")
    return payload


# ---------------------------------------------------------------------------
# Provider metadata and keys
# ---------------------------------------------------------------------------


async def metadata() -> dict:
    cfg = config()
    url = cfg["discovery_url"]
    if not url:
        raise OidcError("OIDC_DISCOVERY_URL is not set")
    hit = _metadata_cache.get(url)
    if hit and (time.time() - hit[0]) < METADATA_TTL:
        return hit[1]
    try:
        async with httpx.AsyncClient(timeout=cfg["timeout"]) as client:
            res = await client.get(url)
            res.raise_for_status()
            doc = res.json()
    except Exception as e:
        raise OidcError(f"could not read the discovery document at {url}: {e}") from None
    for required in ("issuer", "authorization_endpoint", "token_endpoint", "jwks_uri"):
        if not doc.get(required):
            raise OidcError(f"discovery document is missing {required}")
    _metadata_cache[url] = (time.time(), doc)
    return doc


async def _fetch_jwks(uri: str, timeout: int) -> dict:
    try:
        async with httpx.AsyncClient(timeout=timeout) as client:
            res = await client.get(uri)
            res.raise_for_status()
            return res.json()
    except Exception as e:
        # A 401 for the caller, never a 500: a provider that is unreachable
        # means this person cannot sign in, not that this application is broken.
        raise OidcError(f"could not read the signing keys at {uri}: {e}") from None


async def _signing_key(uri: str, kid: str, timeout: int):
    """The key with this `kid`. Refetches ONCE if it is not already known.

    ★ There is deliberately no "if the kid is unknown, use the first key"
    fallback. During a rotation the first key in the set is the NEW one, while
    the token being verified was signed by the OLD one — so that fallback turns
    a precise "unknown key id" into an inscrutable signature failure, and
    invites the far worse habit of accepting a token verified against a key it
    was not signed with.
    """
    if not kid:
        raise OidcError("id_token header carries no kid")

    hit = _jwks_cache.get(uri)
    doc = hit[1] if hit and (time.time() - hit[0]) < JWKS_TTL else None

    key = _find_kid(doc, kid) if doc else None
    if key is None:
        doc = await _fetch_jwks(uri, timeout)
        _jwks_cache[uri] = (time.time(), doc)
        key = _find_kid(doc, kid)
    if key is None:
        raise OidcError(f"no signing key with kid={kid!r} in the provider's key set")

    alg = key.get("kty")
    if alg == "RSA":
        return jwt.algorithms.RSAAlgorithm.from_jwk(json.dumps(key))
    if alg == "EC":
        return jwt.algorithms.ECAlgorithm.from_jwk(json.dumps(key))
    raise OidcError(f"unsupported key type {alg!r}")


def _find_kid(doc: dict | None, kid: str) -> dict | None:
    for key in (doc or {}).get("keys", []) or []:
        if key.get("kid") == kid:
            return key
    return None


# ---------------------------------------------------------------------------
# The two halves of the flow
# ---------------------------------------------------------------------------


async def authorize_url(flow: dict, challenge: str) -> str:
    """Where to send the browser. `flow` is what new_flow() returned.

    The nonce is taken straight from the same dict that was signed into the
    cookie, so the value sent to the provider and the value checked on the way
    back cannot drift apart — and no state is kept in this process.
    """
    from urllib.parse import urlencode

    cfg = config()
    if not cfg["client_id"] or not cfg["redirect_uri"]:
        raise OidcError("OIDC_CLIENT_ID and OIDC_REDIRECT_URI must both be set")
    meta = await metadata()
    params = {
        "response_type": "code",
        "client_id": cfg["client_id"],
        "redirect_uri": cfg["redirect_uri"],
        "scope": cfg["scopes"],
        "state": flow["state"],
        "nonce": flow["nonce"],
        "code_challenge": challenge,
        "code_challenge_method": "S256",
    }
    return f"{meta['authorization_endpoint']}?{urlencode(params)}"


async def exchange_code(code: str, verifier: str) -> dict:
    cfg = config()
    meta = await metadata()
    data = {
        "grant_type": "authorization_code",
        "code": code,
        "redirect_uri": cfg["redirect_uri"],
        "client_id": cfg["client_id"],
        "code_verifier": verifier,
    }
    auth = None
    if cfg["client_secret"]:
        auth = (cfg["client_id"], cfg["client_secret"])
    try:
        async with httpx.AsyncClient(timeout=cfg["timeout"]) as client:
            res = await client.post(meta["token_endpoint"], data=data, auth=auth)
    except Exception as e:
        raise OidcError(f"token endpoint unreachable: {e}") from None
    if res.status_code != 200:
        raise OidcError(f"token endpoint refused the code: {res.status_code} {res.text[:200]}")
    body = res.json()
    if not body.get("id_token"):
        raise OidcError("token response carried no id_token")
    return body


async def verify_id_token(id_token: str, expected_nonce: str) -> dict[str, Any]:
    """Verify the token and return its claims. Raises OidcError on any doubt."""
    cfg = config()
    meta = await metadata()

    try:
        header = jwt.get_unverified_header(id_token)
    except Exception as e:
        raise OidcError(f"unreadable id_token header: {e}") from None

    # ★ Pinned to asymmetric algorithms, and never read from the token itself.
    # Accepting the header's choice permits the confusion attack: sign with
    # HS256 using the provider's PUBLIC key as the HMAC secret, and a verifier
    # that trusts the header accepts it. The public key is public.
    alg = header.get("alg")
    if alg not in ("RS256", "RS384", "RS512", "ES256", "ES384", "ES512"):
        raise OidcError(f"refusing id_token algorithm {alg!r}")

    key = await _signing_key(meta["jwks_uri"], header.get("kid", ""), cfg["timeout"])

    try:
        claims = jwt.decode(
            id_token,
            key=key,
            algorithms=[alg],
            issuer=meta["issuer"],
            # Audience is checked below, not here: Keycloak puts `aud:
            # "account"` and names the client in `azp`, so pyjwt's own audience
            # check would reject every real login against a default realm.
            options={"verify_aud": False, "require": ["exp", "iat", "iss"]},
        )
    except jwt.ExpiredSignatureError:
        raise OidcError("id_token has expired") from None
    except jwt.InvalidIssuerError:
        raise OidcError("id_token issuer does not match the discovery document") from None
    except Exception as e:
        raise OidcError(f"id_token did not verify: {type(e).__name__}: {e}") from None

    aud = claims.get("aud")
    aud_list = aud if isinstance(aud, list) else [aud] if aud else []
    if cfg["client_id"] not in aud_list and claims.get("azp") != cfg["client_id"]:
        # Without this, a token minted for a DIFFERENT application on the same
        # realm would be accepted here.
        raise OidcError(f"id_token is not for this client (aud={aud_list}, azp={claims.get('azp')!r})")

    if not expected_nonce or claims.get("nonce") != expected_nonce:
        raise OidcError("id_token nonce does not match the one this sign-in sent")

    email = str(claims.get("email") or "").strip().lower()
    if not email:
        raise OidcError("id_token carries no email claim")
    if cfg["require_verified_email"] and claims.get("email_verified") is False:
        # Only when the claim is present and false. A provider that omits it is
        # not evidence of an unverified address, and requiring the claim itself
        # would lock out providers that never send it.
        raise OidcError(f"the provider reports {email} as unverified")

    claims["email"] = email
    return claims
