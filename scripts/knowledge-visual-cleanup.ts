import dotenv from 'dotenv';
import { getSupabase } from '../lib/platform/supabase';
dotenv.config({ path: '.env.local', quiet: true });
dotenv.config({ quiet: true });

async function main() {
  const db = getSupabase();
  // Keep generations long enough for running ingestion; active generations are never collected.
  const { error } = await db.from('knowledge_file_generations').delete()
    .in('status', ['preparing', 'ready', 'failed', 'superseded'])
    .lt('created_at', new Date(Date.now() - 24 * 3600_000).toISOString());
  if (error) throw new Error(error.message);
  const { data: tasks, error: tasksError } = await db.from('knowledge_visual_cleanup').select('*').limit(200);
  if (tasksError) throw new Error(tasksError.message);
  for (const task of tasks ?? []) {
    const { error: storageError } = await db.storage.from('knowledge-visuals').remove([task.storage_path]);
    if (storageError) continue;
    const { error: deleteError } = await db.from('knowledge_visual_cleanup').delete().eq('id', task.id);
    if (deleteError) throw new Error(deleteError.message);
  }
  console.log(`Visual cleanup processed ${tasks?.length ?? 0} tasks`);
}
main().catch((error) => { console.error(error instanceof Error ? error.message : 'Visual cleanup failed'); process.exitCode = 1; });
