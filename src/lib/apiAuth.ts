export interface OperatorSession {
  id: string;
  username: string;
  fullName: string;
  role: string;
  sessionToken?: string;
}

let currentOperator: OperatorSession | null = null;

export function setCurrentOperatorSession(session: OperatorSession | null) {
  currentOperator = session;
}

export function getAuthHeaders(extra?: Record<string, string>): Record<string, string> {
  const headers: Record<string, string> = { ...(extra ?? {}) };
  if (currentOperator?.sessionToken) {
    headers.Authorization = `Bearer ${currentOperator.sessionToken}`;
  }
  return headers;
}
