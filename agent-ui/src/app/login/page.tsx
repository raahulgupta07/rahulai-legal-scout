"use client"

import { useState, useEffect } from "react"
import { useRouter } from "next/navigation"
import LoginShowcase from "@/components/auth/LoginShowcase"

const CREDENTIAL_HINT =
  "Check the email for typos and retype your password. If it still fails, ask your administrator to reset it."

/** bow sign-in field: label INSIDE the big rounded box, input under it. */
const BOX =
  "block rounded-[12px] border border-[#E5E7EB] bg-white px-[15px] py-[10.5px] focus-within:border-[var(--brand)]"
const BOX_LABEL =
  "block text-[11px] font-semibold tracking-[.03em] text-[#9CA3AF]"
const BOX_INPUT =
  "w-full border-none bg-transparent py-[1px] text-[15px] text-[#0F172A] outline-none placeholder:text-[#94A3B8]"

function greeting(): string {
  const h = new Date().getHours()
  return h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening"
}

export default function LoginPage() {
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [showPassword, setShowPassword] = useState(false)
  const [rememberMe, setRememberMe] = useState(false)
  const [error, setError] = useState("")
  const [errorHint, setErrorHint] = useState("")
  const [loading, setLoading] = useState(false)
  const [ssoEnabled, setSsoEnabled] = useState(false)
  const [ssoLabel, setSsoLabel] = useState("City Holdings SSO")
  const [ldapEnabled, setLdapEnabled] = useState(false)
  const [ldapLabel, setLdapLabel] = useState("Corporate directory")
  const router = useRouter()

  useEffect(() => {
    const saved = localStorage.getItem("ls_remember_email")
    if (saved) {
      setEmail(saved)
      setRememberMe(true)
    }
  }, [])

  // Which sign-in routes this deployment actually offers. The button below has
  // been rendered since the page was written but was never wired to anything —
  // it had no onClick at all, only a tooltip — so clicking it did nothing.
  // Whether it should be shown is the server's answer, and a failure here
  // leaves it hidden rather than showing a control that cannot work.
  useEffect(() => {
    ;(async () => {
      try {
        const res = await fetch((process.env.NEXT_PUBLIC_API_URL || "") + "/api/auth/config")
        if (!res.ok) return
        const c = await res.json()
        setSsoEnabled(!!c.sso_enabled)
        if (c.sso_label) setSsoLabel(c.sso_label)
        setLdapEnabled(!!c.ldap_enabled)
        if (c.ldap_label) setLdapLabel(c.ldap_label)
      } catch (e) {
        console.error("Auth config fetch failed:", e)
      }
    })()
  }, [])

  // The SSO callback hands the token back in the URL FRAGMENT: this frontend is
  // a static export with no server route that could receive it, and a fragment
  // — unlike a query string — is never sent to the server, never written into
  // an access log and never carried in a Referer header.
  //
  // It is removed from the address bar immediately, so the token does not sit
  // in browser history or get copied along with the URL.
  useEffect(() => {
    if (typeof window === "undefined") return
    const frag = new URLSearchParams(window.location.hash.replace(/^#/, ""))
    const token = frag.get("sso_token")
    if (token) {
      window.history.replaceState(null, "", window.location.pathname)
      localStorage.setItem("ls_token", token)
      fetch((process.env.NEXT_PUBLIC_API_URL || "") + "/api/auth/me", {
        headers: { Authorization: `Bearer ${token}` },
      })
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => {
          if (d?.user) localStorage.setItem("ls_user", JSON.stringify(d.user))
          router.push("/")
        })
        .catch(() => router.push("/"))
      return
    }
    // A failed SSO attempt comes back as a short, generic reason. The specific
    // cause is in the server log, not here — telling "no such account" apart
    // from "bad signature" on this screen would say which addresses exist.
    const params = new URLSearchParams(window.location.search)
    const ssoErr = params.get("sso_error")
    if (ssoErr) {
      setError(ssoErr)
      setErrorHint("")
      window.history.replaceState(null, "", window.location.pathname)
    }
  }, [router])

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault()
    setError("")
    setErrorHint("")
    setLoading(true)
    try {
      const res = await fetch((process.env.NEXT_PUBLIC_API_URL || "") + "/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      })
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}))
        if (res.status === 401 || res.status === 403) {
          setErrorHint(CREDENTIAL_HINT)
        } else if (res.status >= 500) {
          setErrorHint("The server is not responding. Try again in a moment.")
        }
        throw new Error(
          errData.detail || errData.error || `Sign in failed (${res.status}).`
        )
      }
      const data = await res.json()
      if (data.success) {
        localStorage.setItem("ls_token", data.token)
        localStorage.setItem("ls_user", JSON.stringify(data.user))
        if (rememberMe) {
          localStorage.setItem("ls_remember_email", email)
        } else {
          localStorage.removeItem("ls_remember_email")
        }
        router.push("/")
      } else {
        setError(data.error || "Invalid email or password.")
        setErrorHint(CREDENTIAL_HINT)
      }
    } catch (e) {
      if (e instanceof TypeError) {
        // fetch() rejects with TypeError when the request never reached the server.
        setError("Could not reach Legal Scout.")
        setErrorHint("Check your network connection and try again.")
      } else {
        setError(e instanceof Error ? e.message : "Sign in failed.")
      }
    } finally {
      setLoading(false)
    }
  }

  return (
    <div
      className="flex min-h-screen flex-col bg-white font-[family-name:var(--font-body)]"
      style={{
        backgroundImage:
          "linear-gradient(rgba(15,23,42,.03) 1px,transparent 1px),linear-gradient(90deg,rgba(15,23,42,.03) 1px,transparent 1px)",
        backgroundSize: "26px 26px",
      }}
    >
      {/* Header — logo left, live chip right, NO border */}
      <div className="mx-auto flex w-full max-w-[1500px] items-center justify-between px-11 py-4">
        <div className="flex items-center gap-3">
          <span className="grid h-10 w-10 place-items-center overflow-hidden rounded-[9px] bg-[#0F172A]">
            <img src="/logo.png" alt="" className="h-[30px] w-[30px] object-contain" />
          </span>
          <div>
            <div className="text-[17px] font-bold text-[#0F172A]">
              Legal <span className="text-[#2563EB]">Scout</span>
            </div>
            <div className="text-[9.5px] font-semibold tracking-[2px] text-[#94A3B8]">
              MYANMAR CORPORATE LAW AUTOMATION
            </div>
          </div>
        </div>
        <span className="inline-flex items-center gap-[7px] rounded-full border border-[#E2E8F0] bg-white px-3 py-1.5 text-[12px] text-[#334155]">
          <span className="h-[7px] w-[7px] rounded-full bg-[#22C55E]" />
          live
        </span>
      </div>

      {/* Body: form left, showcase right */}
      <div className="mx-auto grid w-full max-w-[1500px] flex-1 grid-cols-[1fr_677px] gap-11 px-11 pb-4 max-lg:grid-cols-1 max-lg:px-8">
        <div className="flex flex-col justify-center pl-14 max-lg:pl-0"><div className="w-[440px] max-w-full">
          <h1 className="mb-3 text-[40px] font-semibold leading-[1.12] tracking-[-0.02em] text-[#0F172A]">
            {greeting()},
            <br />
            sign in to <span className="text-[#2563EB]">Legal Scout</span>
          </h1>
          <p className="mb-[22px] max-w-[390px] text-[15px] text-[#6B7280]">
            Myanmar corporate documents — drafted from your registers, reviewed
            by you.
          </p>

          {error && (
            <div
              className="mb-4 rounded-[12px] border border-[color-mix(in_srgb,var(--danger)_35%,transparent)] bg-[color-mix(in_srgb,var(--danger)_8%,transparent)] px-4 py-3"
              role="alert"
            >
              <p className="text-[13.5px] font-medium text-[var(--danger-strong)]">{error}</p>
              {errorHint && (
                <p className="mt-1 text-[12.5px] text-[var(--text-secondary)]">{errorHint}</p>
              )}
            </div>
          )}

          <form onSubmit={handleLogin} className="flex flex-col gap-[18px]">
            {/* ★ `type="email"` is wrong once a directory is configured: the
                BROWSER refuses to submit a bare username, so an Active
                Directory person who knows their sAMAccountName and not the
                address Legal Scout files them under could never even send the
                form. The box, its size and its position are unchanged — only
                the accepted shape and the wording. */}
            <label className={BOX}>
              <span className={BOX_LABEL}>{ldapEnabled ? "EMAIL OR USERNAME" : "EMAIL"}</span>
              <input
                type={ldapEnabled ? "text" : "email"}
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder={ldapEnabled ? "you@cityholdings.com.mm  ·  or your network username" : "you@cityholdings.com.mm"}
                autoComplete="username"
                required
                className={BOX_INPUT}
              />
            </label>
            <label className={`${BOX} relative`}>
              <span className={BOX_LABEL}>PASSWORD</span>
              <input
                type={showPassword ? "text" : "password"}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••••"
                autoComplete="current-password"
                required
                className={`${BOX_INPUT} pr-16`}
              />
              <button
                type="button"
                onClick={() => setShowPassword(!showPassword)}
                className="absolute right-[13px] top-1/2 -translate-y-1/2 rounded-[8px] border border-[#E2E8F0] bg-[#F8FAFC] px-[11px] py-[5px] text-[12px] text-[#475569]"
              >
                {showPassword ? "Hide" : "Show"}
              </button>
            </label>

            <button
              type="button"
              onClick={() => setRememberMe(!rememberMe)}
              className="mt-[3px] inline-flex items-center gap-2 self-start text-[13.5px] text-[#334155]"
            >
              <span
                className={`grid h-[18px] w-[18px] place-items-center rounded-[6px] text-[11px] text-white ${
                  rememberMe ? "bg-[#2563EB]" : "border border-[#CBD5E1] bg-white"
                }`}
              >
                {rememberMe ? "✓" : ""}
              </span>
              Remember me
            </button>

            <button
              type="submit"
              disabled={loading}
              className="mt-[13px] h-12 rounded-[11px] bg-[#2563EB] px-4 text-[15px] font-semibold text-white transition-colors hover:bg-[#1D4ED8] disabled:opacity-60"
            >
              {loading ? "Signing in…" : ldapEnabled ? "Sign in  →" : "Continue with email  →"}
            </button>

            {/* ★ Directory sign-in submits THIS form — it is the same two
                fields, and the server decides which credential store answers.
                So this button is a second submit control for one form, not a
                second route: it fills the username hint and submits, and it
                exists because a line of explanatory text was not enough. Asked
                for directly after the text-only version left people looking
                for a button and concluding the feature was missing.

                It is deliberately NOT a link to some other flow, because there
                isn't one — presenting it as a separate journey would be a
                prettier lie than the missing button was. */}
            {ldapEnabled && (
              <>
                <div className="mt-[6px] flex items-center gap-3">
                  <span className="flex-1 border-t border-[#E2E8F0]" />
                  <span className="text-[11px] font-medium tracking-[.14em] text-[#94A3B8]">OR</span>
                  <span className="flex-1 border-t border-[#E2E8F0]" />
                </div>
                <button
                  type="submit"
                  disabled={loading}
                  title={`Enter your ${ldapLabel} username and password above, then use this button`}
                  className="flex h-12 w-full items-center justify-center gap-[9px] rounded-[11px] border border-[#E2E8F0] bg-[#F8FAFC] px-4 text-[14px] font-medium text-[#0F172A] transition-colors hover:bg-[#F1F5F9] disabled:opacity-60"
                >
                  <svg width="17" height="17" viewBox="0 0 24 24" fill="none" aria-hidden>
                    <path
                      d="M4 7h16M4 12h16M4 17h16"
                      stroke="#2563EB"
                      strokeWidth="1.7"
                      strokeLinecap="round"
                    />
                  </svg>
                  Sign in with {ldapLabel}
                </button>
                <p className="-mt-[4px] text-center text-[12px] text-[#6B7280]">
                  Use your network username and password — the same ones you use to log in to your
                  computer.
                </p>
              </>
            )}
          </form>

          {/* Shown only when the server says single sign-on is configured. It
              used to render unconditionally with no onClick and a tooltip
              reading "Ask your administrator to enable SSO" — a control that
              could be clicked and did nothing. A button that cannot work is
              better absent than present. Same markup, same position, same
              styling: this is a wiring change, not a redesign. */}
          {ssoEnabled && (
            <>
              <div className="mt-[18px] flex items-center gap-3">
                <span className="flex-1 border-t border-[#E2E8F0]" />
                <span className="text-[11px] font-medium tracking-[.14em] text-[#94A3B8]">
                  OR CONTINUE WITH
                </span>
                <span className="flex-1 border-t border-[#E2E8F0]" />
              </div>
              <button
                type="button"
                onClick={() => {
                  // A full navigation, not fetch(): the provider answers with a
                  // redirect to its own login page, which the browser has to
                  // follow at the top level. An XHR would follow it invisibly
                  // and land the HTML of somebody else's login page in a
                  // response body.
                  window.location.href =
                    (process.env.NEXT_PUBLIC_API_URL || "") + "/api/auth/sso/login"
                }}
                className="mt-3 flex h-12 w-full items-center justify-center gap-[9px] rounded-[11px] border border-[#E2E8F0] bg-[#F8FAFC] px-4 text-[14px] font-medium text-[#0F172A] transition-colors hover:bg-[#F1F5F9]"
              >
                <svg width="17" height="17" viewBox="0 0 24 24" fill="none" aria-hidden>
                  <path
                    d="M12 2l8 4v6c0 5-3.5 8-8 10-4.5-2-8-5-8-10V6l8-4z"
                    stroke="#2563EB"
                    strokeWidth="1.7"
                  />
                </svg>
                Continue with {ssoLabel}
              </button>
            </>
          )}
        </div>

        </div>
        <LoginShowcase />
      </div>

      <footer className="pb-3.5 pt-2 text-center text-[12.5px] text-[#94A3B8]">
        © 2026 Legal Scout · Myanmar corporate-law automation
      </footer>
    </div>
  )
}
