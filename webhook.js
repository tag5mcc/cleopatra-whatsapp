// Webhook oficial da WhatsApp Cloud API.
//
// A Meta espera resposta em poucos segundos. O ciclo completo da Cleópatra
// (memória + resposta + extração) leva mais que isso. Por isso este arquivo
// NÃO processa nada: valida, grava na fila, responde 200 e dispara o worker
// sem esperar. Se o worker falhar, o cron pega a mensagem depois.

const { db } = require('../../lib/db');
const { verifySignature } = require('../../lib/whatsapp');

// Precisamos do corpo cru para conferir a assinatura HMAC da Meta.
module.exports.config = { api: { bodyParser: false } };

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

module.exports = async function handler(req, res) {
  // --- verificação do webhook (a Meta chama uma vez, na configuração) ---
  if (req.method === 'GET') {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    if (mode === 'subscribe' && token === process.env.WHATSAPP_VERIFY_TOKEN) {
      return res.status(200).send(challenge);
    }
    return res.status(403).send('Token de verificação inválido.');
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Método não permitido' });
  }

  let raw, body;
  try {
    raw = await readRawBody(req);
    body = JSON.parse(raw.toString('utf8'));
  } catch (e) {
    return res.status(400).json({ error: 'Corpo inválido.' });
  }

  if (!verifySignature(raw, req.headers['x-hub-signature-256'])) {
    console.error('Webhook com assinatura inválida — descartado.');
    return res.status(401).json({ error: 'Assinatura inválida.' });
  }

  // Responde imediatamente. Tudo abaixo é best-effort.
  res.status(200).json({ received: true });

  try {
    const supabase = db();
    const jobs = [];

    for (const entry of body.entry || []) {
      for (const change of entry.changes || []) {
        const value = change.value || {};

        // Atualizações de status (entregue, lida, falhou)
        for (const status of value.statuses || []) {
          await supabase.from('whatsapp_messages')
            .update({ status: status.status })
            .eq('wa_message_id', status.id)
            .then(() => {}, () => {});
        }

        const contactName = value.contacts?.[0]?.profile?.name || null;

        for (const msg of value.messages || []) {
          // Ignora tipos que ainda não tratamos (áudio, localização, contato)
          const supported = ['text', 'image', 'interactive', 'button'];
          if (!supported.includes(msg.type)) {
            jobs.push({ unsupported: true, waId: msg.from, type: msg.type });
            continue;
          }

          let text = null, mediaId = null, buttonId = null;
          if (msg.type === 'text') text = msg.text?.body || '';
          if (msg.type === 'image') { mediaId = msg.image?.id; text = msg.image?.caption || null; }
          if (msg.type === 'interactive') buttonId = msg.interactive?.button_reply?.id || msg.interactive?.list_reply?.id || null;
          if (msg.type === 'button') { text = msg.button?.text || null; buttonId = msg.button?.payload || null; }

          // A partir de 2026 o campo `from` pode trazer um BSUID em vez do
          // telefone, quando a usuária adota nome de usuário no WhatsApp.
          const sender = msg.from || value.contacts?.[0]?.user_id || msg.user_id;
          if (!sender) {
            console.error('Mensagem sem identificador de remetente:', msg.id);
            continue;
          }

          // Idempotência: a Meta reenvia quando não recebe 200 a tempo.
          const { data: dup } = await supabase.from('whatsapp_messages')
            .select('id').eq('wa_message_id', msg.id).maybeSingle();
          if (dup) continue;

          await supabase.from('whatsapp_messages').insert({
            direction: 'inbound',
            wa_message_id: msg.id,
            status: 'queued',
            payload: { from: sender, type: msg.type, text, mediaId, buttonId, profileName: contactName }
          });

          jobs.push({ waId: sender, profileName: contactName, text, mediaId, buttonId, waMessageId: msg.id });
        }
      }
    }

    if (!jobs.length) return;

    // Dispara o worker sem aguardar a conclusão.
    const base = process.env.PUBLIC_BASE_URL || `https://${req.headers.host}`;
    fetch(`${base}/api/whatsapp/process`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-internal-secret': process.env.INTERNAL_SECRET || ''
      },
      body: JSON.stringify({ jobs })
    }).catch((e) => console.error('Falha ao acionar o worker:', e.message));

  } catch (e) {
    console.error('Erro ao enfileirar mensagem:', e);
  }
};
