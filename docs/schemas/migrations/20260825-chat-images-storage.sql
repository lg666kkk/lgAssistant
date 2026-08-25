-- Private chat image storage for multimodal message history.
-- Object keys must follow: <auth.uid()>/<session_id>/<image_id>.<extension>

INSERT INTO storage.buckets (
  id,
  name,
  public,
  file_size_limit,
  allowed_mime_types
)
VALUES (
  'chat-images',
  'chat-images',
  false,
  33554432,
  ARRAY['image/jpeg', 'image/png', 'image/gif', 'image/webp']
)
ON CONFLICT (id) DO UPDATE
SET
  public = EXCLUDED.public,
  file_size_limit = EXCLUDED.file_size_limit,
  allowed_mime_types = EXCLUDED.allowed_mime_types;

DROP POLICY IF EXISTS chat_images_owner_select ON storage.objects;
CREATE POLICY chat_images_owner_select
ON storage.objects
FOR SELECT
TO authenticated
USING (
  bucket_id = 'chat-images'
  AND (storage.foldername(name))[1] = auth.uid()::text
);

DROP POLICY IF EXISTS chat_images_owner_insert ON storage.objects;
CREATE POLICY chat_images_owner_insert
ON storage.objects
FOR INSERT
TO authenticated
WITH CHECK (
  bucket_id = 'chat-images'
  AND (storage.foldername(name))[1] = auth.uid()::text
);

DROP POLICY IF EXISTS chat_images_owner_update ON storage.objects;
CREATE POLICY chat_images_owner_update
ON storage.objects
FOR UPDATE
TO authenticated
USING (
  bucket_id = 'chat-images'
  AND (storage.foldername(name))[1] = auth.uid()::text
)
WITH CHECK (
  bucket_id = 'chat-images'
  AND (storage.foldername(name))[1] = auth.uid()::text
);

DROP POLICY IF EXISTS chat_images_owner_delete ON storage.objects;
CREATE POLICY chat_images_owner_delete
ON storage.objects
FOR DELETE
TO authenticated
USING (
  bucket_id = 'chat-images'
  AND (storage.foldername(name))[1] = auth.uid()::text
);
