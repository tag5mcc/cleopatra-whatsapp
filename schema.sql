-- =====================================================================
-- CLEÓPATRA — esquema do banco (Supabase / PostgreSQL)
-- Rode este arquivo inteiro no SQL Editor do Supabase, uma única vez.
-- =====================================================================

create extension if not exists "pgcrypto";
create extension if not exists "vector";
create extension if not exists "unaccent";

-- Configuração de busca em português sem acento (para recuperar memória)
do $$
begin
  if not exists (select 1 from pg_ts_config where cfgname = 'pt_unaccent') then
    create text search configuration pt_unaccent (copy = portuguese);
    alter text search configuration pt_unaccent
      alter mapping for hword, hword_part, word with unaccent, portuguese_stem;
  end if;
end $$;

-- =====================================================================
-- CONFIGURAÇÃO GLOBAL
-- =====================================================================

create table if not exists app_settings (
  key         text primary key,
  value       jsonb not null,
  description text,
  updated_at  timestamptz not null default now()
);

comment on table app_settings is
  'Configuração editável pelo admin: limite grátis, modelo de IA, preços de token. Nada disso deve ficar no código.';

-- =====================================================================
-- IDENTIDADE
-- A chave da usuária é o telefone. E-mail é secundário (casa o pagamento).
-- =====================================================================

create table if not exists users (
  id                  uuid primary key default gen_random_uuid(),
  phone_e164          text unique not null,
  wa_id               text unique,
  name                text,
  nickname            text,
  email               text,
  status              text not null default 'active'
                        check (status in ('active','blocked','deleted')),
  free_messages_used  int  not null default 0,
  onboarding_stage    text not null default 'new'
                        check (onboarding_stage in ('new','in_progress','done')),
  last_seen_at        timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create index if not exists users_email_idx on users (lower(email));

-- MEMÓRIA 1 — perfil
create table if not exists profiles (
  user_id             uuid primary key references users(id) on delete cascade,
  age                 int,
  relationship_status text,
  goals               text[] default '{}',
  preferences         jsonb  default '{}'::jsonb,
  communication_style text,
  boundaries          text[] default '{}',
  concerns            text[] default '{}',
  summary             text,
  updated_at          timestamptz not null default now()
);

-- MEMÓRIA 2 — pessoas importantes
create table if not exists people (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references users(id) on delete cascade,
  name        text not null,
  aliases     text[] default '{}',
  relation    text,
  status      text,
  since_label text,
  last_event  text,
  user_goal   text,
  is_primary  boolean not null default false,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (user_id, name)
);

create index if not exists people_user_idx on people (user_id);

-- MEMÓRIA 4 e 5 — decisões, padrões e fatos soltos
create table if not exists memories (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references users(id) on delete cascade,
  person_id     uuid references people(id) on delete set null,
  kind          text not null check (kind in ('fact','decision','pattern','preference')),
  content       text not null,
  result        text,
  status        text not null default 'open' check (status in ('open','closed')),
  confidence    numeric(3,2) default 0.80,
  source_message_id uuid,
  search_tsv    tsvector generated always as
                  (to_tsvector('pt_unaccent', coalesce(content,'') || ' ' || coalesce(result,''))) stored,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index if not exists memories_user_idx  on memories (user_id, kind);
create index if not exists memories_tsv_idx   on memories using gin (search_tsv);

-- Reservado para a fase de busca semântica (ver README, seção "Recuperação")
create table if not exists memory_embeddings (
  memory_id  uuid primary key references memories(id) on delete cascade,
  embedding  vector(1024),
  created_at timestamptz not null default now()
);

-- MEMÓRIA 3 — eventos
create table if not exists events (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null references users(id) on delete cascade,
  person_id         uuid references people(id) on delete set null,
  occurred_on       date not null,
  description       text not null,
  confirmed_by_user boolean not null default false,
  hidden            boolean not null default false,
  edited            boolean not null default false,
  created_at        timestamptz not null default now()
);

create index if not exists events_user_idx on events (user_id, occurred_on desc);

-- =====================================================================
-- CONVERSA
-- =====================================================================

create table if not exists conversations (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references users(id) on delete cascade,
  channel         text not null default 'whatsapp',
  last_message_at timestamptz,
  created_at      timestamptz not null default now()
);

create index if not exists conversations_user_idx on conversations (user_id, last_message_at desc);

create table if not exists messages (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references users(id) on delete cascade,
  conversation_id uuid references conversations(id) on delete cascade,
  role            text not null check (role in ('user','assistant','system')),
  content         text,
  media_url       text,
  media_type      text,
  intent          text,
  wa_message_id   text unique,
  status          text not null default 'received'
                    check (status in ('queued','processing','received','sent','failed','skipped')),
  error           text,
  created_at      timestamptz not null default now()
);

create index if not exists messages_user_idx   on messages (user_id, created_at desc);
create index if not exists messages_queue_idx  on messages (status, created_at)
  where status in ('queued','processing');

-- =====================================================================
-- CANAL WHATSAPP
-- =====================================================================

create table if not exists whatsapp_contacts (
  user_id           uuid primary key references users(id) on delete cascade,
  wa_id             text unique not null,
  profile_name      text,
  window_expires_at timestamptz,          -- janela de 24h da Meta
  opt_in            boolean not null default false,
  opt_in_at         timestamptz,
  opt_out_at        timestamptz,
  updated_at        timestamptz not null default now()
);

create table if not exists whatsapp_messages (
  id                    uuid primary key default gen_random_uuid(),
  user_id               uuid references users(id) on delete set null,
  message_id            uuid references messages(id) on delete set null,
  direction             text not null check (direction in ('inbound','outbound')),
  wa_message_id         text,
  status                text,
  template_name         text,
  conversation_category text,
  payload               jsonb,
  created_at            timestamptz not null default now()
);

create index if not exists wa_messages_waid_idx on whatsapp_messages (wa_message_id);

create table if not exists whatsapp_templates (
  id          uuid primary key default gen_random_uuid(),
  name        text unique not null,
  language    text not null default 'pt_BR',
  category    text not null default 'UTILITY',
  body        text not null,
  variables   text[] default '{}',
  meta_status text not null default 'pending'
                check (meta_status in ('pending','approved','rejected','paused')),
  created_at  timestamptz not null default now()
);

-- =====================================================================
-- PROATIVIDADE — lembretes e follow-ups
-- =====================================================================

create table if not exists reminders (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references users(id) on delete cascade,
  person_id     uuid references people(id) on delete set null,
  kind          text not null default 'reminder' check (kind in ('reminder','followup')),
  subject       text not null,
  due_at        timestamptz not null,
  template_name text,
  status        text not null default 'pending'
                  check (status in ('pending','sent','cancelled','failed')),
  sent_at       timestamptz,
  attempts      int not null default 0,
  created_at    timestamptz not null default now()
);

create index if not exists reminders_due_idx on reminders (status, due_at);

-- =====================================================================
-- MONETIZAÇÃO
-- =====================================================================

create table if not exists plans (
  id            uuid primary key default gen_random_uuid(),
  name          text not null,
  slug          text unique not null,
  price_cents   int  not null,
  currency      text not null default 'BRL',
  period        text not null check (period in ('monthly','quarterly','yearly','lifetime')),
  benefits      text[] default '{}',
  message_limit int,                       -- null = ilimitado
  checkout_url  text,
  status        text not null default 'active' check (status in ('active','archived')),
  sort_order    int not null default 0,
  created_at    timestamptz not null default now()
);

create table if not exists subscriptions (
  id                 uuid primary key default gen_random_uuid(),
  user_id            uuid not null references users(id) on delete cascade,
  plan_id            uuid references plans(id) on delete set null,
  status             text not null default 'pending'
                       check (status in ('pending','active','cancelled','expired','refunded','past_due')),
  provider           text,
  provider_ref       text,
  current_period_end timestamptz,
  started_at         timestamptz,
  cancelled_at       timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create index if not exists subscriptions_user_idx on subscriptions (user_id, status);

create table if not exists payments (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid references users(id) on delete set null,
  subscription_id uuid references subscriptions(id) on delete set null,
  amount_cents    int,
  currency        text default 'BRL',
  provider        text,
  provider_ref    text,
  event_type      text,
  raw_payload     jsonb,
  created_at      timestamptz not null default now()
);

-- =====================================================================
-- CUSTO E LGPD
-- =====================================================================

create table if not exists ai_usage (
  id                       uuid primary key default gen_random_uuid(),
  user_id                  uuid references users(id) on delete set null,
  conversation_id          uuid references conversations(id) on delete set null,
  purpose                  text,             -- 'reply' | 'extract' | 'followup'
  model                    text,
  input_tokens             int default 0,
  output_tokens            int default 0,
  estimated_ai_cost        numeric(10,6) default 0,
  whatsapp_message_type    text,
  estimated_whatsapp_cost  numeric(10,6) default 0,
  created_at               timestamptz not null default now()
);

create index if not exists ai_usage_user_idx on ai_usage (user_id, created_at desc);

create table if not exists privacy_consents (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references users(id) on delete cascade,
  consent_type text not null check (consent_type in ('memory','followup','terms')),
  granted      boolean not null,
  source       text,
  granted_at   timestamptz,
  revoked_at   timestamptz,
  created_at   timestamptz not null default now()
);

create index if not exists consents_user_idx on privacy_consents (user_id, consent_type);

create table if not exists audit_log (
  id         uuid primary key default gen_random_uuid(),
  actor      text,
  action     text not null,
  user_id    uuid,
  detail     jsonb,
  created_at timestamptz not null default now()
);

-- =====================================================================
-- RLS
-- O backend usa a service_role key e passa por cima das políticas.
-- As políticas abaixo servem ao painel da usuária (Supabase Auth), que
-- só enxerga as próprias linhas. Sem política = ninguém lê pela anon key.
-- =====================================================================

alter table users              enable row level security;
alter table profiles           enable row level security;
alter table people             enable row level security;
alter table memories           enable row level security;
alter table memory_embeddings  enable row level security;
alter table events             enable row level security;
alter table conversations      enable row level security;
alter table messages           enable row level security;
alter table whatsapp_contacts  enable row level security;
alter table whatsapp_messages  enable row level security;
alter table reminders          enable row level security;
alter table subscriptions      enable row level security;
alter table payments           enable row level security;
alter table ai_usage           enable row level security;
alter table privacy_consents   enable row level security;
alter table audit_log          enable row level security;
alter table app_settings       enable row level security;
alter table whatsapp_templates enable row level security;

-- plans é público (a landing precisa mostrar preço)
alter table plans enable row level security;
drop policy if exists plans_public_read on plans;
create policy plans_public_read on plans
  for select using (status = 'active');

-- A usuária logada enxerga as próprias linhas.
-- Requer users.id = auth.uid() (criado no momento do login por telefone).
do $$
declare t text;
begin
  foreach t in array array[
    'profiles','people','memories','events','conversations','messages',
    'whatsapp_contacts','reminders','subscriptions','privacy_consents'
  ] loop
    execute format('drop policy if exists %I_own on %I;', t, t);
    execute format(
      'create policy %I_own on %I for select using (user_id = auth.uid());', t, t);
  end loop;
end $$;

drop policy if exists users_own on users;
create policy users_own on users for select using (id = auth.uid());

-- =====================================================================
-- updated_at automático
-- =====================================================================

create or replace function touch_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

do $$
declare t text;
begin
  foreach t in array array[
    'users','profiles','people','memories','subscriptions','whatsapp_contacts','app_settings'
  ] loop
    execute format('drop trigger if exists trg_touch_%I on %I;', t, t);
    execute format(
      'create trigger trg_touch_%I before update on %I
       for each row execute function touch_updated_at();', t, t);
  end loop;
end $$;
