import {
  Decoration,
  DecorationSet,
  EditorView,
  ViewPlugin,
  ViewUpdate,
} from '@codemirror/view';
import { RangeSetBuilder } from '@codemirror/state';
import {
  tokenizeCel,
  type CelTokenKind,
} from '../../../../../../../core/src/variants/language';

const KIND_CLASS: Record<CelTokenKind, string> = {
  comment: 'cmv-comment',
  verb: 'cmv-verb',
  root: 'cmv-root',
  property: 'cmv-property',
  operator: 'cmv-operator',
  string: 'cmv-string',
  number: 'cmv-number',
  keyword: 'cmv-keyword',
  punct: 'cmv-punct',
};

function buildDecorations(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  // tokens come back sorted and non-overlapping, which RangeSetBuilder requires
  for (const token of tokenizeCel(view.state.doc.toString())) {
    builder.add(
      token.start,
      token.end,
      Decoration.mark({ class: KIND_CLASS[token.kind] })
    );
  }
  return builder.finish();
}

export const celHighlight = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = buildDecorations(view);
    }
    update(update: ViewUpdate) {
      if (update.docChanged) this.decorations = buildDecorations(update.view);
    }
  },
  { decorations: (v) => v.decorations }
);

/**
 * Layered on top of `formatterTheme`, which styles no gutter because that
 * editor runs with line numbers off.
 */
export const celTheme = EditorView.theme({
  '.cm-content': { caretColor: 'transparent' },
  '.cm-cursor, .cm-dropCursor': {
    borderLeftColor: 'var(--foreground)',
    borderLeftWidth: '1px',
  },
  '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': {
    backgroundColor: 'color-mix(in srgb, var(--ring) 30%, transparent)',
  },

  '.cm-gutters': {
    backgroundColor: 'transparent',
    border: 'none',
    color: 'var(--muted)',
    opacity: '0.6',
  },
  '.cm-lineNumbers .cm-gutterElement': {
    padding: '0 0.5rem 0 0.75rem',
    minWidth: '2ch',
  },
  '.cm-activeLineGutter': { backgroundColor: 'transparent' },
  '.cm-gutter-lint': { width: '1rem' },

  '.cmv-comment': { color: 'var(--muted)', fontStyle: 'italic' },
  '.cmv-verb': { color: 'var(--violet)', fontWeight: '600' },
  '.cmv-root': { color: 'var(--sky)', fontWeight: '500' },
  '.cmv-property': { color: 'var(--blue)' },
  '.cmv-operator': { color: 'var(--amber)', fontWeight: '600' },
  '.cmv-string': { color: 'var(--green)' },
  '.cmv-number': { color: 'var(--teal)' },
  '.cmv-keyword': { color: 'var(--rose)' },
  '.cmv-punct': { color: 'var(--muted)' },
});
