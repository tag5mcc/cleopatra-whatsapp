// Checagem leve, chamada periodicamente pelo navegador em segundo plano,
// pra travar o chat automaticamente assim que os 5 minutos grátis acabarem
// (mesmo que a pessoa não envie nenhuma mensagem nova).

const { checkAccess } = require('./_access');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Método não permitido' });
  }

  const { anonymousId, paidEmail } = req.body || {};

  try {
    const access = await checkAccess(anonymousId, paidEmail);
    return res.status(200).json({ allowed: access.allowed });
  } catch (err) {
    console.error('Erro ao checar teste grátis:', err);
    // Em caso de erro, não bloqueia a pessoa por engano.
    return res.status(200).json({ allowed: true });
  }
};
