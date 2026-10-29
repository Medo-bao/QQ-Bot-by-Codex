export type PermissionMode = 'request' | 'auto' | 'full' | 'inherit' | 'custom';
export const permissionChoices = [
  { id: 'request', label: '请求批准', description: '编辑工作区外的文件或申请联网时询问' },
  { id: 'auto', label: '帮我批准', description: '由 Codex 自动审核，仅在需要时请求批准' },
  { id: 'full', label: '完全访问权限', description: '可访问互联网和本机文件，不再请求操作批准' },
] as const;

export function permissionMode(values: { sandbox?: string; approvalPolicy?: string; approvalsReviewer?: string; networkAccess?: boolean | string }, inherit = false): PermissionMode {
  if (inherit && !values.sandbox && !values.approvalPolicy && !values.approvalsReviewer && !values.networkAccess) return 'inherit';
  if (values.sandbox === 'danger-full-access') return 'full';
  if (values.sandbox !== 'workspace-write' || values.approvalPolicy !== 'on-request' || values.networkAccess === true || values.networkAccess === 'enabled') return 'custom';
  return values.approvalsReviewer === 'auto_review' ? 'auto' : 'request';
}

export function permissionPatch(mode: Exclude<PermissionMode, 'custom'>, session = false) {
  if (mode === 'inherit') return { sandbox: '', approvalPolicy: '', approvalsReviewer: '', networkAccess: '' };
  const full = mode === 'full';
  return { sandbox: full ? 'danger-full-access' : 'workspace-write', approvalPolicy: full ? 'never' : 'on-request',
    approvalsReviewer: mode === 'auto' ? 'auto_review' : 'user', networkAccess: session ? full ? 'enabled' : 'disabled' : full };
}

export function normalizePermissions<T extends { sandbox: string; approvalPolicy: string; approvalsReviewer: string; networkAccess: boolean }>(permissions: T): T {
  return permissions.sandbox === 'danger-full-access'
    ? { ...permissions, approvalPolicy: 'never', approvalsReviewer: 'user', networkAccess: true } : permissions;
}
