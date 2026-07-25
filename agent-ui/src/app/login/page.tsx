"use client"

import { useState, useEffect } from "react"
import { useRouter } from "next/navigation"
import LoginShowcase from "@/components/auth/LoginShowcase"

const CREDENTIAL_HINT =
  "Check the email for typos and retype your password. If it still fails, ask your administrator to reset it."

/** bow sign-in field: label INSIDE the big rounded box, input under it. */
const BOX =
  "rounded-[14px] border border-[#E2E8F0] bg-white px-[18px] py-3 focus-within:border-[var(--brand)]"
const BOX_LABEL =
  "text-[11px] font-semibold tracking-[.12em] text-[#64748B]"
const BOX_INPUT =
  "w-full border-none bg-transparent py-1 text-[16px] text-[#0F172A] outline-none placeholder:text-[#94A3B8]"

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
    <div
      className="flex min-h-screen flex-col bg-white font-[family-name:var(--font-body)]"
      style={{
        backgroundImage:
          "linear-gradient(rgba(15,23,42,.03) 1px,transparent 1px),linear-gradient(90deg,rgba(15,23,42,.03) 1px,transparent 1px)",
        backgroundSize: "26px 26px",
      }}
    >
      {/* Header — logo left, live chip right, NO border */}
      <div className="flex items-start justify-between px-[70px] pt-[28px] max-lg:px-8">
        <div className="flex items-center gap-3">
          <span className="grid h-16 w-16 place-items-center rounded-[16px] bg-[#0F172A] text-[20px] font-bold text-white">
            LS
          </span>
          <div>
            <div className="text-[20px] font-bold text-[#0F172A]">
              Legal <span className="text-[#2563EB]">Scout</span>
            </div>
            <div className="text-[11px] font-medium tracking-[.22em] text-[#94A3B8]">
              MYANMAR CORPORATE LAW AUTOMATION
            </div>
          </div>
        </div>
        <span className="inline-flex items-center gap-[7px] rounded-full border border-[#E2E8F0] bg-white px-3.5 py-1.5 text-[13px] text-[#334155]">
          <span className="h-[7px] w-[7px] rounded-full bg-[#22C55E]" />
          live
        </span>
      </div>

      {/* Body: form left, showcase right */}
      <div className="flex flex-1 items-stretch justify-between gap-16 px-[70px] pb-3 pt-[26px] max-lg:flex-col max-lg:px-8">
        <div className="flex w-[580px] shrink-0 flex-col justify-center max-lg:w-full">
          <h1 className="mb-[20px] text-[46px] font-bold leading-[1.14] tracking-[-0.02em] text-[#0F172A]">
            {greeting()},
            <br />
            sign in to <span className="text-[#2563EB]">Legal Scout</span>
          </h1>
          <p className="mb-[30px] max-w-[480px] text-[16px] text-[#475569]">
            Myanmar corporate documents — drafted from your registers, reviewed
            by you.
          </p>

          {error && (
            <div
              className="mb-4 max-w-[580px] rounded-[14px] border border-[color-mix(in_srgb,var(--danger)_35%,transparent)] bg-[color-mix(in_srgb,var(--danger)_8%,transparent)] px-4 py-3"
              role="alert"
            >
              <p className="text-[13.5px] font-medium text-[var(--danger-strong)]">{error}</p>
              {errorHint && (
                <p className="mt-1 text-[12.5px] text-[var(--text-secondary)]">{errorHint}</p>
              )}
            </div>
          )}

          <form onSubmit={handleLogin} className="flex max-w-[580px] flex-col gap-4">
            <label className={BOX}>
              <span className={BOX_LABEL}>EMAIL</span>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@cityholdings.com.mm"
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
                className="absolute right-3 top-1/2 -translate-y-1/2 rounded-[8px] border border-[#E2E8F0] bg-[#F8FAFC] px-3 py-[5px] text-[13px] text-[#475569]"
              >
                {showPassword ? "Hide" : "Show"}
              </button>
            </label>

            <button
              type="button"
              onClick={() => setRememberMe(!rememberMe)}
              className="my-0.5 inline-flex items-center gap-[9px] self-start text-[14.5px] text-[#334155]"
            >
              <span
                className={`grid h-[18px] w-[18px] place-items-center rounded-[5px] text-[11px] text-white ${
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
              className="rounded-[14px] bg-[#2563EB] p-[18px] text-[16px] font-semibold text-white transition-colors hover:bg-[#1D4ED8] disabled:opacity-60"
            >
              {loading ? "Signing in…" : "Continue with email  →"}
            </button>
          </form>

          <div className="mt-5 flex max-w-[580px] items-center gap-3">
            <span className="flex-1 border-t border-[#E2E8F0]" />
            <span className="text-[11px] font-medium tracking-[.14em] text-[#94A3B8]">
              OR CONTINUE WITH
            </span>
            <span className="flex-1 border-t border-[#E2E8F0]" />
          </div>
          <button
            type="button"
            title="Ask your administrator to enable SSO"
            className="mt-3.5 flex max-w-[580px] items-center justify-center gap-[9px] rounded-[14px] border border-[#E2E8F0] bg-[#F8FAFC] p-4 text-[15px] font-medium text-[#0F172A]"
          >
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" aria-hidden>
              <path
                d="M12 2l8 4v6c0 5-3.5 8-8 10-4.5-2-8-5-8-10V6l8-4z"
                stroke="#2563EB"
                strokeWidth="1.7"
              />
            </svg>
            Continue with City Holdings SSO
          </button>
        </div>

        <LoginShowcase />
      </div>

      <footer className="py-3.5 text-center text-[13px] text-[#94A3B8]">
        © 2026 Legal Scout · Myanmar corporate-law automation
      </footer>
    </div>
  )
}
