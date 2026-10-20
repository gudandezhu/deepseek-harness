import { NEW_SESSION_LABELS, UNGROUPED_ROW_KEY } from '../constants'

/** 官方侧边栏「新建会话」按钮的 aria-label 判据（品牌按钮与工具栏按钮共用同一条文案）。 */
export function isNewSessionLabel(label: string | null): boolean {
  return label !== null && (NEW_SESSION_LABELS as readonly string[]).includes(label)
}

/** 官方工作区分组行的「+」用带工作区名字的文案，不在判据内，因此行为不受拦截影响。 */
export function newSessionButtonFrom(target: unknown): Element | null {
  if (!(target instanceof Element))
    return null
  const button = target.closest('button[aria-label]')
  return button !== null && isNewSessionLabel(button.getAttribute('aria-label')) ? button : null
}

export function ungroupedCreateButtonFrom(target: unknown): Element | null {
  if (!(target instanceof Element))
    return null
  const button = target.closest('button[aria-label]')
  if (button === null)
    return null
  const row = button.closest('[data-row-key]')
  return row?.getAttribute('data-row-key') === UNGROUPED_ROW_KEY ? button : null
}
