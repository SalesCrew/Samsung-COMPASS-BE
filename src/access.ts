export type AccountRole = 'app_admin' | 'department_admin' | 'sec' | 'supervisor';

export function isAdminRole(role: AccountRole) {
  return role === 'app_admin' || role === 'department_admin';
}

/** Supervisors can inspect SEC dashboards and manage only their own login/privacy. */
export function supervisorRouteAllowed(route: string, method: string) {
  if (method === 'GET') return ['/me', '/dashboard', '/supervisor/people', '/privacy/requests', '/privacy/export'].includes(route);
  return method === 'POST' && ['/auth/logout', '/auth/password', '/notice', '/privacy/requests'].includes(route);
}
