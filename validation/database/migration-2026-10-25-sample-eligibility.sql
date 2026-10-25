-- Apply once to an existing validation database created from an earlier schema.
-- Fresh installations should run schema.sql instead.

alter table public.annotations
  add column if not exists sample_disposition text not null default 'eligible',
  add column if not exists ineligibility_reason text,
  add column if not exists ineligibility_details text;

alter table public.annotations
  alter column long_method drop not null,
  alter column complex_method drop not null,
  alter column complex_conditional drop not null,
  alter column feature_envy drop not null;

alter table public.annotations
  add constraint annotations_sample_disposition_check
    check (sample_disposition in ('eligible', 'ineligible')),
  add constraint annotations_ineligibility_reason_check
    check (ineligibility_reason is null or ineligibility_reason in (
      'third_party_or_generated',
      'incomplete_or_incorrect_segment',
      'essential_context_unavailable',
      'parse_or_display_problem',
      'other'
    )),
  add constraint annotations_disposition_decisions_check
    check (
      (sample_disposition = 'eligible'
        and ineligibility_reason is null
        and long_method is not null
        and complex_method is not null
        and complex_conditional is not null
        and feature_envy is not null)
      or
      (sample_disposition = 'ineligible'
        and ineligibility_reason is not null
        and long_method is null
        and complex_method is null
        and complex_conditional is null
        and feature_envy is null)
    ),
  add constraint annotations_other_details_check
    check (
      ineligibility_reason <> 'other'
      or nullif(btrim(coalesce(ineligibility_details, '')), '') is not null
    );

create or replace function public.submit_annotation_v2(
  p_assignment_id uuid,
  p_sample_disposition text,
  p_ineligibility_reason text,
  p_ineligibility_details text,
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
  if not exists (
    select 1
    from public.validator_declarations
    where validator_id = auth.uid() and declaration_version = '1.0.0'
  ) then
    raise exception 'The current validator declaration is required before annotation';
  end if;
  if p_sample_disposition not in ('eligible', 'ineligible') then
    raise exception 'Sample disposition must be eligible or ineligible';
  end if;
  if p_sample_disposition = 'eligible' and (
    p_long_method is null
    or p_complex_method is null
    or p_complex_conditional is null
    or p_feature_envy is null
  ) then
    raise exception 'All four smell decisions are required for an eligible sample';
  end if;
  if p_sample_disposition = 'ineligible' and (
    p_ineligibility_reason is null
    or p_ineligibility_reason not in (
      'third_party_or_generated',
      'incomplete_or_incorrect_segment',
      'essential_context_unavailable',
      'parse_or_display_problem',
      'other'
    )
    or p_long_method is not null
    or p_complex_method is not null
    or p_complex_conditional is not null
    or p_feature_envy is not null
  ) then
    raise exception 'An ineligible sample requires a valid reason and no smell decisions';
  end if;
  if p_ineligibility_reason = 'other'
    and nullif(btrim(coalesce(p_ineligibility_details, '')), '') is null then
    raise exception 'Details are required for an Other sample problem';
  end if;
  if p_sample_disposition = 'eligible' and (
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
    assignment_id, validator_id, revision, phase,
    sample_disposition, ineligibility_reason, ineligibility_details,
    long_method, complex_method, complex_conditional, feature_envy,
    notes, decision_times, client_started_at, submitted_at, duration_seconds
  ) values (
    p_assignment_id, auth.uid(), v_revision, 'blind',
    p_sample_disposition,
    case when p_sample_disposition = 'ineligible' then p_ineligibility_reason else null end,
    case when p_sample_disposition = 'ineligible' then nullif(btrim(coalesce(p_ineligibility_details, '')), '') else null end,
    p_long_method, p_complex_method, p_complex_conditional, p_feature_envy,
    case when p_sample_disposition = 'eligible' then nullif(btrim(coalesce(p_notes, '')), '') else null end,
    coalesce(p_decision_times, '{}'::jsonb), p_client_started_at, v_submitted_at,
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
    jsonb_build_object(
      'annotation_id', v_annotation_id,
      'revision', v_revision,
      'sample_disposition', p_sample_disposition
    )
  );

  return v_annotation_id;
end;
$$;

revoke all on function public.submit_annotation_v2(
  uuid, text, text, text,
  public.annotation_decision, public.annotation_decision,
  public.annotation_decision, public.annotation_decision,
  text, jsonb, timestamptz
) from public, anon;

grant execute on function public.submit_annotation_v2(
  uuid, text, text, text,
  public.annotation_decision, public.annotation_decision,
  public.annotation_decision, public.annotation_decision,
  text, jsonb, timestamptz
) to authenticated;

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
  vd.declaration_version,
  vd.accepted_at as declaration_accepted_at,
  vd.client_accepted_at as declaration_client_accepted_at,
  vd.javascript_experience,
  vd.code_review_frequency,
  vd.code_smell_familiarity,
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
  an.duration_seconds,
  an.sample_disposition,
  an.ineligibility_reason,
  an.ineligibility_details
from public.annotations an
join public.profiles p on p.id = an.validator_id
join public.assignments a on a.id = an.assignment_id
join public.methods m on m.id = a.method_id
left join lateral (
  select
    declaration_version,
    accepted_at,
    client_accepted_at,
    javascript_experience,
    code_review_frequency,
    code_smell_familiarity
  from public.validator_declarations
  where validator_id = an.validator_id
  order by accepted_at desc
  limit 1
) vd on true;

grant select on public.annotation_export to authenticated;
