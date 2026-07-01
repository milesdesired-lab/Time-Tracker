-- Run this in Supabase SQL Editor.
-- Creates the tasks table and locks it down: NO anon/public access.
--
-- All reads/writes go through the server API (api/tasks.js), which uses the
-- service_role key. The service_role key BYPASSES row level security, so we
-- deliberately leave no permissive policy for the anon/authenticated roles.
-- This means the public anon key can no longer touch the table directly.

create table if not exists tasks (
  id            uuid        default gen_random_uuid() primary key,
  text          text        not null,
  done          boolean     default false,
  urgent        boolean     default false,
  deadline_type text        default 'today',
  deadline_date date        default current_date,
  deadline_time time        default null,
  reminder_sent boolean     default false,
  created_at    timestamptz default now()
);

-- Enable RLS and remove the old wide-open policy.
alter table tasks enable row level security;
drop policy if exists "allow all" on tasks;

-- No policies are (re)created: with RLS enabled and no policy, the anon and
-- authenticated roles are denied all access. Only the service_role key (used
-- server-side) can read/write, because it bypasses RLS.

-- Also: in Storage, set the `reports` bucket to PRIVATE. Archived CSVs are now
-- served through api/reports.js via short-lived signed URLs.
