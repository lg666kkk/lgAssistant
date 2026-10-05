export type VisualProgress = {
  stage: 'rendering' | 'analyzing' | 'indexing';
  total: number;
  processed: number;
  analyzed: number;
  failed: number;
  skipped: number;
  currentPage: number | null;
};
