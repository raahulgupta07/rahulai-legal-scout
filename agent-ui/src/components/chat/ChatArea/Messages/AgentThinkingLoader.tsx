/*
  rounded-[999px] rather than rounded-full: a pill radius that stays circular
  regardless of what the Tailwind rounding scale is configured to.

  cliBlink is declared in globals.css; motion-reduce:animate-none holds the
  dots at a steady state for users who ask for reduced motion, and the text
  label carries the meaning either way.
*/
const AgentThinkingLoader = () => (
  <div
    role="status"
    aria-label="Legal Scout is working"
    className="flex items-center gap-2 font-[family-name:var(--font-body)]"
  >
    <span className="inline-flex gap-1" aria-hidden="true">
      <span className="inline-block size-1.5 rounded-[999px] bg-[var(--text-muted)] animate-[cliBlink_1.2s_infinite_0s] motion-reduce:animate-none" />
      <span className="inline-block size-1.5 rounded-[999px] bg-[var(--text-muted)] animate-[cliBlink_1.2s_infinite_0.2s] motion-reduce:animate-none" />
      <span className="inline-block size-1.5 rounded-[999px] bg-[var(--text-muted)] animate-[cliBlink_1.2s_infinite_0.4s] motion-reduce:animate-none" />
    </span>
    <span className="text-[length:var(--text-xs)] text-[var(--text-muted)]">Working…</span>
  </div>
)

export default AgentThinkingLoader
