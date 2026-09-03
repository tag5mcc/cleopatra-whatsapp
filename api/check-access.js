// Verifica se um e-mail já pagou (registrado pelo webhook da Kiwify).

const { redisGet } = require('./_redis');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Método não permitido' });
  }

  const { email } = req.body || {};
  if (!email || typeof email !== 'string' || !email.includes('@')) {
    return res.status(400).json({ error: 'E-mail inválido.' });
  }

  const normalized = email.toLowerCase().trim();

  try {
    const result = await redisGet(`paid:${normalized}`);
    return res.status(200).json({ allowed: !!result });
  } catch (err) {
    console.error('Erro ao checar acesso:', err);
    return res.status(500).json({ error: 'Erro ao verificar acesso.' });
  }
};
