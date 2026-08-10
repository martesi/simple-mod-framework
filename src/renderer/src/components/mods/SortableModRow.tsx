import { useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { memo } from 'react'
import { ModRow, type ModRowProps } from './ModRow'

function SortableModRowImpl(
  props: Omit<ModRowProps, 'dragHandleProps' | 'style' | 'setNodeRef' | 'dragging'> & {
    id: string
    dragDisabled?: boolean
  }
) {
  const { id, dragDisabled, ...rest } = props
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id,
    disabled: dragDisabled,
  })

  return (
    <ModRow
      {...rest}
      setNodeRef={setNodeRef}
      dragging={isDragging}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      dragHandleProps={{ ...attributes, ...listeners }}
    />
  )
}

/**
 * Memoized for the same reason ModRow.tsx is: without it, React still calls this component (and
 * so its useSortable() hook - not free, it subscribes to shared DndContext state) for every row on
 * every ModsScreen re-render, even though ModRow itself bails out further down. Only effective
 * because ModsScreen.tsx passes stable callback references - see ModRow.tsx's doc comment.
 */
export const SortableModRow = memo(SortableModRowImpl)
