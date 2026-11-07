import { describe, expect, it } from 'vitest';
import { BETA_NOTICE_KEY, acceptBetaNotice, betaNoticeDue } from '../src/renderer/betaNotice';
import { helpTopicFor } from '../src/help/context';

function memory(): Storage {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) } as Storage;
}

describe('beta notice', () => {
  it('is due until it has been accepted once', () => {
    const s = memory();
    expect(betaNoticeDue(s)).toBe(true);
    acceptBetaNotice(s);
    expect(s.getItem(BETA_NOTICE_KEY)).not.toBeNull();
    expect(betaNoticeDue(s)).toBe(false);
  });

  it('shows again when storage fails instead of hiding for good', () => {
    const broken = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); } };
    expect(() => acceptBetaNotice(broken)).not.toThrow();
    expect(betaNoticeDue(broken)).toBe(true);
  });

  it('F1 on the notice opens the beta section of the guide', () => {
    expect(helpTopicFor({ dialog: 'WavePod is beta software', view: 'setup' })).toBe('getting-started/beta-software');
  });
});
