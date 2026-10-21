import type { TaskProcess } from '@/types'
import { DisplayPulse } from '@gravity-ui/icons'
import { Button, Popover } from '@heroui/react'
import { useOverlay } from '@overlastic/react'
import { useQuery } from '@tanstack/react-query'
import { invoke } from '@tauri-apps/api/core'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { If } from 'react-if-lite'
import { queryKeys } from '@/config/query-keys'
import { TaskManagerDialog } from '@/ui/dialog/task-manager'
import { formatMemory, groupMemory, MEMORY_GROUPS, totalMemory } from '@/utils/process-memory'

/**
 * 右下角常驻内存读数：图标 + 桌面进程树总内存，点击展开
 * 桌面 / session-worker / 其他 三组明细，并可打开完整任务管理器。
 * 数据与任务管理器共用 `queryKeys.taskManager` 缓存。
 */
export function MemoryIndicator() {
  const { t, i18n } = useTranslation()
  const openTaskManager = useOverlay(TaskManagerDialog)
  const [open, setOpen] = useState(false)
  const processes = useQuery({
    queryKey: queryKeys.taskManager,
    queryFn: () => invoke<TaskProcess[]>('get_task_manager_processes'),
    refetchInterval: 5000,
    retry: false,
  })
  const all = processes.data ?? []
  const total = totalMemory(all)
  const groups = groupMemory(all)

  return (
    <Popover isOpen={open} onOpenChange={setOpen}>
      <Button
        className="fixed right-3 bottom-3 z-40 h-7 gap-1.5 rounded-full border border-line/60 bg-panel2/85 px-2.5 text-[11px] tabular-nums text-secondary shadow-sm backdrop-blur"
        size="sm"
        variant="ghost"
        aria-label={`${t('memory_indicator.label')} ${processes.data === undefined ? '' : formatMemory(total, i18n.language)}`}
        data-testid="dsh-memory-indicator"
      >
        <DisplayPulse className="size-3.5" />
        <If cond={processes.data !== undefined} else="—">
          {formatMemory(total, i18n.language)}
        </If>
      </Button>

      <Popover.Content placement="top end" className="w-64!" data-testid="dsh-memory-popover">
        <Popover.Dialog className="space-y-2">
          <Popover.Heading className="text-xs">{t('memory_indicator.title')}</Popover.Heading>
          <div className="space-y-1.5">
            {MEMORY_GROUPS.map((group) => {
              const usage = groups.find(entry => entry.group === group)
              return (
                <div key={group} className="flex items-center justify-between gap-3 text-xs">
                  <span className="text-muted">{t(`memory_indicator.group.${group}`)}</span>
                  <span className="flex items-baseline gap-2 tabular-nums text-ink">
                    <If cond={group === 'session-worker' && (usage?.count ?? 0) > 0}>
                      <span className="text-[10px] text-muted">{`×${String(usage?.count ?? 0)}`}</span>
                    </If>
                    <span>{formatMemory(usage?.bytes ?? 0, i18n.language)}</span>
                  </span>
                </div>
              )
            })}
          </div>
          <div className="flex items-center justify-between border-t border-line/50 pt-2 text-xs">
            <span className="text-muted">{t('memory_indicator.total')}</span>
            <span className="font-medium tabular-nums text-ink">{formatMemory(total, i18n.language)}</span>
          </div>
          <Button
            className="h-7 w-full justify-center text-xs"
            size="sm"
            variant="secondary"
            onPress={() => {
              setOpen(false)
              openTaskManager()
            }}
          >
            {t('menu.task_manager')}
          </Button>
        </Popover.Dialog>
      </Popover.Content>
    </Popover>
  )
}
