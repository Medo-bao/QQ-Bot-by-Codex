import { permissionChoices, permissionMode, permissionPatch, type PermissionMode } from '../permissions.ts';

const icons = {
  request: '<path d="M7 9V4.5a1.25 1.25 0 0 1 2.5 0V9m0-4.5a1.25 1.25 0 0 1 2.5 0V9m0-3a1.25 1.25 0 0 1 2.5 0v6.5a5 5 0 0 1-10 0V10a1.25 1.25 0 0 1 2.5 0"/>',
  auto: '<path d="m10 2 6 2.5V10a7 7 0 0 1-6 7 7 7 0 0 1-6-7V4.5L10 2Z"/><path d="m7.5 9.5 1.8 1.8 3.4-3.6"/>',
  full: '<path d="m10 2 6 2.5V10a7 7 0 0 1-6 7 7 7 0 0 1-6-7V4.5L10 2Z"/><path d="M10 6v4m0 3v.1"/>',
  inherit: '<path d="M4 6h11l-3-3M16 14H5l3 3M4 6v5m12 3V9"/>',
  custom: '<path d="M4 5h12M4 10h12M4 15h12M7 3v4m6 1v4m-5 1v4"/>',
};
const icon = (mode: PermissionMode): string => `<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[mode]}</svg>`;
let sequence = 0;

export function closePermissionMenus(): void {
  document.querySelectorAll<HTMLElement>('.permission-menu').forEach(menu => { menu.hidden = true; });
  document.querySelectorAll<HTMLElement>('.permission-trigger').forEach(trigger => trigger.setAttribute('aria-expanded', 'false'));
}

export function permissionPicker(values: Record<string, any>, controls: HTMLElement, changed: () => void, session = false, globalValues?: Record<string, any>) {
  const root = document.createElement('div'); root.className = 'field wide permission-picker';
  const label = document.createElement('span'); label.textContent = '权限模式';
  const trigger = document.createElement('button'); trigger.type = 'button'; trigger.className = 'permission-trigger'; trigger.dataset.field = 'permissionMode';
  trigger.setAttribute('aria-label', '权限模式'); trigger.setAttribute('aria-haspopup', 'menu'); trigger.setAttribute('aria-expanded', 'false');
  const menu = document.createElement('div'); menu.className = 'permission-menu'; menu.id = `permission-menu-${++sequence}`; menu.hidden = true;
  menu.setAttribute('role', 'menu'); menu.setAttribute('aria-label', '选择权限模式'); trigger.setAttribute('aria-controls', menu.id);
  const description = document.createElement('small');
  const choices: Array<{ id: Exclude<PermissionMode, 'custom'>; label: string; description: string }> = [
    ...(session ? [{ id: 'inherit' as const, label: '跟随全局设置', description: '使用 QQ Bot 的全局权限模式' }] : []), ...permissionChoices,
  ];
  const close = (focus = false) => { menu.hidden = true; trigger.setAttribute('aria-expanded', 'false'); if (focus) trigger.focus(); };
  const refresh = (disabled = trigger.disabled) => {
    const mode = permissionMode(values, session);
    if (mode === 'full') Object.assign(values, permissionPatch('full', session));
    const inherited = mode === 'inherit' ? permissionMode(globalValues || {}) : undefined;
    const selected = choices.find(choice => choice.id === mode);
    const title = selected?.label || '自定义权限';
    trigger.dataset.mode = mode; trigger.innerHTML = icon(mode);
    const text = document.createElement('span'); text.textContent = title;
    const chevron = document.createElement('span'); chevron.className = 'permission-trigger-chevron'; chevron.innerHTML = '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="m4 6 4 4 4-4" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    trigger.append(text, chevron); trigger.disabled = disabled;
    description.textContent = inherited ? `当前全局：${permissionChoices.find(choice => choice.id === inherited)?.label || '自定义权限'}` : selected?.description || '使用下方的自定义权限设置';
    for (const button of menu.querySelectorAll<HTMLButtonElement>('[data-permission-mode]')) button.setAttribute('aria-checked', String(button.dataset.permissionMode === mode));
    for (const path of ['sandbox', 'approvalPolicy', 'approvalsReviewer', 'networkAccess']) {
      const input = controls.querySelector<HTMLInputElement | HTMLSelectElement>(`[data-field="${path}"]`);
      if (!input) continue;
      if (input instanceof HTMLInputElement && input.type === 'checkbox') input.checked = Boolean(values[path]); else input.value = String(values[path] ?? '');
      input.disabled = disabled || (mode === 'full' && path !== 'sandbox');
    }
    if (disabled) close();
  };
  for (const choice of choices) {
    const option = document.createElement('button'); option.type = 'button'; option.className = 'permission-option'; option.dataset.permissionMode = choice.id;
    option.setAttribute('role', 'menuitemradio'); option.innerHTML = icon(choice.id);
    const body = document.createElement('span'); body.className = 'permission-option-body';
    const title = document.createElement('strong'); title.textContent = choice.label;
    const help = document.createElement('small'); help.textContent = choice.description; body.append(title, help);
    const check = document.createElement('span'); check.className = 'permission-check'; check.textContent = '✓'; option.append(body, check);
    option.onclick = () => { Object.assign(values, permissionPatch(choice.id, session)); refresh(); changed(); close(true); };
    menu.append(option);
  }
  trigger.onclick = () => {
    if (!menu.hidden) { close(true); return; }
    closePermissionMenus(); menu.hidden = false; trigger.setAttribute('aria-expanded', 'true');
    const rect = trigger.getBoundingClientRect();
    menu.style.left = `${Math.max(12, Math.min(rect.left, innerWidth - menu.offsetWidth - 12))}px`;
    menu.style.top = `${Math.max(12, Math.min(rect.bottom + 7, innerHeight - menu.offsetHeight - 12))}px`;
    (menu.querySelector<HTMLButtonElement>('[aria-checked="true"]') || menu.querySelector('button'))?.focus();
  };
  trigger.onkeydown = event => { if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); if (menu.hidden) trigger.click(); } };
  menu.onkeydown = event => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(true); }
    else if (event.key === 'Tab') close(true);
    else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      event.preventDefault(); const buttons = [...menu.querySelectorAll<HTMLButtonElement>('button')]; const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (current + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
      buttons[next]?.focus();
    }
  };
  root.append(label, trigger, description, menu); refresh();
  return { element: root, refresh };
}
