import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'

import {
  AgentDetails,
  SessionEntry,
  TeamDetails,
  type ChatMessage
} from '@/types/os'

interface Store {
  hydrated: boolean
  setHydrated: () => void
  streamingErrorMessage: string
  setStreamingErrorMessage: (streamingErrorMessage: string) => void
  endpoints: {
    endpoint: string
    id__endpoint: string
  }[]
  setEndpoints: (
    endpoints: {
      endpoint: string
      id__endpoint: string
    }[]
  ) => void
  isStreaming: boolean
  setIsStreaming: (isStreaming: boolean) => void
  abortController: AbortController | null
  setAbortController: (controller: AbortController | null) => void
  isEndpointActive: boolean
  setIsEndpointActive: (isActive: boolean) => void
  isEndpointLoading: boolean
  setIsEndpointLoading: (isLoading: boolean) => void
  messages: ChatMessage[]
  setMessages: (
    messages: ChatMessage[] | ((prevMessages: ChatMessage[]) => ChatMessage[])
  ) => void
  chatInputRef: React.RefObject<HTMLTextAreaElement | null>
  selectedEndpoint: string
  setSelectedEndpoint: (selectedEndpoint: string) => void
  authToken: string
  setAuthToken: (authToken: string) => void
  agents: AgentDetails[]
  setAgents: (agents: AgentDetails[]) => void
  teams: TeamDetails[]
  setTeams: (teams: TeamDetails[]) => void
  selectedModel: string
  setSelectedModel: (model: string) => void
  mode: 'agent' | 'team'
  setMode: (mode: 'agent' | 'team') => void
  sessionsData: SessionEntry[] | null
  setSessionsData: (
    sessionsData:
      | SessionEntry[]
      | ((prevSessions: SessionEntry[] | null) => SessionEntry[] | null)
  ) => void
  isSessionsLoading: boolean
  setIsSessionsLoading: (isSessionsLoading: boolean) => void
  pendingMessage: string | null
  setPendingMessage: (message: string | null) => void
  /**
   * A request to show one specific document in the right-hand panel.
   *
   * A conversation can produce several files (a resignation letter AND the
   * resolution that follows it), so "preview" has to name WHICH one rather
   * than defaulting to the most recent artifact. `nonce` lets the same file be
   * requested twice — clicking Preview again should re-open the panel even if
   * nothing about the file changed.
   */
  previewRequest: { fileName: string; nonce: number } | null
  requestPreview: (fileName: string) => void
  clearPreviewRequest: () => void
}

export const useStore = create<Store>()(
  persist(
    (set) => ({
      hydrated: false,
      setHydrated: () => set({ hydrated: true }),
      previewRequest: null,
      requestPreview: (fileName) =>
        set((s) => ({
          previewRequest: {
            fileName,
            nonce: (s.previewRequest?.nonce ?? 0) + 1
          }
        })),
      clearPreviewRequest: () => set({ previewRequest: null }),
      streamingErrorMessage: '',
      setStreamingErrorMessage: (streamingErrorMessage) =>
        set(() => ({ streamingErrorMessage })),
      endpoints: [],
      setEndpoints: (endpoints) => set(() => ({ endpoints })),
      isStreaming: false,
      setIsStreaming: (isStreaming) => set(() => ({ isStreaming })),
      abortController: null,
      setAbortController: (abortController) => set(() => ({ abortController })),
      isEndpointActive: false,
      setIsEndpointActive: (isActive) =>
        set(() => ({ isEndpointActive: isActive })),
      isEndpointLoading: true,
      setIsEndpointLoading: (isLoading) =>
        set(() => ({ isEndpointLoading: isLoading })),
      messages: [],
      setMessages: (messages) =>
        set((state) => ({
          messages:
            typeof messages === 'function' ? messages(state.messages) : messages
        })),
      chatInputRef: { current: null },
      selectedEndpoint: typeof window !== 'undefined' ? window.location.origin : (process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8001'),
      setSelectedEndpoint: (selectedEndpoint) =>
        set(() => ({ selectedEndpoint })),
      authToken: '',
      setAuthToken: (authToken) => set(() => ({ authToken })),
      agents: [],
      setAgents: (agents) => set({ agents }),
      teams: [],
      setTeams: (teams) => set({ teams }),
      selectedModel: '',
      setSelectedModel: (selectedModel) => set(() => ({ selectedModel })),
      mode: 'agent',
      setMode: (mode) => set(() => ({ mode })),
      sessionsData: null,
      setSessionsData: (sessionsData) =>
        set((state) => ({
          sessionsData:
            typeof sessionsData === 'function'
              ? sessionsData(state.sessionsData)
              : sessionsData
        })),
      isSessionsLoading: false,
      setIsSessionsLoading: (isSessionsLoading) =>
        set(() => ({ isSessionsLoading })),
      pendingMessage: null,
      setPendingMessage: (pendingMessage) => set(() => ({ pendingMessage }))
    }),
    {
      name: 'endpoint-storage',
      storage: createJSONStorage(() => localStorage),

      // ★★★ `selectedEndpoint` is NOT persisted, and must not be.
      //
      // It is DEFINED as `window.location.origin` (see the default above), so
      // storing it can only ever record where the app happened to be opened
      // FIRST in a given browser — and then force every later visit to talk to
      // that origin instead of the one it is being served from.
      //
      // Measured on the AWS deployment: the app had been opened once at
      // http://<ec2-ip>:3001, which pinned that value; afterwards, on
      // https://legalscoutagent.citygpt.xyz, every call built from this field
      // (/agents, /sessions, the status probe) went to the old origin and was
      // blocked as mixed content, while calls built relatively (/api/*) kept
      // working. The result was a page that polled happily, never loaded the
      // agent list, and left the composer permanently disabled with no error —
      // and the server logged nothing, because it was never asked. Confirmed
      // from the server side: zero /agents requests during the whole session.
      //
      // `version: 1` matters as much as the partialize change. Without the
      // bump, browsers that already hold the bad value keep rehydrating it and
      // stay broken; bumping it makes zustand discard the old persisted state
      // outright, so an affected browser repairs itself on the next load with
      // nobody having to clear anything by hand.
      version: 1,
      partialize: () => ({}),

      onRehydrateStorage: () => (state) => {
        state?.setHydrated?.()
      }
    }
  )
)
