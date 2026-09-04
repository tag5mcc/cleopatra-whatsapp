-- =====================================================================
-- Migração 003 — identidade sem telefone
--
-- Por quê: a Meta está lançando nomes de usuário no WhatsApp em 2026. Quando
-- uma usuária adota um nome de usuário, o webhook pode entregar um
-- Business-Scoped User ID (BSUID) no lugar do telefone. O schema original
-- exigia users.phone_e164 NOT NULL, o que faria a criação da usuária falhar
-- e a mensagem dela cair no vazio.
--
-- A partir daqui a chave passa a ser wa_id (telefone OU BSUID), e o telefone
-- vira opcional. Isso também abre caminho caso você opte por operar apenas
-- com nome de exibição, sem número.
-- =====================================================================

alter table users alter column phone_e164 drop not null;

-- wa_id passa a ser obrigatório: é ele que identifica a usuária no canal.
update users set wa_id = replace(phone_e164, '+', '')
 where wa_id is null and phone_e164 is not null;

alter table users alter column wa_id set not null;

-- Guarda qual é a natureza do identificador, para não confundir os dois.
alter table users add column if not exists wa_id_type text
  not null default 'phone' check (wa_id_type in ('phone','bsuid'));

comment on column users.wa_id is
  'Identificador da usuária no WhatsApp: telefone sem + ou BSUID, conforme wa_id_type.';
