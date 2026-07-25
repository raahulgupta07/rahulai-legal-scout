"use client"

import { Suspense } from "react"
import { useRouter, useSearchParams } from "next/navigation"
import { LoadingScreen, Page, PageHeader } from "@/components/ui/kit"
import { AdminTabs } from "../AdminTabs"
import DashboardView from "../dashboard/DashboardView"
import DocumentsView from "../documents/DocumentsView"
import EmailsView from "../emails/EmailsView"
import SkillsView from "../skills/SkillsView"

const TABS = [
  { id: "dashboard", label: "Dashboard" },
  { id: "documents", label: "Documents" },
  { id: "emails", label: "Emails" },
  { id: "skills", label: "Skills" },
]

function OverviewInner() {
  const router = useRouter()
  const params = useSearchParams()
  const raw = params.get("tab") || ""
  const active = TABS.some((t) => t.id === raw) ? raw : "dashboard"

  const select = (id: string) =>
    router.replace(`/admin/overview/?tab=${id}`, { scroll: false })

  return (
    <Page>
      <PageHeader
        title="Overview"
        description="Dashboard, generated documents, and the emails the agent has sent."
      />
      <AdminTabs tabs={TABS} active={active} onSelect={select} ariaLabel="Overview sections" />
      <div className="flex-1 min-h-0 overflow-y-auto">
        {active === "dashboard" && <DashboardView />}
        {active === "documents" && <DocumentsView />}
        {active === "emails" && <EmailsView />}
        {active === "skills" && <SkillsView />}
      </div>
    </Page>
  )
}

export default function OverviewPage() {
  return (
    <Suspense fallback={<LoadingScreen label="Loading overview" />}>
      <OverviewInner />
    </Suspense>
  )
}
