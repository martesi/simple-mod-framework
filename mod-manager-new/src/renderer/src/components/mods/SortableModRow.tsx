import { useSortable } from "@dnd-kit/sortable"
import { CSS } from "@dnd-kit/utilities"
import { ModRow, type ModRowProps } from "./ModRow"

export function SortableModRow(props: Omit<ModRowProps, "dragHandleProps" | "style" | "setNodeRef" | "dragging"> & { id: string; dragDisabled?: boolean }) {
  const { id, dragDisabled, ...rest } = props
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id, disabled: dragDisabled })

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
