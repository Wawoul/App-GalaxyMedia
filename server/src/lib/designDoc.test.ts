import { describe, expect, it } from 'vitest';
import { isLiveDoc, parseDesignDoc, referencedMediaIds } from './designDoc.js';

const ID = '11111111-1111-4111-8111-111111111111';
const ID2 = '22222222-2222-4222-8222-222222222222';

const doc = (over: Record<string, unknown> = {}) =>
  JSON.stringify({ v: 1, background: { color: '#fff' }, objects: [], ...over });

describe('parseDesignDoc', () => {
  it('accepts a minimal document and keeps unknown object properties', () => {
    const parsed = parseDesignDoc(doc({ objects: [{ id: 'a', type: 'text', text: 'Hi', fontSize: 40 }] }));
    expect(parsed.objects[0]).toMatchObject({ text: 'Hi', fontSize: 40 });
  });

  it.each([
    ['missing', undefined],
    ['not json', '{nope'],
    ['wrong version', doc({ v: 2 })],
    ['unknown object type', doc({ objects: [{ id: 'a', type: 'script' }] })],
    ['bad media id', doc({ objects: [{ id: 'a', type: 'image', mediaId: 'x' }] })],
    ['too many objects', doc({ objects: Array.from({ length: 301 }, (_, i) => ({ id: String(i), type: 'rect' })) })],
    ['too large', 'x'.repeat(512 * 1024 + 1)],
  ])('rejects %s', (_label, text) => {
    expect(() => parseDesignDoc(text as string | undefined)).toThrow('invalid_design');
  });
});

describe('isLiveDoc', () => {
  const parse = (objects: unknown[]) => parseDesignDoc(doc({ objects }));
  it('is false for a still slide, including objects whose animation is switched off', () => {
    expect(isLiveDoc(parse([]))).toBe(false);
    expect(isLiveDoc(parse([{ id: 'a', type: 'text' }, { id: 'b', type: 'rect', anim: { enter: 'none', loop: 'none' } }]))).toBe(false);
    expect(isLiveDoc(parse([{ id: 'a', type: 'text', anim: { delayMs: 500, durationMs: 900 } }]))).toBe(false);
  });
  it('is true for any widget, entrance animation or loop', () => {
    expect(isLiveDoc(parse([{ id: 'a', type: 'widget', kind: 'clock' }]))).toBe(true);
    expect(isLiveDoc(parse([{ id: 'a', type: 'rect', anim: { enter: 'slide-left' } }]))).toBe(true);
    expect(isLiveDoc(parse([{ id: 'a', type: 'image', anim: { loop: 'pulse' } }]))).toBe(true);
  });
  it('rejects animation settings outside the allowed set', () => {
    for (const anim of [{ enter: 'spin' }, { loop: 'explode' }, { delayMs: -1 }, { durationMs: 10 }, { durationMs: 999999 }]) {
      expect(() => parse([{ id: 'a', type: 'text', anim }]), JSON.stringify(anim)).toThrow('invalid_design');
    }
  });
});

describe('referencedMediaIds', () => {
  it('collects background and image ids once each', () => {
    const parsed = parseDesignDoc(
      doc({
        background: { color: '#000', mediaId: ID },
        objects: [
          { id: 'a', type: 'image', mediaId: ID },
          { id: 'b', type: 'image', mediaId: ID2 },
          { id: 'c', type: 'rect' },
        ],
      }),
    );
    expect(referencedMediaIds(parsed).sort()).toEqual([ID, ID2]);
  });
});
