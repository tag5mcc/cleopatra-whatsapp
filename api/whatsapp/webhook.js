// Webhook oficial da WhatsApp Cloud API.
//
// ARQUITETURA SIMPLES, DE PROPÓSITO:
// Este arquivo faz tudo — recebe, grava e processa — e só então responde.
//
// Por que não separamos em um worker: na Vercel a função é encerrada no
// instante em que a resposta é enviada, então "responder rápido e processar
// depois" simplesmente não funciona sem pacotes extras. Cada peça a mais era
// mais um ponto de falha.
//
// E a demora não é problema: se a Meta não receber resposta a tempo, ela
// reenvia — e o reenvio é descartado pela checagem de wa_message_id logo
// abaixo. A usuária nunca recebe resposta duplicada.

const { db } = require('../../lib/db');
const { verifySignature } = require('../../lib/whatsapp');
const { receiveMessage } = require('../../lib/cleopatraEngine');
const wa = require('../../lib/whatsapp');

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function handler(req, res) {
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
    console.error('Corpo inválido:', e.message);
    return res.status(400).json({ error: 'Corpo inválido.' });
  }

  if (!verifySignature(raw, req.headers['x-hub-signature-256'])) {
    console.error('Webhook com assinatura inválida — descartado.');
    return res.status(401).json({ error: 'Assinatura inválida.' });
  }

  const supabase = db();
  const jobs = [];

  // ---------- 1. extrair as mensagens do payload ----------
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

        // O campo `from` pode trazer um BSUID em vez do telefone, quando a
        // usuária adota nome de usuário no WhatsApp (lançamento de 2026).
        const sender = msg.from || value.contacts?.[0]?.user_id || msg.user_id;
        if (!sender) {
          console.error('Mensagem sem identificador de remetente:', msg.id);
          continue;
        }

        // Idempotência: a Meta reenvia quando não recebe 200 a tempo.
        // A linha é gravada ANTES do processamento, então o reenvio para aqui.
        const { data: dup } = await supabase.from('whatsapp_messages')
          .select('id').eq('wa_message_id', msg.id).maybeSingle();

        if (dup) {
          console.log(`Mensagem ${msg.id} já recebida — reenvio ignorado.`);
          continue;
        }

        await supabase.from('whatsapp_messages').insert({
          direction: 'inbound',
          wa_message_id: msg.id,
          status: 'processing',
          payload: { from: sender, type: msg.type, text, mediaId, buttonId, profileName: contactName }
        });

        jobs.push({ waId: sender, profileName: contactName, text, mediaId, buttonId, waMessageId: msg.id });
      }
    }
  }

  console.log(`Webhook: ${jobs.length} mensagem(ns) para processar.`);

  // ---------- 2. processar antes de responder ----------
  for (const job of jobs) {
    if (job.unsupported) {
      try {
        await wa.sendText(job.waId,
          job.type === 'audio'
            ? 'Ainda não consigo ouvir áudios. Me escreve o que aconteceu?'
            : 'Ainda não consigo abrir esse tipo de arquivo. Pode me contar por texto ou me mandar um print?');
      } catch (e) {
        console.error('Falha ao avisar sobre tipo não suportado:', e.message);
      }
      continue;
    }

    try {
      const result = await receiveMessage(job);
      console.log(`Mensagem ${job.waMessageId} processada:`, result.status);

      await supabase.from('whatsapp_messages')
        .update({ status: 'processed' }).eq('wa_message_id', job.waMessageId)
        .then(() => {}, () => {});

    } catch (e) {
      console.error(`ERRO ao processar ${job.waMessageId}:`, e.message, e.stack);

      await supabase.from('whatsapp_messages')
        .update({ status: 'failed' }).eq('wa_message_id', job.waMessageId)
        .then(() => {}, () => {});

      // A usuária não pode ficar no vácuo.
      try {
        await wa.sendText(job.waId, 'Me perdi aqui por um instante. Pode repetir o que você disse?');
      } catch (_) { /* silencioso */ }
    }
  }

  return res.status(200).json({ received: true, processed: jobs.length });
}

// Exportado no FIM, de propósito. Atribuir module.exports.config antes e
// reatribuir module.exports depois apagaria a exportação da função — foi
// exatamente esse o erro "No exports found" da versão anterior.
module.exports = handler;
module.exports.default = handler;
module.exports.config = { api: { bodyParser: false } };

