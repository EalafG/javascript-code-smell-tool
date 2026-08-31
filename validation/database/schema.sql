-- UPM JavaScript code-smell validation schema for Supabase/PostgreSQL.
-- Run in a new Supabase project, then import the frozen pilot methods and
-- detector snapshots with an administrator-controlled process.

create extension if not exists pgcrypto;

create type public.study_role as enum ('validator', 'adjudicator', 'admin');
create type public.assignment_status as enum ('pending', 'in_progress', 'completed');
create type public.annotation_decision as enum ('present', 'absent', 'uncertain');
create type public.annotation_phase as enum ('blind', 'post_reveal', 'adjudication');

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  validator_code text not null unique default (
    'VAL-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8))
  ),
  display_name text,
  role public.study_role not null default 'validator',
  created_at timestamptz not null default now()
);

create table public.datasets (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  phase text not null check (phase in ('pilot', 'main')),
  dataset_sha256 text not null unique check (length(dataset_sha256) = 64),
  csv_schema_version text not null,
  detector_version text not null,
  parser_version text not null,
  source_revision text,
  sampling_seed text not null,
  protocol_version text not null,
  threshold_snapshot jsonb not null,
  exclusion_summary jsonb not null default '{}'::jsonb,
  is_active boolean not null default false,
  frozen_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create table public.methods (
  id uuid primary key default gen_random_uuid(),
  dataset_id uuid not null references public.datasets(id) on delete restrict,
  sample_id text not null,
  dataset_method_id text not null,
  project text not null,
  file_path text not null,
  function_name text not null,
  function_type text not null,
  start_line integer not null check (start_line > 0),
  end_line integer not null check (end_line >= start_line),
  context_start_line integer not null check (context_start_line > 0),
  context_end_line integer not null check (context_end_line >= end_line),
  source_segment text not null,
  source_context text not null,
  segment_sha256 text not null check (length(segment_sha256) = 64),
  created_at timestamptz not null default now(),
  unique (dataset_id, sample_id),
  unique (dataset_id, dataset_method_id)
);

-- Stored separately so ordinary validators cannot query detector predictions.
create table public.detector_snapshots (
  method_id uuid primary key references public.methods(id) on delete cascade,
  metrics jsonb not null,
  labels jsonb not null,
  smell_types text[] not null default '{}',
  sampling_role text not null,
  sampling_stratum text not null,
  inclusion_probability numeric,
  created_at timestamptz not null default now()
);

create table public.assignments (
  id uuid primary key default gen_random_uuid(),
  method_id uuid not null references public.methods(id) on delete cascade,
  validator_id uuid not null references public.profiles(id) on delete restrict,
  sequence_no integer not null check (sequence_no > 0),
  status public.assignment_status not null default 'pending',
  assigned_at timestamptz not null default now(),
  opened_at timestamptz,
  submitted_at timestamptz,
  unique (method_id, validator_id),
  unique (validator_id, sequence_no)
);

create table public.annotations (
  id uuid primary key default gen_random_uuid(),
  assignment_id uuid not null references public.assignments(id) on delete restrict,
  validator_id uuid not null references public.profiles(id) on delete restrict,
  revision integer not null check (revision > 0),
  phase public.annotation_phase not null default 'blind',
  long_method public.annotation_decision not null,
  complex_method public.annotation_decision not null,
  complex_conditional public.annotation_decision not null,
  feature_envy public.annotation_decision not null,
  notes text,
  decision_times jsonb not null default '{}'::jsonb,
  client_started_at timestamptz not null,
  submitted_at timestamptz not null default now(),
  duration_seconds numeric not null check (duration_seconds >= 0),
  unique (assignment_id, revision)
);

create table public.annotation_events (
  id bigint generated always as identity primary key,
  assignment_id uuid not null references public.assignments(id) on delete restrict,
  validator_id uuid not null references public.profiles(id) on delete restrict,
  event_type text not null check (event_type in ('opened', 'submitted', 'revised')),
  event_at timestamptz not null default now(),
  payload jsonb not null default '{}'::jsonb
);

create table public.adjudications (
  id uuid primary key default gen_random_uuid(),
  method_id uuid not null unique references public.methods(id) on delete restrict,
  adjudicator_id uuid not null references public.profiles(id) on delete restrict,
  long_method public.annotation_decision not null,
  complex_method public.annotation_decision not null,
  complex_conditional public.annotation_decision not null,
  feature_envy public.annotation_decision not null,
  rationale text not null,
  adjudicated_at timestamptz not null default now()
);

create index assignments_validator_status_idx
  on public.assignments (validator_id, status, sequence_no);
create index annotations_assignment_idx on public.annotations (assignment_id, revision desc);
create index methods_dataset_idx on public.methods (dataset_id, sample_id);

create or replace function public.is_study_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid() and role in ('admin', 'adjudicator')
  );
$$;

create or replace function public.handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, display_name)
  values (new.id, nullif(new.raw_user_meta_data ->> 'display_name', ''))
  on conflict (id) do nothing;
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_auth_user();

alter table public.profiles enable row level security;
alter table public.datasets enable row level security;
alter table public.methods enable row level security;
alter table public.detector_snapshots enable row level security;
alter table public.assignments enable row level security;
alter table public.annotations enable row level security;
alter table public.annotation_events enable row level security;
alter table public.adjudications enable row level security;

create policy profiles_read_self_or_admin on public.profiles
  for select to authenticated
  using (id = auth.uid() or public.is_study_admin());

create policy datasets_read_authenticated on public.datasets
  for select to authenticated using (true);

create policy methods_read_when_assigned on public.methods
  for select to authenticated
  using (
    public.is_study_admin()
    or exists (
      select 1 from public.assignments a
      where a.method_id = methods.id and a.validator_id = auth.uid()
    )
  );

create policy snapshots_admin_only on public.detector_snapshots
  for all to authenticated
  using (public.is_study_admin())
  with check (public.is_study_admin());

create policy assignments_read_self_or_admin on public.assignments
  for select to authenticated
  using (validator_id = auth.uid() or public.is_study_admin());

create policy annotations_read_self_or_admin on public.annotations
  for select to authenticated
  using (validator_id = auth.uid() or public.is_study_admin());

create policy events_read_self_or_admin on public.annotation_events
  for select to authenticated
  using (validator_id = auth.uid() or public.is_study_admin());

create policy adjudications_admin_only on public.adjudications
  for all to authenticated
  using (public.is_study_admin())
  with check (public.is_study_admin());

create or replace view public.validator_queue
with (security_invoker = true)
as
select
  a.id as assignment_id,
  a.sequence_no,
  a.status,
  a.opened_at,
  m.sample_id,
  m.dataset_method_id,
  m.project,
  m.file_path,
  m.function_name,
  m.function_type,
  m.start_line,
  m.end_line,
  m.context_start_line,
  m.context_end_line,
  m.source_segment,
  m.source_context,
  m.segment_sha256,
  d.dataset_sha256,
  d.protocol_version
from public.assignments a
join public.methods m on m.id = a.method_id
join public.datasets d on d.id = m.dataset_id
where a.validator_id = auth.uid();

create or replace function public.open_assignment(p_assignment_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.assignments
  set status = case when status = 'pending' then 'in_progress' else status end,
      opened_at = coalesce(opened_at, now())
  where id = p_assignment_id and validator_id = auth.uid() and status <> 'completed';

  if not found then
    raise exception 'Assignment is unavailable';
  end if;

  insert into public.annotation_events (assignment_id, validator_id, event_type)
  values (p_assignment_id, auth.uid(), 'opened');
end;
$$;

create or replace function public.submit_annotation(
  p_assignment_id uuid,
  p_long_method public.annotation_decision,
  p_complex_method public.annotation_decision,
  p_complex_conditional public.annotation_decision,
  p_feature_envy public.annotation_decision,
  p_notes text,
  p_decision_times jsonb,
  p_client_started_at timestamptz
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_assignment public.assignments%rowtype;
  v_revision integer;
  v_annotation_id uuid;
  v_submitted_at timestamptz := now();
begin
  select * into v_assignment
  from public.assignments
  where id = p_assignment_id and validator_id = auth.uid()
  for update;

  if not found then
    raise exception 'Assignment is unavailable';
  end if;
  if (
    p_long_method = 'uncertain'
    or p_complex_method = 'uncertain'
    or p_complex_conditional = 'uncertain'
    or p_feature_envy = 'uncertain'
  ) and nullif(btrim(coalesce(p_notes, '')), '') is null then
    raise exception 'A note is required when any decision is uncertain';
  end if;

  select coalesce(max(revision), 0) + 1 into v_revision
  from public.annotations where assignment_id = p_assignment_id;

  insert into public.annotations (
    assignment_id,
    validator_id,
    revision,
    phase,
    long_method,
    complex_method,
    complex_conditional,
    feature_envy,
    notes,
    decision_times,
    client_started_at,
    submitted_at,
    duration_seconds
  ) values (
    p_assignment_id,
    auth.uid(),
    v_revision,
    'blind',
    p_long_method,
    p_complex_method,
    p_complex_conditional,
    p_feature_envy,
    nullif(btrim(coalesce(p_notes, '')), ''),
    coalesce(p_decision_times, '{}'::jsonb),
    p_client_started_at,
    v_submitted_at,
    greatest(0, extract(epoch from (v_submitted_at - p_client_started_at)))
  ) returning id into v_annotation_id;

  update public.assignments
  set status = 'completed', submitted_at = v_submitted_at
  where id = p_assignment_id;

  insert into public.annotation_events (
    assignment_id, validator_id, event_type, event_at, payload
  ) values (
    p_assignment_id,
    auth.uid(),
    case when v_revision = 1 then 'submitted' else 'revised' end,
    v_submitted_at,
    jsonb_build_object('annotation_id', v_annotation_id, 'revision', v_revision)
  );

  return v_annotation_id;
end;
$$;

revoke all on function public.open_assignment(uuid) from public, anon;
revoke all on function public.submit_annotation(
  uuid,
  public.annotation_decision,
  public.annotation_decision,
  public.annotation_decision,
  public.annotation_decision,
  text,
  jsonb,
  timestamptz
) from public, anon;

grant select on public.validator_queue to authenticated;
grant execute on function public.open_assignment(uuid) to authenticated;
grant execute on function public.submit_annotation(
  uuid,
  public.annotation_decision,
  public.annotation_decision,
  public.annotation_decision,
  public.annotation_decision,
  text,
  jsonb,
  timestamptz
) to authenticated;

create or replace view public.admin_progress
with (security_invoker = true)
as
select
  p.validator_code,
  p.display_name,
  count(a.id) as assigned,
  count(a.id) filter (where a.status = 'completed') as completed,
  count(a.id) filter (where a.status <> 'completed') as remaining,
  max(a.submitted_at) as last_submission_at
from public.profiles p
left join public.assignments a on a.validator_id = p.id
group by p.id, p.validator_code, p.display_name;

create or replace view public.annotation_export
with (security_invoker = true)
as
select
  an.id as annotation_id,
  p.validator_code,
  m.sample_id,
  m.dataset_method_id,
  m.project,
  m.file_path,
  an.revision,
  an.phase,
  an.long_method,
  an.complex_method,
  an.complex_conditional,
  an.feature_envy,
  an.notes,
  an.decision_times,
  an.client_started_at,
  an.submitted_at,
  an.duration_seconds
from public.annotations an
join public.profiles p on p.id = an.validator_id
join public.assignments a on a.id = an.assignment_id
join public.methods m on m.id = a.method_id;

grant select on public.admin_progress, public.annotation_export to authenticated;
