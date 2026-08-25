/**
 * API Client for Dashboard
 * Centralizes all API endpoint URLs with environment-based configuration
 */

const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL || ''

/** Get auth headers for API calls */
export function getAuthHeaders(): Record<string, string> {
  if (typeof window === 'undefined') return {}
  const token = localStorage.getItem('ls_token')
  if (!token) return {}
  return { 'Authorization': `Bearer ${token}` }
}

/** Authenticated fetch — adds JWT token automatically, redirects to login on 401 */
export async function authFetch(url: string, options: RequestInit = {}): Promise<Response> {
  const headers = { ...getAuthHeaders(), ...(options.headers as Record<string, string> || {}) }
  const res = await fetch(url, { ...options, headers })
  if (res.status === 401 && typeof window !== 'undefined') {
    localStorage.removeItem('ls_token')
    localStorage.removeItem('ls_user')
    window.location.href = '/login'
  }
  return res
}

export const apiClient = {
  // Dashboard endpoints
  getDashboardStats: () => `${API_BASE_URL}/api/dashboard/stats`,
  getDashboardDocuments: (limit = 50) => `${API_BASE_URL}/api/dashboard/documents?limit=${limit}`,
  getDashboardTemplates: () => `${API_BASE_URL}/api/dashboard/templates`,
  getDashboardData: () => `${API_BASE_URL}/api/dashboard/data`,

  // Template endpoints
  getTemplateDetails: (name: string) => `${API_BASE_URL}/api/dashboard/templates/${encodeURIComponent(name)}`,
  uploadTemplate: () => `${API_BASE_URL}/api/dashboard/upload/template`,
  analyzeTemplate: () => `${API_BASE_URL}/api/templates/analyze`,
  deleteTemplate: (name: string) => `${API_BASE_URL}/api/templates/delete?name=${encodeURIComponent(name)}`,
  downloadTemplate: (name: string) => `${API_BASE_URL}/documents/legal/templates/${encodeURIComponent(name)}`,
  previewTemplate: (name: string) => `${API_BASE_URL}/api/templates/preview/${encodeURIComponent(name)}`,
  previewTemplatePdf: (name: string) => `${API_BASE_URL}/api/templates/preview-pdf/${encodeURIComponent(name)}`,
  getTemplateCategories: () => `${API_BASE_URL}/api/templates/categories`,

  // Company endpoints
  addCompany: () => `${API_BASE_URL}/api/dashboard/add/company`,
  getCompany: (id: number) => `${API_BASE_URL}/api/dashboard/company/${id}`,
  updateCompany: (name: string) => `${API_BASE_URL}/api/dashboard/company/${encodeURIComponent(name)}`,
  deleteCompany: (name: string) => `${API_BASE_URL}/api/dashboard/company/${encodeURIComponent(name)}`,
  uploadCompanyPdf: () => `${API_BASE_URL}/api/company/upload-pdf`,
  extractCompanyPdfStream: () => `${API_BASE_URL}/api/company/extract-pdf-stream`,
  documentDetail: (id: string | number) => `${API_BASE_URL}/api/dashboard/document-detail/${id}`,
  fieldRegistry: () => `${API_BASE_URL}/api/dashboard/field-registry`,
  refreshFieldRegistry: () => `${API_BASE_URL}/api/dashboard/field-registry/refresh`,

  // People Register endpoints
  getPeople: (search?: string) =>
    `${API_BASE_URL}/api/people${search ? `?search=${encodeURIComponent(search)}` : ''}`,
  addPerson: () => `${API_BASE_URL}/api/people`,
  getPerson: (id: number) => `${API_BASE_URL}/api/people/${id}`,
  updatePerson: (id: number) => `${API_BASE_URL}/api/people/${id}`,
  deletePerson: (id: number) => `${API_BASE_URL}/api/people/${id}`,
  getPersonCompanies: (id: number) => `${API_BASE_URL}/api/people/${id}/companies`,
  syncPeopleFromCompanies: () => `${API_BASE_URL}/api/people/sync-from-companies`,

  // Company ↔ person link endpoints
  linkCompanyPerson: (companyId: number) => `${API_BASE_URL}/api/companies/${companyId}/people`,
  unlinkCompanyPerson: (companyId: number, personId: number) =>
    `${API_BASE_URL}/api/companies/${companyId}/people/${personId}`,
  getCompanyPeople: (companyId: number, role?: string) =>
    `${API_BASE_URL}/api/companies/${companyId}/people${role ? `?role=${encodeURIComponent(role)}` : ''}`,

  // Document generation
  downloadDocument: (filename: string) => `${API_BASE_URL}/documents/legal/output/${encodeURIComponent(filename)}`,

  // Knowledge base endpoints
  getTrainingStatus: () => `${API_BASE_URL}/api/training/status`,
  getKnowledgeSources: () => `${API_BASE_URL}/api/knowledge/sources`,
  uploadKnowledge: () => `${API_BASE_URL}/api/knowledge/upload`,
  searchKnowledge: (query: string, limit = 20) => `${API_BASE_URL}/api/knowledge/search?q=${encodeURIComponent(query)}&limit=${limit}`,
  lookupKnowledge: (key: string, value: string) => `${API_BASE_URL}/api/knowledge/lookup?key=${encodeURIComponent(key)}&value=${encodeURIComponent(value)}`,
  getKnowledgeData: (filename: string, limit = 50) => `${API_BASE_URL}/api/knowledge/data/${encodeURIComponent(filename)}?limit=${limit}`,
  deleteKnowledgeSource: (filename: string) => `${API_BASE_URL}/api/knowledge/sources/${encodeURIComponent(filename)}`,

  // Server-side background template training
  trainStart: () => `${API_BASE_URL}/api/knowledge/train-start`,
  trainJob: () => `${API_BASE_URL}/api/knowledge/train-job`,
  trainCancel: () => `${API_BASE_URL}/api/knowledge/train-cancel`,

  // Agent-composed email awaiting a human decision. The agent can only queue;
  // sending happens here, under the operator's own JWT.
  emailQueued: () => `${API_BASE_URL}/api/email/queued`,
  emailQueuedSend: (id: number | string) => `${API_BASE_URL}/api/email/queued/${id}/send`,
  emailQueuedDiscard: (id: number | string) => `${API_BASE_URL}/api/email/queued/${id}/discard`,

  // Legal Skills endpoints (playbooks the agent loads on demand)
  getSkills: () => `${API_BASE_URL}/api/skills`,
  getSkill: (name: string) => `${API_BASE_URL}/api/skills/${encodeURIComponent(name)}`,
  createSkill: () => `${API_BASE_URL}/api/skills`,
  updateSkill: (name: string) => `${API_BASE_URL}/api/skills/${encodeURIComponent(name)}`,
  deleteSkill: (name: string) => `${API_BASE_URL}/api/skills/${encodeURIComponent(name)}`,
  toggleSkill: (name: string) => `${API_BASE_URL}/api/skills/${encodeURIComponent(name)}/toggle`,
}

export default apiClient
