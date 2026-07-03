import { describe, it, expect } from 'vitest';
import { matchShortcut, SHORTCUTS, type FocusContext, type KeyChord } from './shortcuts';

function chord(over: Partial<KeyChord>): KeyChord {
  return { key: 'a', ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...over };
}

describe('matchShortcut — global chords (any focus)', () => {
  for (const focus of ['editor', 'input', 'none'] as FocusContext[]) {
    it(`palette / save / theme / presentation resolve under focus=${focus}`, () => {
      expect(matchShortcut(chord({ ctrlKey: true, key: 'k' }), focus)).toBe('palette');
      expect(matchShortcut(chord({ metaKey: true, key: 'k' }), focus)).toBe('palette');
      expect(matchShortcut(chord({ ctrlKey: true, key: 's' }), focus)).toBe('save');
      expect(matchShortcut(chord({ ctrlKey: true, altKey: true, key: 't' }), focus)).toBe('theme');
      expect(matchShortcut(chord({ ctrlKey: true, shiftKey: true, key: 'p' }), focus)).toBe(
        'presentation',
      );
    });
  }
});

describe('matchShortcut — format', () => {
  it('Ctrl+Shift+F formats in any focus', () => {
    expect(matchShortcut(chord({ ctrlKey: true, shiftKey: true, key: 'f' }), 'editor')).toBe(
      'format',
    );
    expect(matchShortcut(chord({ ctrlKey: true, shiftKey: true, key: 'f' }), 'none')).toBe(
      'format',
    );
  });
  it('Ctrl+I formats only when NOT in the editor (editor binds it locally)', () => {
    expect(matchShortcut(chord({ ctrlKey: true, key: 'i' }), 'editor')).toBeNull();
    expect(matchShortcut(chord({ ctrlKey: true, key: 'i' }), 'input')).toBe('format');
    expect(matchShortcut(chord({ ctrlKey: true, key: 'i' }), 'none')).toBe('format');
  });
});

describe('matchShortcut — run', () => {
  it('Ctrl/Cmd+Enter runs ONLY when focus is nowhere', () => {
    expect(matchShortcut(chord({ ctrlKey: true, key: 'Enter' }), 'none')).toBe('run');
    expect(matchShortcut(chord({ metaKey: true, key: 'Enter' }), 'none')).toBe('run');
    // The editor + variable input own Ctrl+Enter themselves.
    expect(matchShortcut(chord({ ctrlKey: true, key: 'Enter' }), 'editor')).toBeNull();
    expect(matchShortcut(chord({ ctrlKey: true, key: 'Enter' }), 'input')).toBeNull();
  });
});

describe('matchShortcut — non-matches', () => {
  it('plain keys and unmodified chords return null', () => {
    expect(matchShortcut(chord({ key: 'k' }), 'none')).toBeNull();
    expect(matchShortcut(chord({ key: 'Enter' }), 'none')).toBeNull();
    expect(matchShortcut(chord({ altKey: true, key: 's' }), 'none')).toBeNull(); // Alt+S is not save
  });
});

describe('SHORTCUTS registry', () => {
  it('covers every action used by the dispatcher', () => {
    const actions = new Set(SHORTCUTS.map((s) => s.action));
    for (const a of ['run', 'save', 'format', 'palette', 'theme', 'presentation']) {
      expect(actions.has(a as never)).toBe(true);
    }
  });
});
