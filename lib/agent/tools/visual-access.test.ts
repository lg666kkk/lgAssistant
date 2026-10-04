import { describe, expect, it } from 'vitest';
import { VisualAccessRegistry } from './visual-access';
import { parseVisualRefs } from '@/lib/knowledge/visual-types';

const ref = { assetId: '00000000-0000-4000-8000-000000000001',
  fileId: '00000000-0000-4000-8000-000000000002',
  generationId: '00000000-0000-4000-8000-000000000003', sourceVersion: 'a'.repeat(64), pageNumber: 2 };

describe('request-scoped visual access', () => {
  it('requires a valid retrieved reference and matching user/request', () => {
    const access = new VisualAccessRegistry();
    expect(() => access.authorize('user', 'request', [ref.assetId])).toThrow('authorized');
    access.grant('user', 'request', [ref]);
    expect(() => access.authorize('other', 'request', [ref.assetId])).toThrow('authorized');
    expect(() => access.authorize('user', 'other', [ref.assetId])).toThrow('authorized');
    expect(access.authorize('user', 'request', [ref.assetId])).toEqual([ref]);
  });
  it('rejects duplicate images and enforces the two-call budget', () => {
    const access = new VisualAccessRegistry(); access.grant('u', 'r', [ref]);
    expect(() => access.authorize('u', 'r', [ref.assetId, ref.assetId])).toThrow('distinct');
    access.authorize('u', 'r', [ref.assetId]); access.authorize('u', 'r', [ref.assetId]);
    expect(() => access.authorize('u', 'r', [ref.assetId])).toThrow('budget');
  });
  it('rejects incomplete version identities and never carries user-supplied paths', () => {
    expect(parseVisualRefs([{ ...ref, sourceVersion: 'old' }])).toEqual([]);
    expect(parseVisualRefs([{ ...ref, assetId: '../other' }])).toEqual([]);
    expect(parseVisualRefs([{ ...ref, storagePath: 'other-user/private.png' }])).toEqual([ref]);
  });
});
