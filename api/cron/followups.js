// Cron: envia lembretes e follow-ups vencidos, e recupera mensagens
// que ficaram presas na fila. Configurado em vercel.json (a cada 10 min).
//
// Regras de convivência com a Meta:
//   - dentro da janela de 24h, mensagem livre;
//   - fora dela, só template aprovado;
//   - teto diário e semanal por usuária;
//   - quem deu opt-out nunca recebe nada.

const { db, getSetting } = require('../../lib/db');
const wa = require('../../lib/whatsapp');

module.exports = async function handler(req, res) {
  // Três formas de autorizar, porque no plano Hobby quem dispara isto é um
  // agendador externo (cron-job.org, UptimeRobot etc), que nem sempre
  // permite cabeçalhos personalizados. O segredo na URL resolve.
  const secret = process.env.INTERNAL_SECRET;
  const isVercelCron = req.headers['user-agent']?.includes('vercel-cron');
  const hasHeader = secret && req.headers['x-internal-secret'] === secret;
  const hasQuery = secret && req.query?.secret === secret;

  if (!isVercelCron && !hasHeader && !hasQuery) {
    return res.status(401).json({ error: 'Não autorizado.' });
  }

  const supabase = db();
  const now = new Date().toISOString();
  const sent = [];
  const skipped = [];

  const dailyCap = Number(await getSetting('followup_daily_cap', 1));
  const weeklyCap = Number(await getSetting('followup_weekly_cap', 3));

  // Teto da CONTA, não da usuária. A Meta limita conversas iniciadas pela
  // empresa em 24h (250 no tier inicial). Estourar devolve erro 131056 e
  // sujeita a nota de qualidade — pior, os lembretes simplesmente somem.
  // Mantemos folga abaixo do limite real da conta.
  const accountCap = Number(await getSetting('wa_account_daily_cap', 200));
  const dayAgoGlobal = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const { count: sentToday } = await supabase.from('reminders')
    .select('id', { count: 'exact', head: true })
    .eq('status', 'sent').gte('sent_at', dayAgoGlobal);

  let budget = accountCap - (sentToday || 0);
  if (budget <= 0) {
    console.warn(`Teto diário da conta atingido (${sentToday}/${accountCap}). Lembretes adiados.`);
    return res.status(200).json({ sent: 0, skipped: 0, reason: 'teto da conta' });
  }

  const { data: due, error } = await supabase.from('reminders')
    .select('id, user_id, kind, subject, template_name, attempts')
    .eq('status', 'pending').lte('due_at', now)
    .order('due_at').limit(40);

  if (error) return res.status(500).json({ error: error.message });

  for (const r of due || []) {
    // Só conversa iniciada pela empresa (fora da janela) consome o limite
    // da Meta. Dentro da janela é resposta livre e não conta.
    if (budget <= 0) {
      skipped.push({ id: r.id, why: 'orçamento diário esgotado' });
      continue;
    }
    try {
      const { data: user } = await supabase.from('users')
        .select('id, wa_id, name, status').eq('id', r.user_id).maybeSingle();

      if (!user || user.status !== 'active') {
        await supabase.from('reminders').update({ status: 'cancelled' }).eq('id', r.id);
        skipped.push({ id: r.id, why: 'usuária inativa' });
        continue;
      }

      // Opt-out manda em tudo
      const { data: contact } = await supabase.from('whatsapp_contacts')
        .select('opt_in, opt_out_at, window_expires_at').eq('user_id', user.id).maybeSingle();

      if (!contact?.opt_in || contact.opt_out_at) {
        await supabase.from('reminders').update({ status: 'cancelled' }).eq('id', r.id);
        skipped.push({ id: r.id, why: 'sem opt-in' });
        continue;
      }

      // Tetos de frequência
      const dayAgo = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
      const weekAgo = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();

      const [{ count: dayCount }, { count: weekCount }] = await Promise.all([
        supabase.from('reminders').select('id', { count: 'exact', head: true })
          .eq('user_id', user.id).eq('status', 'sent').gte('sent_at', dayAgo),
        supabase.from('reminders').select('id', { count: 'exact', head: true })
          .eq('user_id', user.id).eq('status', 'sent').gte('sent_at', weekAgo)
      ]);

      if ((dayCount || 0) >= dailyCap || (weekCount || 0) >= weeklyCap) {
        // Adia 24h em vez de descartar
        await supabase.from('reminders')
          .update({ due_at: new Date(Date.now() + 24 * 3600 * 1000).toISOString() })
          .eq('id', r.id);
        skipped.push({ id: r.id, why: 'teto de frequência' });
        continue;
      }

      const nome = user.name ? user.name.split(' ')[0] : 'você';
      const windowOpen = contact.window_expires_at && new Date(contact.window_expires_at) > new Date();

      if (windowOpen) {
        const texto = r.kind === 'reminder'
          ? `${nome}, você me pediu para lembrar sobre ${r.subject}. Quer conversar agora?`
          : `Oi ${nome}. Você tinha me contado sobre ${r.subject}. Como você está hoje?`;
        await wa.sendText(user.wa_id, texto, { userId: user.id });
      } else {
        // Fora da janela: só template aprovado, e isso consome o limite da conta.
        await wa.sendTemplate(
          user.wa_id,
          r.template_name || (r.kind === 'reminder' ? 'lembrete_combinado' : 'followup_evento'),
          [nome, r.subject],
          { userId: user.id }
        );
        budget--;
      }

      await supabase.from('reminders')
        .update({ status: 'sent', sent_at: new Date().toISOString() }).eq('id', r.id);

      // Registra o custo estimado da conversa iniciada pela empresa
      if (!windowOpen) {
        const waCost = Number(await getSetting('wa_price_utility', 0.008));
        await supabase.from('ai_usage').insert({
          user_id: user.id, purpose: 'followup',
          whatsapp_message_type: 'template', estimated_whatsapp_cost: waCost
        }).then(() => {}, () => {});
      }

      sent.push(r.id);

    } catch (e) {
      console.error('Falha ao enviar lembrete', r.id, e.message);
      const attempts = (r.attempts || 0) + 1;
      await supabase.from('reminders').update({
        attempts,
        status: attempts >= 3 ? 'failed' : 'pending',
        due_at: attempts >= 3 ? undefined : new Date(Date.now() + 3600 * 1000).toISOString()
      }).eq('id', r.id).then(() => {}, () => {});
    }
  }

  // Rede de segurança: mensagens presas há mais de 3 minutos
  const stuckSince = new Date(Date.now() - 3 * 60 * 1000).toISOString();
  const { data: stuck } = await supabase.from('whatsapp_messages')
    .select('wa_message_id, payload')
    .in('status', ['queued', 'processing']).eq('direction', 'inbound')
    .lt('created_at', stuckSince).limit(10);

  if (stuck?.length) {
    const base = process.env.PUBLIC_BASE_URL;
    if (base) {
      fetch(`${base}/api/whatsapp/process`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-internal-secret': process.env.INTERNAL_SECRET },
        body: JSON.stringify({
          jobs: stuck.map((s) => ({
            waId: s.payload?.from,
            profileName: s.payload?.profileName,
            text: s.payload?.text,
            mediaId: s.payload?.mediaId,
            buttonId: s.payload?.buttonId,
            waMessageId: s.wa_message_id
          }))
        })
      }).catch(() => {});
    }
  }

  return res.status(200).json({ sent: sent.length, skipped: skipped.length, requeued: stuck?.length || 0 });
};
