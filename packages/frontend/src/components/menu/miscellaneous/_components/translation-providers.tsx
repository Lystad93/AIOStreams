/**
 * LLM providers for subtitle translation, presented like Services: an ordered,
 * draggable list where each row toggles on/off and opens a settings modal.
 *
 * Order is the feature, not decoration — it is the failover order. The first
 * enabled provider with a key does the work, and the next takes over mid-file
 * when one is rate-limited or erroring.
 */
import { useUserData } from '@/context/userData';
import { useEffect, useState } from 'react';
import { restrictToVerticalAxis } from '@dnd-kit/modifiers';
import {
  arrayMove,
  SortableContext,
  verticalListSortingStrategy,
  useSortable,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import {
  DndContext,
  useSensors,
  PointerSensor,
  TouchSensor,
  useSensor,
  type DragEndEvent,
} from '@dnd-kit/core';
import { FiSettings } from 'react-icons/fi';
import { Button, IconButton } from '../../../ui/button';
import { Switch } from '../../../ui/switch';
import { Modal } from '../../../ui/modal';
import { TextInput } from '../../../ui/text-input';
import { PasswordInput } from '../../../ui/password-input/password-input';
import {
  TRANSLATION_PROVIDERS,
  TRANSLATION_PROVIDER_IDS,
  type TranslationProviderId,
} from '../../../../../../core/src/utils/constants';

type ProviderEntry = {
  id: TranslationProviderId;
  enabled?: boolean;
  apiKey?: string;
  model?: string;
  baseUrl?: string;
};

/**
 * Every provider, in the user's saved order, with unconfigured ones appended.
 *
 * Showing all of them (rather than only those added) is what makes the list
 * self-explanatory: the failover order is visible before anything is set up,
 * and adding a fallback is one toggle rather than a separate "add" flow.
 */
function mergeWithAll(saved: ProviderEntry[] | undefined): ProviderEntry[] {
  const bySaved = new Map((saved ?? []).map((p) => [p.id, p]));
  const ordered = (saved ?? []).filter((p) =>
    TRANSLATION_PROVIDER_IDS.includes(p.id)
  );
  for (const id of TRANSLATION_PROVIDER_IDS) {
    if (!bySaved.has(id)) ordered.push({ id, enabled: false });
  }
  return ordered;
}

export function TranslationProviders({ disabled }: { disabled?: boolean }) {
  const { userData, setUserData } = useUserData();
  const [modalId, setModalId] = useState<TranslationProviderId | null>(null);

  const providers = mergeWithAll(
    userData.subtitleTranslation?.providers as ProviderEntry[] | undefined
  );

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(TouchSensor, {
      activationConstraint: { delay: 200, tolerance: 5 },
    })
  );

  const write = (next: ProviderEntry[]) => {
    setUserData((prev) => ({
      ...prev,
      subtitleTranslation: { ...prev.subtitleTranslation, providers: next },
    }));
  };

  const update = (id: TranslationProviderId, patch: Partial<ProviderEntry>) => {
    write(providers.map((p) => (p.id === id ? { ...p, ...patch } : p)));
  };

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const from = providers.findIndex((p) => p.id === active.id);
    const to = providers.findIndex((p) => p.id === over.id);
    if (from < 0 || to < 0) return;
    write(arrayMove(providers, from, to));
  };

  const active = providers.filter((p) => p.enabled && p.apiKey?.trim());

  return (
    <div className="space-y-3">
      <div className="flex flex-col gap-1">
        <span className="text-sm font-medium">Providers</span>
        <span className="text-xs text-[--muted]">
          Drag to set the failover order. The topmost enabled provider with a
          key translates; if it hits its rate limit or errors, the next one
          continues from where it stopped.
        </span>
      </div>

      <DndContext
        modifiers={[restrictToVerticalAxis]}
        onDragEnd={handleDragEnd}
        sensors={sensors}
      >
        <SortableContext
          items={providers.map((p) => p.id)}
          strategy={verticalListSortingStrategy}
        >
          <ul className="space-y-2">
            {providers.map((provider, index) => (
              <SortableProviderItem
                key={provider.id}
                provider={provider}
                // Only meaningful among providers that can actually run.
                order={
                  provider.enabled && provider.apiKey?.trim()
                    ? active.findIndex((p) => p.id === provider.id) + 1
                    : 0
                }
                disabled={disabled}
                onEdit={() => setModalId(provider.id)}
                onToggleEnabled={(v) => update(provider.id, { enabled: v })}
              />
            ))}
          </ul>
        </SortableContext>
      </DndContext>

      {active.length === 0 && (
        <p className="text-xs text-[--muted]">
          No provider is usable yet — enable one and add its API key.
        </p>
      )}

      <ProviderModal
        open={modalId !== null}
        onOpenChange={(v) => !v && setModalId(null)}
        provider={providers.find((p) => p.id === modalId) ?? null}
        onSave={(values) => {
          if (modalId) update(modalId, values);
          setModalId(null);
        }}
        onClose={() => setModalId(null)}
      />
    </div>
  );
}

function ProviderRow({
  provider,
  order,
  disabled,
  onEdit,
  onToggleEnabled,
  dragHandleProps,
}: {
  provider: ProviderEntry;
  order: number;
  disabled?: boolean;
  onEdit: () => void;
  onToggleEnabled: (v: boolean) => void;
  dragHandleProps?: { attributes: any; listeners: any } | null;
}) {
  const meta = TRANSLATION_PROVIDERS[provider.id];
  const hasKey = !!provider.apiKey?.trim();

  return (
    <div className="px-3 py-2.5 bg-[var(--background)] rounded-[--radius-md] border flex gap-3 items-center relative">
      {dragHandleProps ? (
        <div
          className="rounded-full w-6 h-auto self-stretch flex-shrink-0 bg-[--muted] md:bg-[--subtle] md:hover:bg-[--subtle-highlight] cursor-move"
          {...dragHandleProps.attributes}
          {...dragHandleProps.listeners}
        />
      ) : (
        <div className="w-6 flex-shrink-0" />
      )}
      <div className="flex-1 flex flex-col justify-center min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="font-semibold text-sm truncate">{meta.name}</span>
          {order > 0 && (
            <span className="text-xs px-1.5 py-0.5 rounded-full font-medium shrink-0 bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400">
              {order === 1 ? 'Primary' : `Fallback ${order - 1}`}
            </span>
          )}
          {provider.enabled && !hasKey && (
            <span className="text-xs px-1.5 py-0.5 rounded-full font-medium shrink-0 bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400">
              No API key
            </span>
          )}
        </div>
        <span className="text-xs text-[--muted] font-normal line-clamp-1">
          {provider.model?.trim() ||
            meta.defaultModel ||
            'Set a model in settings'}
        </span>
      </div>
      <div className="flex items-center gap-2 shrink-0">
        <Switch
          value={!!provider.enabled}
          onValueChange={onToggleEnabled}
          disabled={disabled}
        />
        <IconButton
          intent="gray-outline"
          size="sm"
          onClick={onEdit}
          disabled={disabled}
          icon={<FiSettings />}
        />
      </div>
    </div>
  );
}

function SortableProviderItem(props: {
  provider: ProviderEntry;
  order: number;
  disabled?: boolean;
  onEdit: () => void;
  onToggleEnabled: (v: boolean) => void;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: props.provider.id });
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };
  return (
    <li ref={setNodeRef} style={style}>
      <ProviderRow {...props} dragHandleProps={{ attributes, listeners }} />
    </li>
  );
}

function ProviderModal({
  open,
  onOpenChange,
  provider,
  onSave,
  onClose,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  provider: ProviderEntry | null;
  onSave: (values: Partial<ProviderEntry>) => void;
  onClose: () => void;
}) {
  const [values, setValues] = useState<Partial<ProviderEntry>>({});

  useEffect(() => {
    if (open && provider) {
      setValues({
        apiKey: provider.apiKey ?? '',
        model: provider.model ?? '',
        baseUrl: provider.baseUrl ?? '',
      });
    }
  }, [open, provider]);

  if (!provider) return null;
  const meta = TRANSLATION_PROVIDERS[provider.id];

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={`Configure ${meta.name}`}
    >
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          onSave({
            apiKey: values.apiKey?.trim() || undefined,
            model: values.model?.trim() || undefined,
            baseUrl: values.baseUrl?.trim() || undefined,
            // Saving a key is the point of opening this, so don't make the user
            // also remember to flip the switch.
            enabled: values.apiKey?.trim() ? true : provider.enabled,
          });
        }}
      >
        <PasswordInput
          label="API key"
          autoComplete="off"
          help={
            meta.signUpUrl
              ? `Your own key, stored with your configuration and never shared. Get one at ${meta.signUpUrl}`
              : 'Your own key, stored with your configuration and never shared.'
          }
          value={values.apiKey ?? ''}
          onValueChange={(v) => setValues((prev) => ({ ...prev, apiKey: v }))}
        />
        {meta.needsBaseUrl && (
          <TextInput
            label="Base URL"
            placeholder="http://localhost:11434/v1"
            help="OpenAI-compatible endpoint, including the version path."
            value={values.baseUrl ?? ''}
            onValueChange={(v) =>
              setValues((prev) => ({ ...prev, baseUrl: v }))
            }
          />
        )}
        <TextInput
          label="Model"
          placeholder={meta.defaultModel || 'model id'}
          help="Leave blank to use the provider default."
          value={values.model ?? ''}
          onValueChange={(v) => setValues((prev) => ({ ...prev, model: v }))}
        />
        <div className="flex gap-2">
          <Button
            type="button"
            className="w-full"
            intent="primary-outline"
            onClick={onClose}
          >
            Cancel
          </Button>
          <Button type="submit" className="w-full">
            Save
          </Button>
        </div>
      </form>
    </Modal>
  );
}
