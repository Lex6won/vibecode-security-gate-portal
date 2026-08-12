-- =============================================================================
-- VibeCode Security Gate Portal — PostgreSQL 16 스키마 (기관 승인 스택)
-- 2026-08-12 초안. supabase/schema.sql(폐기 예정)을 대체한다.
--
-- 설계 원칙
--  1) Supabase 금지: auth.users / auth.uid() / RLS 정책 / Edge Function 의존 없음.
--     접근 통제는 DB 롤 + 서버측 API에서 수행한다.
--  2) 인증 직접구현 금지: 관리자 신원은 기관 통합인증(Keycloak OIDC/SSO/GPKI)의
--     subject를 저장할 뿐, 비밀번호를 이 DB에 두지 않는다.
--  3) 익명 메타데이터만 저장: 소스 코드·압축 원본·토큰·이름·부서·로컬 전체 경로 금지.
--  4) 2계층 분리(웹사이트DB구상 2026-08-09): 체커가 쓰는 것(observations)과
--     사람이 승인한 것(decisions)을 분리한다. 체커는 decisions만 읽는다(순환 차단).
--  5) 심사 큐 보호: source_scope가 single/manifest인 관측만 심사 대기열 대상.
--     lockfile/installed는 관측 저장만 한다(연동합의 r6).
-- =============================================================================

create extension if not exists pgcrypto;

-- ---------- enum: docs 02/03/04와 실제 코드(server.js)를 통일한 확정값 ----------

-- 검사 모드: 02_screen_function_spec 기준. 제출용 전체 점검은 'full'.
create type scan_mode as enum ('quick', 'standard', 'full');

create type client_type as enum ('local_web', 'desktop', 'mcp');
create type target_type as enum ('folder', 'archive', 'github_url', 'browser_folder', 'browser_archive');
create type scan_status as enum ('queued', 'running', 'completed', 'failed', 'cancelled');

-- 작업(job) 판정: server.js 실제 값과 일치시킨다.
-- (구 문서의 submittable→allow, needs_fix는 finding 레벨로 흡수)
create type scan_decision as enum ('allow', 'quick_complete', 'needs_review', 'blocked', 'incomplete');

-- 발견(finding) 판정: 04_checker_improvement_backlog P0-2의 6상태 모델.
create type finding_decision as enum (
  'confirmed_block', 'review_required', 'warning',
  'false_positive_candidate', 'not_scanned', 'pass'
);

-- 검사 단계: 설치 패키지·벤더 번들 검사를 1급 단계로 승격(01 §5-5, 04 P0-1).
create type scan_step_name as enum (
  'prepare_target', 'code_scan', 'dependency_scan',
  'installed_packages_scan', 'vendor_bundle_scan',
  'render_report', 'save_reports'
);

create type network_mode as enum ('online', 'offline', 'limited');
create type finding_severity as enum ('critical', 'high', 'medium', 'low', 'info');
create type confidence_level as enum ('high', 'medium', 'low');
create type report_type as enum ('html', 'json', 'markdown', 'sarif', 'submission_zip');
create type report_status as enum ('pending', 'generated', 'saved', 'uploaded', 'failed');
create type reachability as enum ('reachable', 'not_reachable', 'unknown');
create type sync_status as enum ('not_enabled', 'pending', 'synced', 'failed');
create type review_status as enum ('confirmed', 'false_positive', 'accepted_risk', 'needs_fix', 'needs_rule_change');
create type feedback_type as enum ('false_positive', 'over_detection', 'missed_detection', 'message_improvement', 'dependency_reachability');

-- 패키지 관측·판정(3자 구조 정렬)
create type source_scope as enum ('single', 'manifest', 'lockfile', 'installed');
create type package_verdict as enum ('approved', 'rejected');

-- ---------- 관리자: 기관 통합인증 연계 (비밀번호 없음) ----------

create table admin_accounts (
  id uuid primary key default gen_random_uuid(),
  idp_subject varchar(255) unique not null,       -- 기관 IdP(OIDC sub / GPKI DN) 식별자
  login_id varchar(80) unique not null,           -- 표시용 기관 계정(예: 기관 메일)
  display_name varchar(80) not null,
  role varchar(30) not null default 'super_admin' check (role in ('super_admin')),
  is_active boolean not null default true,
  last_login_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ---------- 클라이언트·검사 메타데이터 ----------

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

create table scan_jobs (
  id uuid primary key default gen_random_uuid(),
  anonymous_session_id varchar(80) not null,
  client_installation_id uuid references client_installations(id) on delete set null,
  project_name varchar(160),                      -- 표시명만. 로컬 전체 경로 금지
  target_type target_type not null,
  target_label varchar(500) not null,
  target_fingerprint_hash char(64),
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
  coverage_truncated boolean not null default false,   -- max-files 등으로 미완 검사 여부
  dependency_incomplete boolean not null default false,
  duration_ms integer,
  error_code varchar(80),
  error_summary text,
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz not null default now()
);

create table scan_steps (
  id uuid primary key default gen_random_uuid(),
  scan_job_id uuid not null references scan_jobs(id) on delete cascade,
  step_name scan_step_name not null,
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
  file_name varchar(255),
  file_path_label varchar(500),                   -- basename 수준 라벨만
  sha256 char(64),
  file_size bigint,
  created_at timestamptz not null default now()
);
-- 주: storage_object_path(Supabase Storage) 컬럼은 제거. 보고서 원본은 파일로 두고
--    해시만 대조한다(웹사이트DB구상 §5 '파일+해시' 권장안).

create table scan_findings (
  id uuid primary key default gen_random_uuid(),
  scan_job_id uuid not null references scan_jobs(id) on delete cascade,
  rule_id varchar(120) not null,
  rule_name varchar(255),
  severity finding_severity not null,
  decision finding_decision not null,
  file_path_hash char(64),
  file_ext varchar(20),
  path_depth integer,
  line_start integer,
  line_end integer,
  evidence_summary text,                          -- 마스킹된 요약만. 원문 코드 금지
  safe_fix text,
  confidence confidence_level not null default 'medium',
  created_at timestamptz not null default now()
);
-- 주: is_false_positive_candidate boolean은 finding_decision의
--    'false_positive_candidate' 값으로 흡수(이중 표현 제거).

create table dependency_findings (
  id uuid primary key default gen_random_uuid(),
  scan_job_id uuid not null references scan_jobs(id) on delete cascade,
  package_name varchar(255) not null,
  package_version varchar(80),
  ecosystem varchar(40) not null,
  source_scope source_scope not null default 'manifest',
  vulnerability_id varchar(80) not null,
  severity finding_severity not null,
  reachable reachability not null default 'unknown',
  in_kev boolean,
  kev_checked boolean not null default false,     -- false면 in_kev는 '대조 못 함'을 뜻함
  fixed_version varchar(80),
  dependency_path text,
  created_at timestamptz not null default now()
);

-- ---------- 2계층: 패키지 관측(기계) / 판정(사람) ----------

create table package_observations (
  id uuid primary key default gen_random_uuid(),
  ecosystem varchar(40) not null,
  package_name varchar(255) not null,
  package_version varchar(80) not null,           -- 버전 미확정 관측은 제출하지 않는다(§5-D)
  source_scope source_scope not null,
  checker_version varchar(40),
  verdict_at_scan varchar(40),                    -- 체커 verdict 사다리 값 스냅샷
  observed_at timestamptz not null default now(),
  anonymous_client_id varchar(80),
  unique (ecosystem, package_name, package_version, source_scope, anonymous_client_id, observed_at)
);
-- 체커·포털이 기록한다. 사람 판정의 입력 참고자료일 뿐,
-- 어떤 자동 로직도 이 테이블을 근거로 승인하지 않는다.

create table package_decisions (
  id uuid primary key default gen_random_uuid(),
  ecosystem varchar(40) not null,
  package_name varchar(255) not null,
  package_version varchar(80) not null,
  verdict package_verdict not null,
  decided_by uuid not null references admin_accounts(id),
  decided_at timestamptz not null default now(),
  reason text,
  superseded_by uuid references package_decisions(id),
  unique (ecosystem, package_name, package_version, decided_at)
);
-- 사람(보안담당)만 쓴다. 체커·포털은 읽기만 한다(순환 구조 차단).
-- 유효기간 비대칭(연동합의): approved는 신선도 1시간 요구, rejected는 7일 뒤
-- '낡은 차단'으로 강등하되 삭제하지 않는다. 만료 처리는 조회 시점 계산으로 하고
-- 행을 지우지 않는다(이력 보존).

create table package_review_queue (
  id uuid primary key default gen_random_uuid(),
  ecosystem varchar(40) not null,
  package_name varchar(255) not null,
  package_version varchar(80) not null,
  source_scope source_scope not null check (source_scope in ('single', 'manifest')),
  requested_at timestamptz not null default now(),
  resolved_decision_id uuid references package_decisions(id),
  unique (ecosystem, package_name, package_version)
);
-- check 제약이 심사 큐 보호 규칙을 스키마 수준에서 강제한다:
-- lockfile/installed 관측은 큐에 들어올 수 없다.

-- ---------- 피드백·감사·통계 ----------

create table rule_feedback (
  id uuid primary key default gen_random_uuid(),
  scan_job_id uuid references scan_jobs(id) on delete set null,
  finding_id uuid references scan_findings(id) on delete set null,
  dependency_finding_id uuid references dependency_findings(id) on delete set null,
  feedback_type feedback_type not null,
  status review_status not null default 'needs_rule_change',
  rule_id varchar(120),
  note text,
  reviewer_id uuid references admin_accounts(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table review_notes (
  id uuid primary key default gen_random_uuid(),
  scan_job_id uuid not null references scan_jobs(id) on delete cascade,
  finding_id uuid references scan_findings(id) on delete set null,
  dependency_finding_id uuid references dependency_findings(id) on delete set null,
  reviewer_id uuid references admin_accounts(id) on delete set null,
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
  admin_account_id uuid references admin_accounts(id) on delete set null,
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
  needs_review_count integer not null default 0,
  blocked_count integer not null default 0,
  allow_count integer not null default 0,
  primary key (stat_date, client_type, scan_mode, target_type)
);
-- 집계 주체: 포털 백엔드의 일 1회 배치(자정 KST). 트리거 집계는 쓰지 않는다.

-- ---------- 인덱스 ----------

create index idx_scan_jobs_created_at on scan_jobs(created_at desc);
create index idx_scan_jobs_decision_created_at on scan_jobs(decision, created_at desc);
create index idx_scan_jobs_target_type_created_at on scan_jobs(target_type, created_at desc);
create index idx_scan_jobs_scan_mode_created_at on scan_jobs(scan_mode, created_at desc);
create index idx_scan_jobs_session_created_at on scan_jobs(anonymous_session_id, created_at desc);
create index idx_scan_steps_job on scan_steps(scan_job_id, created_at);
create index idx_usage_events_event_created_at on usage_events(event_type, created_at desc);
create index idx_scan_findings_job_severity on scan_findings(scan_job_id, severity);
create index idx_scan_findings_rule_created_at on scan_findings(rule_id, created_at desc);
create index idx_dependency_findings_job_severity on dependency_findings(scan_job_id, severity);
create index idx_scan_reports_job_type on scan_reports(scan_job_id, report_type);
create index idx_audit_logs_admin_created_at on audit_logs(admin_account_id, created_at desc);
create index idx_package_observations_pkg on package_observations(ecosystem, package_name, package_version);
create index idx_package_decisions_pkg on package_decisions(ecosystem, package_name, package_version, decided_at desc);

-- ---------- 접근 통제: DB 롤 (RLS 대신) ----------
-- 브라우저는 DB에 직접 접근하지 않는다. 모든 접근은 포털 백엔드를 거친다.

-- 포털 백엔드 서비스 계정: 메타데이터 기록 + 판정 조회
create role portal_app noinherit login;
grant select, insert, update on
  client_installations, scan_jobs, scan_steps, scan_reports,
  scan_findings, dependency_findings, package_observations,
  package_review_queue, usage_events, daily_usage_stats, rule_feedback
  to portal_app;
grant select on package_decisions, admin_accounts to portal_app;
-- portal_app은 package_decisions에 쓸 수 없다(사람 판정 전용).

-- 판정 기록 계정: 보안담당 심사 화면 전용 백엔드 경로
create role portal_review noinherit login;
grant select, insert on package_decisions, review_notes, audit_logs to portal_review;
grant select, update on package_review_queue, rule_feedback to portal_review;
grant select on package_observations, scan_jobs, scan_findings, dependency_findings, admin_accounts to portal_review;

-- 삭제 권한은 어느 서비스 롤에도 부여하지 않는다(이력 보존).
