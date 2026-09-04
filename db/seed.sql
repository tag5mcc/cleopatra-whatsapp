-- =====================================================================
-- CLEÓPATRA — dados iniciais
-- Rode depois do schema.sql. Ajuste preços e limites antes.
-- =====================================================================

insert into app_settings (key, value, description) values
  ('free_message_limit',   '12',
   'Quantas mensagens a usuária pode enviar antes de precisar assinar.'),
  ('free_warning_at',      '9',
   'A partir desta mensagem a Cleópatra começa a convidar para assinar, sem contar números.'),
  ('ai_model',             '"claude-sonnet-5"',
   'Modelo usado nas respostas.'),
  ('ai_model_extraction',  '"claude-haiku-4-5-20251001"',
   'Modelo usado na extração de memória (tarefa mecânica, modelo mais barato).'),
  ('ai_price_input',       '0.000003',
   'USD por token de entrada, para o cálculo de custo estimado.'),
  ('ai_price_output',      '0.000015',
   'USD por token de saída.'),
  ('wa_price_utility',     '0.008',
   'USD estimado por conversa de utilidade iniciada pela empresa.'),
  ('followup_daily_cap',   '1',
   'Máximo de mensagens proativas por usuária por dia.'),
  ('followup_weekly_cap',  '3',
   'Máximo de mensagens proativas por usuária por semana.'),
  ('wa_account_daily_cap', '200',
   'Teto de conversas iniciadas pela empresa em 24h. Mantenha abaixo do limite da conta no Gerenciador do WhatsApp (250 no tier inicial).'),
  ('history_window',       '16',
   'Quantas mensagens recentes entram no contexto da IA.')
on conflict (key) do nothing;

insert into plans (name, slug, price_cents, period, benefits, message_limit, checkout_url, sort_order) values
  ('Mensal',     'mensal',     4700,  'monthly',
   array['Conversas ilimitadas','Memória contínua','Lembretes e acompanhamento'], null,
   'https://pay.kiwify.com.br/SUBSTITUA', 1),
  ('Trimestral', 'trimestral', 11700, 'quarterly',
   array['Tudo do mensal','Economia de 17%'], null,
   'https://pay.kiwify.com.br/SUBSTITUA', 2),
  ('Anual',      'anual',      35700, 'yearly',
   array['Tudo do mensal','Economia de 37%'], null,
   'https://pay.kiwify.com.br/SUBSTITUA', 3)
on conflict (slug) do nothing;

-- Submeta estes três no Gerenciador do WhatsApp ANTES de precisar deles.
-- A aprovação leva de horas a dias. Categoria UTILITY (não MARKETING).
insert into whatsapp_templates (name, category, body, variables) values
  ('lembrete_combinado', 'UTILITY',
   'Oi {{1}}. Você me pediu para lembrar sobre {{2}}. Quer conversar agora?',
   array['nome','assunto']),
  ('followup_evento', 'UTILITY',
   'Oi {{1}}. Você tinha me contado sobre {{2}}. Como você está hoje?',
   array['nome','evento']),
  ('assinatura_ativada', 'UTILITY',
   'Pronto, {{1}}. Seu acesso está ativo e eu continuo de onde paramos.',
   array['nome'])
on conflict (name) do nothing;
