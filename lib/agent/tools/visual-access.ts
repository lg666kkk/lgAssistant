import { parseVisualRefs, type VisualRef } from '@/lib/knowledge/visual-types';

/** Each builtin registry owns one request-scoped grant set, not a process-global cache. */
export class VisualAccessRegistry {
  private grants = new Map<string, { userId: string; requestId: string; ref: VisualRef }>();
  private reads = 0;
  private images = 0;

  grant(userId: string | undefined, requestId: string | undefined, value: unknown) {
    if (!userId || !requestId) return;
    for (const ref of parseVisualRefs(value)) this.grants.set(ref.assetId, { userId, requestId, ref });
  }

  authorize(userId: string | undefined, requestId: string | undefined, ids: string[]) {
    if (!userId || !requestId || !ids.length || ids.length > 3 || new Set(ids).size !== ids.length) {
      throw new Error('Read one to three distinct resources returned by search_notes');
    }
    const refs = ids.map((id) => {
      const grant = this.grants.get(id);
      if (!grant || grant.userId !== userId || grant.requestId !== requestId) {
        throw new Error('Resource was not authorized by retrieval in this request');
      }
      return grant.ref;
    });
    if (this.reads >= 2 || this.images + ids.length > 6) throw new Error('Visual reading budget exhausted');
    this.reads++; this.images += ids.length;
    return refs;
  }
}
