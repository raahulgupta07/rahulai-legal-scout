"use client"

import { Suspense } from "react"
import { useRouter, useSearchParams } from "next/navigation"
import { LoadingScreen, Notice, Page, PageBody, PageHeader } from "@/components/ui/kit"
import { AdminTabs } from "../AdminTabs"
import { RANK, useUserRole } from "../roleClient"
import TemplatesView from "../templates/TemplatesView"
import CompaniesView from "../companies/CompaniesView"
import PeopleView from "../people/PeopleView"

/**
 * Every register tab requires at least "editor". The tab render is gated by
 * role in addition to the path guard, because a ?tab= query cannot be
 * path-guarded — e.g. /admin/registers?tab=people must never render below the
 * People minRole.
 */
const TABS: { id: string; label: string; minRole: string }[] = [
  { id: "templates", label: "Templates", minRole: "editor" },
  { id: "companies", label: "Companies", minRole: "editor" },
  { id: "people", label: "People", minRole: "editor" },
]

function RegistersInner() {
  const router = useRouter()
  const params = useSearchParams()
  const role = useUserRole()

  const visible = TABS.filter((t) => (RANK[role] ?? 0) >= RANK[t.minRole])
  const raw = params.get("tab") || ""
  const active = visible.some((t) => t.id === raw) ? raw : visible[0]?.id ?? ""

  const select = (id: string) =>
    router.replace(`/admin/registers/?tab=${id}`, { scroll: false })

  return (
    <Page>
      <PageHeader
        title="Registers"
        description="The templates, companies, and people the agent draws on to generate documents."
      />
      {visible.length > 0 && (
        <AdminTabs tabs={visible} active={active} onSelect={select} ariaLabel="Register sections" />
      )}
      <div className="flex-1 min-h-0 overflow-y-auto">
        {visible.length === 0 ? (
          <PageBody>
            <Notice tone="danger" title="No access">
              You do not have access to the registers. Contact your administrator.
            </Notice>
          </PageBody>
        ) : (
          <>
            {active === "templates" && <TemplatesView />}
            {active === "companies" && <CompaniesView />}
            {active === "people" && <PeopleView />}
          </>
        )}
      </div>
    </Page>
  )
}

export default function RegistersPage() {
  return (
    <Suspense fallback={<LoadingScreen label="Loading registers" />}>
      <RegistersInner />
    </Suspense>
  )
}
