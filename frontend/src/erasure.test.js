import { describe, it, expect } from 'vitest';

import {
  canConfirmErasure,
  parseErasureRequest,
  summarizeErasure,
  ERASURE_CONFIRM_PHRASE,
  LOCAL_STORAGE_KEYS,
} from './erasure.js';

describe('canConfirmErasure', () => {
  it('arms on the exact phrase', () => {
    expect(canConfirmErasure('DELETE')).toBe(true);
  });

  it('tolerates lowercase and surrounding whitespace', () => {
    expect(canConfirmErasure('delete')).toBe(true);
    expect(canConfirmErasure('  Delete  ')).toBe(true);
  });

  it('stays disarmed on anything else', () => {
    expect(canConfirmErasure('')).toBe(false);
    expect(canConfirmErasure('DELET')).toBe(false);
    expect(canConfirmErasure('DELETE MY DATA')).toBe(false);
    expect(canConfirmErasure('yes')).toBe(false);
  });

  it('stays disarmed on non-string input', () => {
    expect(canConfirmErasure(undefined)).toBe(false);
    expect(canConfirmErasure(null)).toBe(false);
    expect(canConfirmErasure(1)).toBe(false);
  });

  it('exports the phrase so the UI label cannot drift from the check', () => {
    expect(canConfirmErasure(ERASURE_CONFIRM_PHRASE)).toBe(true);
  });
});

describe('parseErasureRequest', () => {
  it('extracts the user id and token from an email link', () => {
    expect(parseErasureRequest('?delete=user-123&token=abc.def')).toEqual({
      userId: 'user-123',
      token: 'abc.def',
    });
  });

  it('returns the request with a null token when none is present', () => {
    // Still worth surfacing: the dialog opens and the API rejects it with 401,
    // which is a clearer outcome than silently ignoring the link.
    expect(parseErasureRequest('?delete=user-123')).toEqual({
      userId: 'user-123',
      token: null,
    });
  });

  it('returns null when there is no delete parameter', () => {
    expect(parseErasureRequest('?unsubscribe=user-123&token=abc')).toBeNull();
    expect(parseErasureRequest('')).toBeNull();
    expect(parseErasureRequest(undefined)).toBeNull();
  });

  it('decodes a url-encoded user id', () => {
    expect(parseErasureRequest('?delete=local-a%2Fb')?.userId).toBe('local-a/b');
  });

  it('does not confuse an unsubscribe link for an erasure link', () => {
    // The two flows must stay distinct: unsubscribe auto-fires on load, erasure
    // never does.
    expect(parseErasureRequest('?unsubscribe=u1')).toBeNull();
  });
});

describe('summarizeErasure', () => {
  it('itemises every store that had something in it', () => {
    expect(summarizeErasure({ images: 2, prescriptions: 1, schedules: 1, reminders: 12 })).toBe(
      'Deleted 2 prescription images, 1 prescription record, 1 reminder schedule and 12 upcoming reminders.'
    );
  });

  it('reads naturally for a single store', () => {
    expect(summarizeErasure({ images: 1 })).toBe('Deleted 1 prescription image.');
  });

  it('joins exactly two stores with "and", no comma', () => {
    expect(summarizeErasure({ images: 3, reminders: 4 })).toBe(
      'Deleted 3 prescription images and 4 upcoming reminders.'
    );
  });

  it('singularises correctly', () => {
    expect(summarizeErasure({ schedules: 1 })).toBe('Deleted 1 reminder schedule.');
    expect(summarizeErasure({ schedules: 2 })).toBe('Deleted 2 reminder schedules.');
  });

  it('says so plainly when there was nothing left, rather than claiming a delete', () => {
    const empty = 'There was nothing left to delete — your data is already gone.';
    expect(summarizeErasure({ images: 0, prescriptions: 0, schedules: 0, reminders: 0 })).toBe(empty);
    expect(summarizeErasure({})).toBe(empty);
    expect(summarizeErasure(undefined)).toBe(empty);
  });

  it('omits stores that were empty instead of listing zeros', () => {
    expect(summarizeErasure({ images: 0, schedules: 2 })).toBe('Deleted 2 reminder schedules.');
  });
});

describe('LOCAL_STORAGE_KEYS', () => {
  it('covers every key the app writes, including the one holding contact info', () => {
    expect(LOCAL_STORAGE_KEYS).toContain('rxreader.userId');
    expect(LOCAL_STORAGE_KEYS).toContain('rxreader.sessionToken');
    // reminderDetails holds the email address or phone number — erasure that
    // left this behind would leave PII on the device.
    expect(LOCAL_STORAGE_KEYS).toContain('rxreader.reminderDetails');
  });
});
