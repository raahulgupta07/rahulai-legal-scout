"use client"

import { useEffect } from "react"
import { useRouter } from "next/navigation"
import { LoadingScreen } from "@/components/ui/kit"

/** Consolidated route — redirects to the new tabbed page. */
export default function PeopleRedirect() {
  const router = useRouter()
  useEffect(() => {
    router.replace("/admin/registers/?tab=people")
  }, [router])
  return <LoadingScreen label="Opening Registers" />
}
