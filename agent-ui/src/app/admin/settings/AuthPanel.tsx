"use client"

import { useCallback, useEffect, useState } from "react"
import { KeyRound, Lock, ShieldCheck } from "lucide-react"
import { authFetch } from "@/lib/api-client"
import { toast } from "sonner"
import {
  Badge,
  Button,
  Card,
  LoadingScreen,
  Notice,
  SelectField,
  TextField,
} from "@/components/ui/kit"

const API = `${process.env.NEXT_PUBLIC_API_URL || ""}/api/admin/auth-settings`

type Settings = Record<string, unknown>

/** The three sign-in modes, in the words an administrator thinks in. */
const MODE_OPTIONS = [
  { value: "hybrid", label: "Password and single sign-on" },
  { value: "local", label: "Password only — single sign-on hidden" },
  { value: "sso_only", label: "Single sign-on only" },
]

const MODE_NOTE: Record<string, string> = {
  hybrid: "Both routes are offered. This is the default.",
  local: "The single sign-on button is not shown, and the routes refuse requests.",
  sso_only:
    "Password sign-in is refused — except for an administrator, who keeps it as a way back in if the provider is misconfigured.",
}

/** A labelled on/off row. */
function Toggle({
  label,
  hint,
  value,
  onChange,
  tone,
}: {
  label: string
  hint?: string
  value: boolean
  onChange: (v: boolean) => void
  tone?: "warn"
}) {
  return (
    <button
      type="button"
      onClick={() => onChange(!value)}
      className={`flex w-full items-center justify-between gap-4 rounded-[var(--radius-md,8px)] border px-3 py-2.5 text-left transition-colors ${
        tone === "warn" && value
          ? "border-[color-mix(in_srgb,var(--warn)_45%,transparent)] bg-[color-mix(in_srgb,var(--warn)_8%,transparent)]"
          : "border-[var(--border)] bg-[var(--bg)]"
      }`}
    >
      <span className="min-w-0">
        <span className="block text-[length:var(--text-sm)] font-medium text-[var(--text)]">{label}</span>
        {hint && (
          <span className="mt-0.5 block text-[length:var(--text-2xs)] leading-relaxed text-[var(--text-muted)]">
            {hint}
          </span>
        )}
      </span>
      <span
        className={`relative h-[18px] w-[32px] shrink-0 rounded-full transition-colors ${
          value ? "bg-[var(--brand)]" : "bg-[var(--border)]"
        }`}
      >
        <span
          className={`absolute top-[2px] h-[14px] w-[14px] rounded-full bg-white transition-all ${
            value ? "left-[16px]" : "left-[2px]"
          }`}
        />
      </span>
    </button>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="space-y-2">
      <div className="text-[length:var(--text-2xs)] font-semibold uppercase tracking-[0.05em] text-[var(--text-muted)]">
        {title}
      </div>
      {children}
    </div>
  )
}

export default function AuthPanel() {
  const [s, setS] = useState<Settings | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<{ ok: boolean; msg: string } | null>(null)
  const [testingLdap, setTestingLdap] = useState(false)
  const [ldapResult, setLdapResult] = useState<{ ok: boolean; msg: string } | null>(null)
  const [error, setError] = useState("")

  const load = useCallback(async () => {
    try {
      const res = await authFetch(API)
      const data = await res.json()
      if (!data.success) throw new Error(data.error || "Could not load sign-in settings")
      setS(data.settings)
      setError("")
    } catch (e: any) {
      setError(e?.message || "Could not load sign-in settings")
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  const set = (k: string, v: unknown) => setS((prev) => ({ ...(prev || {}), [k]: v }))
  const str = (k: string) => String(s?.[k] ?? "")
  const bool = (k: string) => Boolean(s?.[k])

  const save = async () => {
    if (!s) return
    setSaving(true)
    try {
      // Only real settings go back — the read-only companions the server adds
      // (`*_set` for secrets, `_overridden`) are not settings and would be
      // rejected as unknown keys.
      const payload: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(s)) {
        if (k.startsWith("_") || k.endsWith("_set")) continue
        payload[k] = v
      }
      const res = await authFetch(API, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ settings: payload }),
      })
      const data = await res.json()
      if (!data.success) throw new Error(data.error || "Save failed")
      setS(data.settings)
      toast.success("Sign-in settings saved — they apply to the next sign-in")
    } catch (e: any) {
      toast.error(e?.message || "Save failed")
    } finally {
      setSaving(false)
    }
  }

  const test = async (which: "sso" | "ldap") => {
    const setBusy = which === "ldap" ? setTestingLdap : setTesting
    const setResult = which === "ldap" ? setLdapResult : setTestResult
    setBusy(true)
    setResult(null)
    try {
      const res = await authFetch(`${API}/${which === "ldap" ? "test-ldap" : "test"}`, { method: "POST" })
      const data = await res.json()
      setResult({ ok: !!data.success, msg: data.success ? data.message : data.error })
    } catch (e: any) {
      setResult({ ok: false, msg: e?.message || "Test failed" })
    } finally {
      setBusy(false)
    }
  }

  if (loading) return <LoadingScreen label="Loading sign-in settings" />
  if (error) return <Notice tone="danger" title="Could not load sign-in settings">{error}</Notice>
  if (!s) return null

  const mode = str("signin_mode") || "hybrid"

  return (
    <div className="space-y-4">
      <Notice tone="info" title="How these settings relate to access">
        The directory and the provider prove <b>who</b> somebody is. This application decides{" "}
        <b>what they may do</b>: roles are set on the Users tab and are never read from a token or a
        group. Saved changes apply to the next sign-in — no restart.
      </Notice>

      <Card>
        <div className="space-y-4 p-4">
          <Section title="Sign-in mode">
            <SelectField
              label="How people sign in"
              value={mode}
              onChange={(v) => set("signin_mode", v)}
              options={MODE_OPTIONS}
              hint={MODE_NOTE[mode]}
              wide
            />
            {mode === "sso_only" && (
              <Notice tone="warn" title="An administrator can always sign in with a password">
                That exemption is deliberate. Without it, one mistyped provider URL locks every
                person out of Legal Scout — including whoever has to come back in here and correct
                it — and the only way back would be editing the database by hand.
              </Notice>
            )}
          </Section>
        </div>
      </Card>

      <Card>
        <div className="space-y-3 p-4">
          <div className="flex items-center gap-2">
            <KeyRound className="h-3.5 w-3.5 text-[var(--text-muted)]" />
            <span className="text-[length:var(--text-sm)] font-semibold text-[var(--text)]">
              Directory (LDAP / Active Directory)
            </span>
            {bool("ldap_enabled") && <Badge tone="ok" dot>on</Badge>}
          </div>

          <Toggle
            label="Use a directory for sign-in"
            hint="People type the same email and password. If the local password does not match, the directory is asked."
            value={bool("ldap_enabled")}
            onChange={(v) => set("ldap_enabled", v)}
          />

          {bool("ldap_enabled") && (
            <div className="space-y-3 border-l-2 border-[var(--border)] pl-3">
              <div className="grid grid-cols-2 gap-3 max-md:grid-cols-1">
                <TextField label="Host" value={str("ldap_host")} onChange={(v) => set("ldap_host", v)} placeholder="ldap.corp.example.com" />
                <TextField label="Port" value={str("ldap_port")} onChange={(v) => set("ldap_port", v)} placeholder="636" />
              </div>
              <Toggle label="LDAPS (implicit TLS, usually port 636)" value={bool("ldap_use_ssl")} onChange={(v) => set("ldap_use_ssl", v)} />
              <Toggle label="StartTLS (usually port 389)" value={bool("ldap_start_tls")} onChange={(v) => set("ldap_start_tls", v)} />
              <Toggle
                label="Validate the directory's certificate"
                hint="Leave this on. Off means the server on the other end is whoever answered."
                value={bool("ldap_validate_cert")}
                onChange={(v) => set("ldap_validate_cert", v)}
              />
              <TextField label="CA certificate file" value={str("ldap_ca_cert_file")} onChange={(v) => set("ldap_ca_cert_file", v)} placeholder="only for a private CA" wide />
              <TextField label="Service account DN" value={str("ldap_bind_dn")} onChange={(v) => set("ldap_bind_dn", v)} placeholder="cn=svc-legalscout,ou=service,dc=corp,dc=com" wide />
              <TextField
                label="Service account password"
                type="password"
                value={str("ldap_bind_password")}
                onChange={(v) => set("ldap_bind_password", v)}
                placeholder={s["ldap_bind_password_set"] ? "•••••••• — leave blank to keep" : "not set"}
                hint="Never shown once saved. Leave blank to keep the stored one."
                wide
              />
              <TextField label="Base DN" value={str("ldap_base_dn")} onChange={(v) => set("ldap_base_dn", v)} placeholder="ou=users,dc=corp,dc=com" wide />
              <TextField
                label="User filter"
                value={str("ldap_user_filter")}
                onChange={(v) => set("ldap_user_filter", v)}
                hint="The sign-in form collects an email, so this matches the mail attribute. (sAMAccountName={username}) needs a bare username and would match nothing."
                wide
              />
              <Toggle
                label="Allow an unencrypted connection"
                hint="The password crosses the network on every sign-in. Without TLS it crosses it readable. For a lab only."
                value={bool("ldap_allow_insecure")}
                onChange={(v) => set("ldap_allow_insecure", v)}
                tone="warn"
              />
              <div className="flex items-center gap-3 pt-1">
                <Button
                  variant="secondary"
                  onClick={() => test("ldap")}
                  disabled={testingLdap}
                  icon={<Lock className="h-3.5 w-3.5" />}
                >
                  {testingLdap ? "Checking…" : "Test the directory connection"}
                </Button>
                {ldapResult && (
                  <span
                    className={`text-[length:var(--text-xs)] ${
                      ldapResult.ok ? "text-[var(--ok)]" : "text-[var(--danger-strong)]"
                    }`}
                  >
                    {ldapResult.msg}
                  </span>
                )}
              </div>
              <p className="text-[length:var(--text-2xs)] text-[var(--text-muted)]">
                Binds as the service account and runs one search — the same first two steps a real
                sign-in takes. It cannot check anybody&apos;s password, because that needs their
                credentials. Save first: it tests the stored settings, not what is typed above.
              </p>
              <Toggle
                label="Create accounts automatically from the directory"
                hint="New people land pending approval as ordinary users. It removes the typing, not the approval — but it also means an unknown address is offered to your directory, which an internet-facing deployment should weigh against account lockouts."
                value={bool("ldap_auto_create")}
                onChange={(v) => set("ldap_auto_create", v)}
                tone="warn"
              />
            </div>
          )}
        </div>
      </Card>

      <Card>
        <div className="space-y-3 p-4">
          <div className="flex items-center gap-2">
            <ShieldCheck className="h-3.5 w-3.5 text-[var(--text-muted)]" />
            <span className="text-[length:var(--text-sm)] font-semibold text-[var(--text)]">Single sign-on</span>
            {bool("oidc_enabled") && <Badge tone="ok" dot>on</Badge>}
          </div>

          <Toggle
            label="Offer single sign-on"
            hint="Adds a Continue with … button to the sign-in screen. Hidden entirely when off."
            value={bool("oidc_enabled")}
            onChange={(v) => set("oidc_enabled", v)}
          />

          {bool("oidc_enabled") && (
            <div className="space-y-3 border-l-2 border-[var(--border)] pl-3">
              <TextField label="Discovery URL" value={str("oidc_discovery_url")} onChange={(v) => set("oidc_discovery_url", v)} placeholder="https://keycloak.example.com/realms/.../.well-known/openid-configuration" wide />
              <div className="grid grid-cols-2 gap-3 max-md:grid-cols-1">
                <TextField label="Client ID" value={str("oidc_client_id")} onChange={(v) => set("oidc_client_id", v)} />
                <SelectField
                  label="Provider"
                  value={str("oidc_provider_type") || "keycloak"}
                  onChange={(v) => set("oidc_provider_type", v)}
                  options={[
                    { value: "keycloak", label: "Keycloak" },
                    { value: "entra", label: "Microsoft Entra" },
                    { value: "google", label: "Google" },
                    { value: "generic", label: "Other" },
                  ]}
                />
              </div>
              <TextField
                label="Client secret"
                type="password"
                value={str("oidc_client_secret")}
                onChange={(v) => set("oidc_client_secret", v)}
                placeholder={s["oidc_client_secret_set"] ? "•••••••• — leave blank to keep" : "not set"}
                hint="Never shown once saved. Leave blank to keep the stored one."
                wide
              />
              <TextField
                label="Redirect URI"
                value={str("oidc_redirect_uri")}
                onChange={(v) => set("oidc_redirect_uri", v)}
                hint="Must byte-match a redirect URI registered on the client, or the provider rejects the request before it reaches Legal Scout."
                wide
              />
              <TextField label="Button label" value={str("oidc_label")} onChange={(v) => set("oidc_label", v)} placeholder="City Holdings SSO" wide />
              <Toggle
                label="Refuse a sign-in the provider reports as unverified"
                hint="Only applies when the provider sends email_verified. One that omits it is unaffected."
                value={bool("oidc_require_verified_email")}
                onChange={(v) => set("oidc_require_verified_email", v)}
              />
              <Toggle
                label="Create accounts automatically from the provider"
                hint="New people land pending approval as ordinary users. No claim, group or mapper can make them an administrator."
                value={bool("oidc_auto_create")}
                onChange={(v) => set("oidc_auto_create", v)}
                tone="warn"
              />

              <div className="flex items-center gap-3 pt-1">
                <Button variant="secondary" onClick={() => test("sso")} disabled={testing} icon={<Lock className="h-3.5 w-3.5" />}>
                  {testing ? "Checking…" : "Test the connection"}
                </Button>
                {testResult && (
                  <span
                    className={`text-[length:var(--text-xs)] ${
                      testResult.ok ? "text-[var(--ok)]" : "text-[var(--danger-strong)]"
                    }`}
                  >
                    {testResult.msg}
                  </span>
                )}
              </div>
              <p className="text-[length:var(--text-2xs)] text-[var(--text-muted)]">
                The test reads the discovery document and the signing keys — the same path a real
                sign-in takes, so a pass means what sign-in depends on actually works. Save first:
                it tests the stored settings, not what is typed above.
              </p>
            </div>
          )}
        </div>
      </Card>

      <div className="flex items-center gap-3">
        <Button variant="primary" onClick={save} disabled={saving}>
          {saving ? "Saving…" : "Save sign-in settings"}
        </Button>
        <span className="text-[length:var(--text-2xs)] text-[var(--text-muted)]">
          Applied on the next sign-in. Existing sessions are unaffected.
        </span>
      </div>
    </div>
  )
}
