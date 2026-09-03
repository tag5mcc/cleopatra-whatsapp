// Lógica compartilhada de controle de acesso: teste grátis de 5 minutos +
// verificação de e-mail pagante. Usado tanto pelo chat quanto pela checagem
// automática em segundo plano (api/check-trial.js).

const { redisGet, redisSet } = require('./_redis');

const FREE_TRIAL_MS = 5 * 60 * 1000; // 5 minutos grátis
const TRIAL_KEY_TTL_SECONDS = 60 * 60 * 24 * 30; // guarda o início do teste por 30 dias

async function checkAccess(anonymousId, paidEmail) {
  // 1. Se veio um e-mail, confere se é de fato pagante.
  if (paidEmail) {
    const normalized = paidEmail.toLowerCase().trim();
    try {
      const paid = await redisGet(`paid:${normalized}`);
      if (paid) return { allowed: true, reason: 'paid' };
    } catch (e) {
      console.error('Erro ao checar e-mail pagante:', e);
    }
  }

  // 2. Sem e-mail válido: aplica a regra do teste grátis de 5 minutos, controlada no servidor.
  if (!anonymousId) {
    // Sem identificador nenhum, trata como teste grátis novo (não deveria acontecer no fluxo normal).
    return { allowed: true, reason: 'trial_no_id' };
  }

  const key = `trial:${anonymousId}`;
  let startStr;
  try {
    startStr = await redisGet(key);
  } catch (e) {
    console.error('Erro ao ler início do teste grátis:', e);
    return { allowed: true, reason: 'trial_error_fallback' };
  }

  let start;
  if (!startStr) {
    start = Date.now();
    try {
      await redisSet(key, String(start), TRIAL_KEY_TTL_SECONDS);
    } catch (e) {
      console.error('Erro ao gravar início do teste grátis:', e);
    }
  } else {
    start = parseInt(startStr, 10);
  }

  const elapsed = Date.now() - start;
  if (elapsed > FREE_TRIAL_MS) {
    return { allowed: false, reason: 'trial_expired' };
  }
  return { allowed: true, reason: 'trial_active' };
}

module.exports = { checkAccess, FREE_TRIAL_MS };
