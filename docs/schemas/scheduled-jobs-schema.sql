create table if not exists scheduled_jobs (
  id text primary key,
  user_id text not null,
  type text not null check (type in ('reminder', 'leetcode-daily', 'agent-task')),
  cron text,
  run_at bigint,
  next_run_at bigint not null,
  timezone text not null default 'Asia/Shanghai',
  payload jsonb not null default '{}'::jsonb,
  enabled boolean not null default true,
  last_run_at bigint,
  last_error text,
  last_result text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (cron is not null or run_at is not null)
);

create index if not exists scheduled_jobs_user_id_idx on scheduled_jobs (user_id);
create index if not exists scheduled_jobs_next_run_at_idx on scheduled_jobs (next_run_at);

create table if not exists scheduled_job_runs (
  id bigserial primary key,
  job_id text not null references scheduled_jobs(id) on delete cascade,
  user_id text not null,
  status text not null check (status in ('success', 'failed', 'skipped')),
  result text,
  error text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists scheduled_job_runs_job_id_idx on scheduled_job_runs (job_id);
create index if not exists scheduled_job_runs_user_id_created_at_idx
  on scheduled_job_runs (user_id, created_at desc);
