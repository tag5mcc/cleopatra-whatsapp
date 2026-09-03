// Salva os dados de um lead (nome, e-mail, telefone) capturados antes de
// começar a conversar. Guardado no Redis para você poder consultar depois.

const { redisSet, redisPush } = require('./_redis');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Método não permitido' });
  }

  const { name, email, phone } = req.body || {};
  if (!name || typeof name !== 'string' || !name.trim()) {
    return res.status(400).json({ error: 'Nome é obrigatório.' });
  }
  if (!email || typeof email !== 'string' || !email.includes('@')) {
    return res.status(400).json({ error: 'E-mail inválido.' });
  }

  const entry = {
    name: name.trim(),
    email: email.toLowerCase().trim(),
    phone: (phone || '').trim(),
    capturedAt: new Date().toISOString()
  };

  try {
    await redisPush('leads_list', JSON.stringify(entry));
    await redisSet(`lead:${entry.email}`, JSON.stringify(entry));
    return res.status(200).json({ saved: true });
  } catch (err) {
    console.error('Erro ao salvar lead (não crítico):', err);
    // Não bloqueia o fluxo do usuário mesmo se o Redis falhar aqui.
    return res.status(200).json({ saved: false });
  }
};
