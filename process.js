// Worker. Só o webhook e o cron chamam este endpoint, e ambos precisam
// apresentar o INTERNAL_SECRET. Nunca é exposto ao navegador.

const { db } = require('../../lib/db');
const { receiveMessage } = require('../../lib/cleopatraEngine');
const wa = require('../../lib/whatsapp');

module.exports.config = { maxDuration: 120 };

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Método não permitido' });
  }

  const secret = process.env.INTERNAL_SECRET;
  if (!secret || req.headers['x-internal-secret'] !== secret) {
    return res.status(401).json({ error: 'Não autorizado.' });
  }

  const { jobs } = req.body || {};
  if (!Array.isArray(jobs) || !jobs.length) {
    return res.status(200).json({ processed: 0 });
  }

  const supabase = db();
  const results = [];

  for (const job of jobs) {
    // Tipo ainda não suportado: avisa em vez de ignorar em silêncio.
    if (job.unsupported) {
      try {
        await wa.sendText(job.waId,
          job.type === 'audio'
            ? 'Ainda não consigo ouvir áudios. Me escreve o que aconteceu?'
            : 'Ainda não consigo abrir esse tipo de arquivo. Pode me contar por texto ou me mandar um print?');
      } catch (e) { /* silencioso */ }
      continue;
    }

    try {
      await supabase.from('whatsapp_messages')
        .update({ status: 'processing' }).eq('wa_message_id', job.waMessageId);

      const result = await receiveMessage(job);

      await supabase.from('whatsapp_messages')
        .update({ status: 'processed' }).eq('wa_message_id', job.waMessageId);

      results.push({ waMessageId: job.waMessageId, ...result });

    } catch (e) {
      console.error('Erro ao processar mensagem:', job.waMessageId, e);

      await supabase.from('whatsapp_messages')
        .update({ status: 'failed' }).eq('wa_message_id', job.waMessageId)
        .then(() => {}, () => {});

      // A usuária não pode ficar no vácuo.
      try {
        await wa.sendText(job.waId,
          'Me perdi aqui por um instante. Pode repetir o que você disse?');
      } catch (_) { /* silencioso */ }

      results.push({ waMessageId: job.waMessageId, status: 'failed', error: e.message });
    }
  }

  return res.status(200).json({ processed: results.length, results });
};
