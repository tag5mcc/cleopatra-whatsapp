// Diagnóstico. Abra no navegador:
//   /api/diagnostico?secret=SEU_INTERNAL_SECRET&to=5541999999999
//
// Ele confere as variáveis de ambiente, testa o Supabase e tenta enviar uma
// mensagem pelo WhatsApp, devolvendo a resposta CRUA da Meta. É a forma mais
// direta de descobrir por que a Cleópatra não consegue responder.
//
// Este arquivo pode ser apagado depois que tudo estiver funcionando.

async function handler(req, res) {
  const secret = process.env.INTERNAL_SECRET;
  if (!secret || req.query?.secret !== secret) {
    return res.status(401).json({ erro: 'Informe ?secret=SEU_INTERNAL_SECRET na URL.' });
  }

  const resultado = { etapas: {} };
  const mascarar = (v) => (v ? `${String(v).slice(0, 6)}…(${String(v).length} caracteres)` : 'AUSENTE');

  // ---------- 1. variáveis de ambiente ----------
  resultado.etapas['1_variaveis'] = {
    ANTHROPIC_API_KEY: mascarar(process.env.ANTHROPIC_API_KEY),
    SUPABASE_URL: process.env.SUPABASE_URL || 'AUSENTE',
    SUPABASE_SERVICE_ROLE_KEY: mascarar(process.env.SUPABASE_SERVICE_ROLE_KEY),
    WHATSAPP_TOKEN: mascarar(process.env.WHATSAPP_TOKEN),
    WHATSAPP_PHONE_NUMBER_ID: process.env.WHATSAPP_PHONE_NUMBER_ID || 'AUSENTE',
    META_APP_SECRET: mascarar(process.env.META_APP_SECRET),
    WHATSAPP_VERIFY_TOKEN: mascarar(process.env.WHATSAPP_VERIFY_TOKEN)
  };

  // ---------- 2. Supabase ----------
  try {
    const { db } = require('../lib/db');
    const { count, error } = await db()
      .from('users').select('id', { count: 'exact', head: true });
    resultado.etapas['2_supabase'] = error
      ? { ok: false, erro: error.message }
      : { ok: true, usuarias: count };
  } catch (e) {
    resultado.etapas['2_supabase'] = { ok: false, erro: e.message };
  }

  // ---------- 3. o token enxerga o número? ----------
  try {
    const r = await fetch(
      `https://graph.facebook.com/v21.0/${process.env.WHATSAPP_PHONE_NUMBER_ID}?fields=display_phone_number,verified_name,quality_rating`,
      { headers: { Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}` } }
    );
    resultado.etapas['3_numero'] = { http: r.status, resposta: await r.json() };
  } catch (e) {
    resultado.etapas['3_numero'] = { erro: e.message };
  }

  // ---------- 4. envio de teste ----------
  const to = req.query?.to;
  if (!to) {
    resultado.etapas['4_envio'] = 'Acrescente &to=55DDDNUMERO na URL para testar o envio.';
  } else {
    try {
      const r = await fetch(
        `https://graph.facebook.com/v21.0/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            messaging_product: 'whatsapp',
            recipient_type: 'individual',
            to: String(to).replace(/\D/g, ''),
            type: 'text',
            text: { preview_url: false, body: 'Teste de diagnóstico da Cleópatra.' }
          })
        }
      );
      resultado.etapas['4_envio'] = { http: r.status, resposta: await r.json() };
    } catch (e) {
      resultado.etapas['4_envio'] = { erro: e.message };
    }
  }

  // ---------- 5. IA ----------
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY || '',
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-5',
        max_tokens: 10,
        messages: [{ role: 'user', content: 'diga apenas: ok' }]
      })
    });
    const j = await r.json();
    resultado.etapas['5_ia'] = r.ok
      ? { ok: true, resposta: j.content?.[0]?.text }
      : { ok: false, http: r.status, erro: j.error };
  } catch (e) {
    resultado.etapas['5_ia'] = { ok: false, erro: e.message };
  }

  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  return res.status(200).send(JSON.stringify(resultado, null, 2));
}

module.exports = handler;
module.exports.default = handler;
