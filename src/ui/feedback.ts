export type FeedbackTone = 'info' | 'pending' | 'success' | 'error';

export function showFeedback(element: HTMLElement, text: string, tone: FeedbackTone = 'info'): void {
  if (element.textContent !== text) element.textContent = text;
  element.dataset.feedback = tone;
}

export function showModuleBadge(module: string, text: string, tone: FeedbackTone = 'info'): void {
  const button = document.querySelector<HTMLButtonElement>(`#settingsNavigation [data-tab="${module}"]`)!;
  let badge = button.querySelector<HTMLElement>('.settings-module-state');
  if (!badge) {
    badge = document.createElement('span');
    badge.className = 'settings-module-state';
    button.firstElementChild?.after(badge);
  }
  badge.hidden = !text;
  showFeedback(badge, text, tone);
}
