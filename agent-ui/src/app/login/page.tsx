"use client"

import { useState, useEffect } from "react"
import { useRouter } from "next/navigation"

const CREDENTIAL_HINT =
  "Check the email for typos and retype your password. If it still fails, ask your administrator to reset it."

const FIELD =
  "w-full rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-[length:var(--text-sm)] text-[var(--text)] placeholder:text-[var(--text-muted)] focus:border-[var(--brand)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand)]"

const LABEL =
  "mb-1.5 block text-[length:var(--text-xs)] font-medium text-[var(--text-secondary)]"

export default function LoginPage() {
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [showPassword, setShowPassword] = useState(false)
  const [rememberMe, setRememberMe] = useState(false)
  const [error, setError] = useState("")
  const [errorHint, setErrorHint] = useState("")
  const [loading, setLoading] = useState(false)
  const router = useRouter()

  useEffect(() => {
    const saved = localStorage.getItem("ls_remember_email")
    if (saved) {
      setEmail(saved)
      setRememberMe(true)
    }
  }, [])

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
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden bg-[var(--bg)] px-4 py-12 font-[family-name:var(--font-body)]">
      {/* Faint 24px grid, fading in from the top */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0"
        style={{
          backgroundImage:
            "linear-gradient(to right, color-mix(in srgb, var(--ink) 4%, transparent) 1px, transparent 1px), linear-gradient(to bottom, color-mix(in srgb, var(--ink) 4%, transparent) 1px, transparent 1px)",
          backgroundSize: "24px 24px",
          maskImage: "linear-gradient(to bottom, transparent, black)",
          WebkitMaskImage: "linear-gradient(to bottom, transparent, black)",
        }}
      />
      {/* Blurred pastel glow, anchored bottom-center */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute bottom-0 left-1/2 h-[160px] w-[160px] -translate-x-1/2 translate-y-1/3 rounded-full"
        style={{
          background: "linear-gradient(45deg, #BE93C5, #7BC6CC, #DBE6F6)",
          filter: "blur(60px)",
        }}
      />

      {/* Sign-in card */}
      <div className="relative w-full max-w-[340px] rounded-[var(--radius-xl)] border border-[var(--border)] bg-[var(--surface)] p-7 shadow-[0_12px_32px_-8px_rgba(0,0,0,0.12)]">
        <div className="flex flex-col items-center text-center">
          <span
            aria-hidden="true"
            className="flex h-10 w-10 items-center justify-center rounded-[var(--radius-md)] bg-[var(--surface-inverse)] text-[length:var(--text-sm)] font-semibold text-[var(--text-inverse)]"
          >
            LS
          </span>
          <h1 className="mt-3 text-[18px] font-semibold text-[var(--text)]">Legal Scout</h1>
          <p className="mt-1 text-[length:var(--text-sm)] text-[var(--text-muted)]">
            Myanmar corporate-law document automation
          </p>
        </div>

        {error && (
          <div
            role="alert"
            className="mt-6 rounded-[var(--radius-md)] border border-[var(--danger)] bg-[color-mix(in_srgb,var(--danger)_8%,transparent)] px-3.5 py-3 text-[length:var(--text-sm)] leading-relaxed"
          >
            <p className="font-medium text-[var(--text)]">{error}</p>
            {errorHint && <p className="mt-1 text-[var(--text-secondary)]">{errorHint}</p>}
          </div>
        )}

        <form onSubmit={handleLogin} className="mt-6 space-y-4">
          <div>
            <label htmlFor="email" className={LABEL}>
              Email
            </label>
            <input
              id="email"
              name="email"
              type="email"
              autoComplete="username"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              placeholder="you@cityholdings.com.mm"
              className={FIELD}
            />
          </div>

          <div>
            <label htmlFor="password" className={LABEL}>
              Password
            </label>
            <div className="relative">
              <input
                id="password"
                name="password"
                type={showPassword ? "text" : "password"}
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                className={`${FIELD} pr-16`}
              />
              <button
                type="button"
                onClick={() => setShowPassword(!showPassword)}
                className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded-[var(--radius-md)] px-2 py-1 text-[length:var(--text-xs)] text-[var(--text-muted)] transition-colors hover:text-[var(--text)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand)]"
              >
                {showPassword ? "Hide" : "Show"}
              </button>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <input
              id="remember"
              type="checkbox"
              checked={rememberMe}
              onChange={(e) => setRememberMe(e.target.checked)}
              className="h-3.5 w-3.5 accent-[var(--brand)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand)]"
            />
            <label
              htmlFor="remember"
              className="cursor-pointer select-none text-[length:var(--text-sm)] text-[var(--text-secondary)]"
            >
              Remember my email on this device
            </label>
          </div>

          <button
            type="submit"
            disabled={loading}
            className="w-full rounded-[var(--radius-md)] bg-[var(--brand)] px-4 py-2.5 text-[length:var(--text-sm)] font-medium text-[var(--brand-fg)] transition-colors hover:bg-[color-mix(in_srgb,var(--brand)_86%,black)] disabled:opacity-40 focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--surface)]"
          >
            {loading ? "Signing in…" : "Sign in"}
          </button>
        </form>

        <p className="mt-6 text-center text-[length:var(--text-xs)] leading-relaxed text-[var(--text-muted)]">
          Accounts are issued by your administrator. If you cannot get in, contact them for a reset.
        </p>
      </div>
    </div>
  )
}
