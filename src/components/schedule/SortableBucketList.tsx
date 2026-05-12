"use client";

import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";

function SortableRow({
  id,
  children,
}: {
  id: string;
  children: React.ReactNode;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id });
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.85 : 1,
  };
  return (
    <li
      ref={setNodeRef}
      style={style}
      className="flex gap-2 rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm dark:border-zinc-800 dark:bg-zinc-950"
    >
      <button
        type="button"
        className="cursor-grab touch-none text-zinc-400 hover:text-zinc-600 active:cursor-grabbing dark:hover:text-zinc-300"
        aria-label="Drag to reorder"
        {...attributes}
        {...listeners}
      >
        ⋮⋮
      </button>
      <div className="min-w-0 flex-1">{children}</div>
    </li>
  );
}

export function SortableBucketList({
  bucketKey,
  orderedIds,
  label,
  renderItem,
  onReorder,
}: {
  bucketKey: string;
  orderedIds: string[];
  label: string;
  renderItem: (scheduleEntryId: string) => React.ReactNode;
  onReorder: (nextIds: string[]) => void;
}) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const oldIndex = orderedIds.indexOf(String(active.id));
    const newIndex = orderedIds.indexOf(String(over.id));
    if (oldIndex < 0 || newIndex < 0) return;
    onReorder(arrayMove(orderedIds, oldIndex, newIndex));
  };

  return (
    <section className="rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
      <h4 className="mb-2 font-medium text-zinc-800 dark:text-zinc-100">{label}</h4>
      <p className="mb-2 font-mono text-xs text-zinc-500">{bucketKey}</p>
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
        <SortableContext items={orderedIds} strategy={verticalListSortingStrategy}>
          <ul className="flex flex-col gap-2">
            {orderedIds.map((id) => (
              <SortableRow key={id} id={id}>
                {renderItem(id)}
              </SortableRow>
            ))}
          </ul>
        </SortableContext>
      </DndContext>
    </section>
  );
}
