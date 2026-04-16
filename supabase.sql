-- Run this in Supabase SQL Editor
-- Creates a clean tasks table with all required columns

drop table if exists tasks;

create table tasks (
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

alter table tasks enable row level security;
create policy "allow all" on tasks for all using (true) with check (true);
