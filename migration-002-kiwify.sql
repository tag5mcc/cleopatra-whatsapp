-- =====================================================================
-- Migração 002 — Kiwify como gateway
-- Rode depois do schema.sql e do seed.sql.
-- =====================================================================

-- Cada plano passa a apontar para um produto/oferta da Kiwify, para o
-- webhook saber QUAL plano foi comprado em vez de chutar o primeiro.
alter table plans add column if not exists provider text default 'kiwify';
alter table plans add column if not exists provider_product_id text;

create index if not exists plans_provider_product_idx on plans (provider_product_id);

-- Link de checkout individual por usuária.
-- O id vai no parâmetro sck da URL e volta no webhook, o que dispensa
-- adivinhar quem pagou por e-mail ou telefone.
create table if not exists checkout_sessions (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references users(id) on delete cascade,
  plan_id      uuid references plans(id) on delete set null,
  tracking_ref text unique not null,
  status       text not null default 'open' check (status in ('open','converted','expired')),
  converted_at timestamptz,
  created_at   timestamptz not null default now()
);

create index if not exists checkout_sessions_ref_idx  on checkout_sessions (tracking_ref);
create index if not exists checkout_sessions_user_idx on checkout_sessions (user_id, status);

alter table checkout_sessions enable row level security;
drop policy if exists checkout_sessions_own on checkout_sessions;
create policy checkout_sessions_own on checkout_sessions
  for select using (user_id = auth.uid());

-- Preencha com o ID do produto de cada plano na Kiwify:
-- update plans set provider_product_id = 'xxxxxxxx' where slug = 'mensal';
