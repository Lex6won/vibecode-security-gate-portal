-- [보존용 변형 2026-08-13] 이 파일은 홈 사본 저장소에서 미커밋 상태로 남아 있던
-- supabase/schema.sql 의 변형이다. docs/17(로컬 에이전트 설계)에 딸린 개정으로
-- release_channel/release_bundle 등 배포 번들 개념이 담겨 있다.
-- supabase/schema.sql 과 마찬가지로 폐기 예정이며, 확정 스키마는 db/schema.postgresql.sql 이다.
-- 내용 유실 방지를 위해서만 보존한다.
--
-- Supabase/PostgreSQL schema draft for VibeCode Security Gate Portal.
-- This stores anonymous scan metadata only. Do not store source code,
-- raw archives, GitHub tokens, names, departments, or full local paths.

create extension if not exists pgcrypto;

create type admin_role as enum ('super_admin');
create type client_type as enum ('local_web', 'desktop', 'mcp');
create type target_type as enum ('folder', 'archive', 'github_url');
create type scan_mode as enum ('quick', 'standard');
create type scan_status as enum ('queued', 'running', 'completed', 'failed', 'cancelled');
create type scan_decision as enum ('submittable', 'needs_fix', 'needs_review', 'blocked', 'incomplete');
create type network_mode as enum ('online', 'offline', 'limited');
create type finding_severity as enum ('critical', 'high', 'medium', 'low', 'info');
create type finding_decision as enum ('block', 'requires_review', 'warn', 'pass');
create type confidence_level as enum ('high', 'medium', 'low');
create type report_type as enum ('html', 'json', 'markdown', 'sarif');
create type report_status as enum ('pending', 'generated', 'saved', 'failed');
create type reachability as enum ('reachable', 'not_reachable', 'unknown');
create type sync_status as enum ('not_enabled', 'pending', 'synced', 'failed');
create type review_status as enum ('confirmed', 'false_positive', 'accepted_risk', 'needs_fix', 'needs_rule_change');
create type feedback_type as enum ('false_positive', 'over_detection', 'missed_detection', 'message_improvement', 'dependency_reachability');
create type release_channel as enum ('stable', 'emergency', 'offline_bundle');
create type release_bundle_status as enum ('draft', 'approved', 'superseded', 'revoked');
create type bundle_install_status as enum ('not_installed', 'installed', 'update_available', 'verification_failed', 'update_failed', 'unknown');

create table admin_profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  login_id varchar(80) unique not null,
  display_name varchar(80) not null,
  role admin_role not null default 'super_admin',
  is_active boolean not null default true,
  last_login_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table client_installations (
  id uuid primary key default gen_random_uuid(),
  anonymous_client_id varchar(80) unique not null,
  client_type client_type not null,
  os_name varchar(80),
  app_version varchar(40),
  checker_version varchar(40),
  ruleset_version varchar(80),
  harness_commit varchar(80),
  mcp_codex_status varchar(30),
  mcp_claude_status varchar(30),
  last_seen_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

-- The only release source an agent may trust. GitHub main is never an agent update source.
create table release_bundles (
  id uuid primary key default gen_random_uuid(),
  bundle_version varchar(80) unique not null,
  channel release_channel not null default 'stable',
  status release_bundle_status not null default 'draft',
  agent_version varchar(40) not null,
  checker_version varchar(40) not null,
  harness_commit varchar(80) not null,
  ruleset_version varchar(80) not null,
  intel_version varchar(80),
  source_commit varchar(80) not null,
  artifact_uri varchar(500) not null,
  artifact_sha256 char(64) not null,
  signature_key_id varchar(160) not null,
  sbom_sha256 char(64) not null,
  minimum_agent_version varchar(40),
  rollback_bundle_id uuid references release_bundles(id) on delete set null,
  change_summary varchar(2000) not null,
  approved_by uuid references admin_profiles(id) on delete set null,
  approved_at timestamptz,
  created_at timestamptz not null default now(),
  check ((status = 'approved') = (approved_at is not null))
);

-- This is the PC-side applied-bundle inventory. It carries no user, source, report, or local-path data.
create table agent_bundle_inventory (
  id uuid primary key default gen_random_uuid(),
  client_installation_id uuid not null references client_installations(id) on delete cascade,
  release_bundle_id uuid references release_bundles(id) on delete set null,
  observed_bundle_version varchar(80),
  install_status bundle_install_status not null,
  is_current boolean not null default false,
  verification_error_code varchar(80),
  installed_at timestamptz,
  verified_at timestamptz,
  last_seen_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique (client_installation_id, release_bundle_id)
);

create table scan_jobs (
  id uuid primary key default gen_random_uuid(),
  anonymous_session_id varchar(80) not null,
  client_installation_id uuid references client_installations(id) on delete set null,
  target_type target_type not null,
  scan_mode scan_mode not null,
  checker_version varchar(40),
  ruleset_version varchar(80),
  harness_commit varchar(80),
  network_mode network_mode not null default 'online',
  status scan_status not null default 'queued',
  decision scan_decision,
  sync_status sync_status not null default 'not_enabled',
  scanned_file_count integer not null default 0,
  ignored_file_count integer not null default 0,
  finding_count integer not null default 0,
  dependency_finding_count integer not null default 0,
  false_positive_candidate_count integer not null default 0,
  duration_ms integer,
  error_code varchar(80),
  error_category varchar(80),
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz not null default now()
);

create table scan_steps (
  id uuid primary key default gen_random_uuid(),
  scan_job_id uuid not null references scan_jobs(id) on delete cascade,
  step_name varchar(60) not null,
  status scan_status not null,
  message text,
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz not null default now()
);

create table scan_reports (
  id uuid primary key default gen_random_uuid(),
  scan_job_id uuid not null references scan_jobs(id) on delete cascade,
  report_type report_type not null,
  status report_status not null default 'pending',
  created_at timestamptz not null default now()
);

create table scan_findings (
  id uuid primary key default gen_random_uuid(),
  scan_job_id uuid not null references scan_jobs(id) on delete cascade,
  rule_id varchar(120) not null,
  rule_name varchar(255),
  severity finding_severity not null,
  decision finding_decision not null,
  confidence confidence_level not null default 'medium',
  is_false_positive_candidate boolean not null default false,
  created_at timestamptz not null default now()
);

create table dependency_findings (
  id uuid primary key default gen_random_uuid(),
  scan_job_id uuid not null references scan_jobs(id) on delete cascade,
  package_name varchar(255) not null,
  package_version varchar(80),
  ecosystem varchar(40) not null,
  vulnerability_id varchar(80) not null,
  severity finding_severity not null,
  reachable reachability not null default 'unknown',
  fixed_version varchar(80),
  created_at timestamptz not null default now()
);

create table rule_feedback (
  id uuid primary key default gen_random_uuid(),
  scan_job_id uuid references scan_jobs(id) on delete set null,
  finding_id uuid references scan_findings(id) on delete set null,
  dependency_finding_id uuid references dependency_findings(id) on delete set null,
  feedback_type feedback_type not null,
  status review_status not null default 'needs_rule_change',
  rule_id varchar(120),
  note text,
  reviewer_id uuid references admin_profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table review_notes (
  id uuid primary key default gen_random_uuid(),
  scan_job_id uuid not null references scan_jobs(id) on delete cascade,
  finding_id uuid references scan_findings(id) on delete set null,
  dependency_finding_id uuid references dependency_findings(id) on delete set null,
  reviewer_id uuid references admin_profiles(id) on delete set null,
  review_status review_status not null,
  note text,
  created_at timestamptz not null default now()
);

create table usage_events (
  id uuid primary key default gen_random_uuid(),
  scan_job_id uuid references scan_jobs(id) on delete set null,
  anonymous_session_id varchar(80) not null,
  event_type varchar(60) not null,
  scan_mode scan_mode,
  target_type target_type,
  client_type client_type not null,
  checker_version varchar(40),
  created_at timestamptz not null default now()
);

create table audit_logs (
  id uuid primary key default gen_random_uuid(),
  admin_user_id uuid references admin_profiles(id) on delete set null,
  action varchar(80) not null,
  target_type varchar(40),
  target_id uuid,
  ip_address_hash char(64),
  user_agent varchar(500),
  created_at timestamptz not null default now()
);

create table daily_usage_stats (
  stat_date date not null,
  client_type client_type not null,
  scan_mode scan_mode not null,
  target_type target_type not null,
  scan_count integer not null default 0,
  completed_count integer not null default 0,
  failed_count integer not null default 0,
  needs_fix_count integer not null default 0,
  needs_review_count integer not null default 0,
  submittable_count integer not null default 0,
  primary key (stat_date, client_type, scan_mode, target_type)
);

create index idx_scan_jobs_created_at on scan_jobs(created_at desc);
create index idx_scan_jobs_decision_created_at on scan_jobs(decision, created_at desc);
create index idx_scan_jobs_target_type_created_at on scan_jobs(target_type, created_at desc);
create index idx_scan_jobs_scan_mode_created_at on scan_jobs(scan_mode, created_at desc);
create index idx_scan_jobs_session_created_at on scan_jobs(anonymous_session_id, created_at desc);
create index idx_release_bundles_status_channel on release_bundles(status, channel, approved_at desc);
create index idx_agent_bundle_inventory_installation on agent_bundle_inventory(client_installation_id, last_seen_at desc);
create index idx_agent_bundle_inventory_status on agent_bundle_inventory(install_status, last_seen_at desc);
create index idx_scan_steps_job on scan_steps(scan_job_id, created_at);
create index idx_usage_events_event_created_at on usage_events(event_type, created_at desc);
create index idx_usage_events_client_created_at on usage_events(client_type, created_at desc);
create index idx_scan_findings_job_severity on scan_findings(scan_job_id, severity);
create index idx_scan_findings_rule_created_at on scan_findings(rule_id, created_at desc);
create index idx_dependency_findings_job_severity on dependency_findings(scan_job_id, severity);
create index idx_scan_reports_job_type on scan_reports(scan_job_id, report_type);
create index idx_audit_logs_admin_created_at on audit_logs(admin_user_id, created_at desc);

create or replace function is_super_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from admin_profiles
    where id = auth.uid()
      and role = 'super_admin'
      and is_active = true
  );
$$;

alter table admin_profiles enable row level security;
alter table client_installations enable row level security;
alter table release_bundles enable row level security;
alter table agent_bundle_inventory enable row level security;
alter table scan_jobs enable row level security;
alter table scan_steps enable row level security;
alter table scan_reports enable row level security;
alter table scan_findings enable row level security;
alter table dependency_findings enable row level security;
alter table rule_feedback enable row level security;
alter table review_notes enable row level security;
alter table usage_events enable row level security;
alter table audit_logs enable row level security;
alter table daily_usage_stats enable row level security;

create policy "super admin can read admin profiles"
on admin_profiles for select
to authenticated
using (is_super_admin());

create policy "super admin can read client installations"
on client_installations for select
to authenticated
using (is_super_admin());

create policy "super admin can manage release bundles"
on release_bundles for all
to authenticated
using (is_super_admin())
with check (is_super_admin());

create policy "super admin can read agent bundle inventory"
on agent_bundle_inventory for select
to authenticated
using (is_super_admin());

create policy "super admin can read scan jobs"
on scan_jobs for select
to authenticated
using (is_super_admin());

create policy "super admin can read scan steps"
on scan_steps for select
to authenticated
using (is_super_admin());

create policy "super admin can read scan reports"
on scan_reports for select
to authenticated
using (is_super_admin());

create policy "super admin can read scan findings"
on scan_findings for select
to authenticated
using (is_super_admin());

create policy "super admin can read dependency findings"
on dependency_findings for select
to authenticated
using (is_super_admin());

create policy "super admin can manage rule feedback"
on rule_feedback for all
to authenticated
using (is_super_admin())
with check (is_super_admin());

create policy "super admin can manage review notes"
on review_notes for all
to authenticated
using (is_super_admin())
with check (is_super_admin());

create policy "super admin can read usage events"
on usage_events for select
to authenticated
using (is_super_admin());

create policy "super admin can read audit logs"
on audit_logs for select
to authenticated
using (is_super_admin());

create policy "super admin can read daily usage stats"
on daily_usage_stats for select
to authenticated
using (is_super_admin());

-- Insert/update for metadata and inventory must be performed by a trusted backend
-- or Supabase Edge Function with the service role key, never by browser clients.
