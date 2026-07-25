import { useEffect, useState } from 'react';
import {
  DndContext,
  useSensors,
  useSensor,
  PointerSensor,
  TouchSensor,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  useSortable,
  arrayMove,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { restrictToVerticalAxis } from '@dnd-kit/modifiers';
import { CSS } from '@dnd-kit/utilities';
import { IconButton } from '../ui/button';
import { FaRegTrashAlt } from 'react-icons/fa';

/**
 * A drag-to-reorder priority list, matching the "Preference Order" panel used
 * by the filters menu. Order is meaningful (first = highest priority), so the
 * list must be reorderable rather than a plain multi-select.
 */
export function SortableList({
  items,
  labelFor,
  onChange,
  disabled,
}: {
  items: string[];
  /** Display name for a value (falls back to the raw value). */
  labelFor?: (value: string) => string;
  onChange: (next: string[]) => void;
  disabled?: boolean;
}) {
  const [isDragging, setIsDragging] = useState(false);

  const sensors = useSensors(
    useSensor(PointerSensor),
    useSensor(TouchSensor, {
      activationConstraint: { delay: 150, tolerance: 8 },
    })
  );

  // Dragging on touch devices would otherwise scroll the page under the item.
  useEffect(() => {
    function preventTouchMove(e: TouchEvent) {
      if (isDragging) e.preventDefault();
    }
    function stop() {
      setIsDragging(false);
    }
    if (isDragging) {
      document.body.addEventListener('touchmove', preventTouchMove, {
        passive: false,
      });
      document.addEventListener('pointerup', stop);
      document.addEventListener('touchend', stop);
    }
    return () => {
      document.body.removeEventListener('touchmove', preventTouchMove);
      document.removeEventListener('pointerup', stop);
      document.removeEventListener('touchend', stop);
    };
  }, [isDragging]);

  if (items.length === 0) return null;

  const handleDragEnd = (event: DragEndEvent) => {
    setIsDragging(false);
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const from = items.indexOf(String(active.id));
    const to = items.indexOf(String(over.id));
    if (from === -1 || to === -1) return;
    onChange(arrayMove(items, from, to));
  };

  return (
    <div className={disabled ? 'opacity-50 pointer-events-none' : undefined}>
      <DndContext
        modifiers={[restrictToVerticalAxis]}
        sensors={sensors}
        onDragStart={() => setIsDragging(true)}
        onDragEnd={handleDragEnd}
      >
        <SortableContext items={items} strategy={verticalListSortingStrategy}>
          <div className="space-y-2">
            {items.map((value, index) => (
              <SortableListItem
                key={value}
                id={value}
                position={index + 1}
                name={labelFor?.(value) ?? value}
                onDelete={() => onChange(items.filter((v) => v !== value))}
              />
            ))}
          </div>
        </SortableContext>
      </DndContext>
    </div>
  );
}

function SortableListItem({
  id,
  name,
  position,
  onDelete,
}: {
  id: string;
  name: string;
  position: number;
  onDelete: () => void;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };

  return (
    <div ref={setNodeRef} style={style}>
      <div className="px-2.5 py-2 bg-[var(--background)] rounded-[--radius-md] border flex gap-3 relative items-center">
        <div
          className="rounded-full w-6 h-6 bg-[--muted] md:bg-[--subtle] md:hover:bg-[--subtle-highlight] cursor-move flex-shrink-0"
          {...attributes}
          {...listeners}
        />
        <span className="text-xs text-[--muted] tabular-nums w-4 flex-shrink-0">
          {position}
        </span>
        <div className="flex-1 flex flex-col justify-center min-w-0">
          <span className="font-mono text-base truncate">{name}</span>
        </div>
        <div className="flex-shrink-0 ml-auto">
          <IconButton
            size="sm"
            rounded
            icon={<FaRegTrashAlt />}
            intent="alert-subtle"
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              onDelete();
            }}
          />
        </div>
      </div>
    </div>
  );
}
