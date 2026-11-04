import { describe, expect, it, vi } from 'vitest';
import { contextMenuNextIndex, contextMenuPosition, contextMenuScrollChanged, type ContextMenuItem } from '../src/renderer/ContextMenu';

describe('context menu viewport and keyboard boundaries', () => {
  it('ignores delayed scroll events at the same position but closes for actual movement or unknown containers', () => {
    expect(contextMenuScrollChanged({ x: 0, y: 228 }, { x: 0, y: 228 })).toBe(false);
    expect(contextMenuScrollChanged({ x: 0, y: 228 }, { x: 0, y: 229 })).toBe(true);
    expect(contextMenuScrollChanged({ x: 0, y: 228 }, { x: 1, y: 228 })).toBe(true);
    expect(contextMenuScrollChanged(undefined, { x: 0, y: 0 })).toBe(true);
    expect(contextMenuScrollChanged({ x: 0, y: 228 }, undefined)).toBe(true);
  });
  it('keeps a popup inside the usable viewport at each edge and on a very small window', () => {
    const menu = { width: 240, height: 320 }, viewport = { width: 980, height: 680 };
    expect(contextMenuPosition({ x: 979, y: 679 }, menu, viewport)).toEqual({ x: 732, y: 352 });
    expect(contextMenuPosition({ x: -20, y: -10 }, menu, viewport)).toEqual({ x: 8, y: 8 });
    expect(contextMenuPosition({ x: 300, y: 120 }, menu, viewport)).toEqual({ x: 300, y: 120 });
    expect(contextMenuPosition({ x: 60, y: 50 }, { width: 84, height: 64 }, { width: 100, height: 80 })).toEqual({ x: 8, y: 8 });
  });
  it('wraps keyboard navigation over enabled actions without invoking anything', () => {
    const action = vi.fn();
    const items: ContextMenuItem[] = [
      { id: 'disabled', label: 'Unavailable', disabled: true, onSelect: action },
      { id: 'copy', label: 'Copy', onSelect: action },
      { id: 'divider', separator: true },
      { id: 'edit', label: 'Edit', onSelect: action },
    ];
    expect(contextMenuNextIndex(items, -1, 1)).toBe(1);
    expect(contextMenuNextIndex(items, 1, 1)).toBe(3);
    expect(contextMenuNextIndex(items, 3, 1)).toBe(1);
    expect(contextMenuNextIndex(items, 1, -1)).toBe(3);
    expect(contextMenuNextIndex(items, 0, -1)).toBe(3);
    expect(contextMenuNextIndex([items[0], items[2]], -1, 1)).toBe(-1);
    expect(contextMenuNextIndex([], -1, 1)).toBe(-1);
    expect(action).not.toHaveBeenCalled();
  });
});
