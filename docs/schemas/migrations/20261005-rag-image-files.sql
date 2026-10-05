BEGIN;
ALTER TABLE public.knowledge_files DROP CONSTRAINT IF EXISTS knowledge_files_file_kind_check;
ALTER TABLE public.knowledge_files ADD CONSTRAINT knowledge_files_file_kind_check
  CHECK (file_kind IN ('markdown', 'text', 'html', 'pdf', 'docx', 'image'));
UPDATE storage.buckets
SET allowed_mime_types = ARRAY[
  'text/markdown', 'text/plain', 'text/html', 'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/bmp', 'image/tiff'
]
WHERE id = 'knowledge-files';
COMMIT;
