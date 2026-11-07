import { maxGroupMentions, type GroupMember, type GroupMemberPage } from '../types.ts';

export function bindDirectMentions(
  load: (groupId: string, cursor?: string) => Promise<GroupMemberPage>,
  onChange: () => void,
) {
  const root = document.getElementById('directMentions')!;
  const trigger = document.getElementById('pickDirectMembers') as HTMLButtonElement;
  const everyone = document.getElementById('mentionDirectEveryone') as HTMLButtonElement;
  const everyoneNote = document.getElementById('directEveryoneNote')!;
  const panel = document.getElementById('directMemberPicker')!;
  const search = document.getElementById('directMemberSearch') as HTMLInputElement;
  const results = document.getElementById('directMemberResults')!;
  const status = document.getElementById('directMemberStatus')!;
  const more = document.getElementById('moreDirectMembers') as HTMLButtonElement;
  const chips = document.getElementById('directMentionChips')!;
  const drafts = new Map<string, GroupMember[] | 'everyone'>();
  const members = new Map<string, GroupMember>();
  let draftKey = '', generation = 0;
  let groupId: string | undefined, cursor: string | undefined;
  let source: GroupMemberPage['source'] | undefined;
  let loading = false, sending = false, error = '';
  const selection = () => groupId ? drafts.get(draftKey) : undefined;
  const allSelected = () => selection() === 'everyone';
  const selected = () => {
    const value = selection();
    return Array.isArray(value) ? value : [];
  };
  const label = (member: GroupMember) => member.name || `成员 ${member.id.slice(-6)}`;

  function setOpen(open: boolean): void {
    panel.hidden = !open;
    trigger.setAttribute('aria-expanded', String(open));
  }

  function render(): void {
    trigger.disabled = everyone.disabled = search.disabled = sending;
    everyone.setAttribute('aria-pressed', String(allSelected()));
    everyoneNote.hidden = !allSelected();
    const current = selected();
    chips.replaceChildren(...current.map(member => {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.textContent = `@${label(member)} ×`;
      chip.title = member.id;
      chip.setAttribute('aria-label', `移除 @${label(member)}`);
      chip.disabled = sending;
      chip.onclick = () => {
        drafts.set(draftKey, current.filter(item => item.id !== member.id));
        render(); onChange(); trigger.focus();
      };
      return chip;
    }));
    if (panel.hidden) return;
    const query = search.value.trim().toLowerCase();
    const matches = [...members.values()].filter(member => [member.name, member.id].some(value => value?.toLowerCase().includes(query)));
    results.replaceChildren(...matches.map(member => {
      const option = document.createElement('button');
      option.type = 'button'; option.title = member.id;
      const name = document.createElement('span'); name.textContent = label(member);
      const id = document.createElement('small'); id.textContent = member.id.slice(-6);
      option.append(name, id);
      option.disabled = sending || current.length >= maxGroupMentions || current.some(item => item.id === member.id);
      option.onclick = () => {
        drafts.set(draftKey, [...current, member]);
        render(); onChange(); search.focus();
      };
      return option;
    }));
    more.hidden = !cursor;
    more.disabled = loading || sending;
    panel.setAttribute('aria-busy', String(loading));
    if (loading) status.textContent = '正在读取群成员…';
    else if (error) status.textContent = error;
    else if (current.length >= maxGroupMentions) status.textContent = `已选满 ${maxGroupMentions} 位成员。`;
    else if (members.size && !matches.length) status.textContent = '已加载的成员中没有匹配项。';
    else if (source === 'history') status.textContent = members.size ? '显示机器人从本群消息中识别到的成员。' : '还没有已知成员。成员发一条机器人能收到的群消息后会出现在这里。';
    else status.textContent = members.size ? '成员来自 QQ 群名单。' : '暂无可选群成员。';
  }

  async function loadPage(next?: string): Promise<void> {
    if (!groupId || loading || sending) return;
    const request = generation;
    loading = true; error = ''; render();
    try {
      const page = await load(groupId, next);
      if (request !== generation) return;
      for (const member of page.members) members.set(member.id, member);
      source = page.source;
      cursor = page.nextCursor === next ? undefined : page.nextCursor;
    } catch { if (request === generation) error = '读取群成员失败，请重新打开选择器重试。'; }
    finally { if (request === generation) { loading = false; render(); } }
  }

  trigger.onclick = () => {
    setOpen(panel.hidden);
    if (!panel.hidden) {
      search.focus();
      if (!source || error) void loadPage(cursor);
      else render();
    }
  };
  everyone.onclick = () => {
    if (allSelected()) drafts.delete(draftKey);
    else { drafts.set(draftKey, 'everyone'); setOpen(false); }
    render(); onChange();
  };
  more.onclick = () => { if (cursor) void loadPage(cursor); };
  search.oninput = render;
  search.onkeydown = event => {
    if (event.isComposing) return;
    if (event.key === 'Enter') { event.preventDefault(); results.querySelector<HTMLButtonElement>('button:enabled')?.click(); }
    if (event.key === 'Escape') { event.preventDefault(); setOpen(false); trigger.focus(); }
  };
  return {
    setTarget(key: string, id?: string) {
      generation++; draftKey = key; groupId = id;
      members.clear(); cursor = source = undefined;
      loading = false; error = ''; search.value = ''; root.hidden = !groupId;
      setOpen(false); render();
    },
    value: () => ({ memberIds: selected().map(member => member.id), everyone: allSelected() }),
    hasSelection: () => allSelected() || selected().length > 0,
    setSending(value: boolean) { sending = value; render(); },
    clear() { drafts.delete(draftKey); render(); onChange(); },
  };
}
