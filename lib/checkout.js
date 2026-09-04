// Camada de checkout.
//
// O problema que este arquivo resolve: o pagamento acontece no site da
// Kiwify, mas a usuária é identificada pelo telefone no WhatsApp. Se ela
// digitar no checkout um e-mail ou celular diferente do WhatsApp dela — o
// que acontece o tempo todo — o webhook não consegue saber quem pagou, e
// ela fica sem acesso depois de pagar.
//
// Solução: cada usuária recebe um link de checkout único, com uma
// referência no parâmetro `sck`. A Kiwify guarda esse valor no pedido e
// devolve no webhook. O vínculo deixa de depender do que ela digita.
//
// Parâmetros aceitos pela Kiwify na URL: src, sck, utm_source, utm_medium,
// utm_campaign, utm_term, utm_content, s1, s2, s3.

const crypto = require('crypto');
const { db } = require('./db');

/**
 * Devolve (ou cria) o link de checkout individual da usuária.
 * @returns {Promise<{url: string, plan: object, ref: string}|null>}
 */
async function getCheckoutLink(userId, planSlug) {
  const supabase = db();

  let query = supabase.from('plans')
    .select('id, name, slug, price_cents, period, checkout_url')
    .eq('status', 'active');

  query = planSlug ? query.eq('slug', planSlug) : query.order('sort_order').limit(1);

  const { data: plans } = await query;
  const plan = Array.isArray(plans) ? plans[0] : plans;
  if (!plan?.checkout_url) return null;

  // Reaproveita uma sessão aberta em vez de criar uma por mensagem.
  const { data: existing } = await supabase.from('checkout_sessions')
    .select('tracking_ref').eq('user_id', userId).eq('plan_id', plan.id).eq('status', 'open')
    .order('created_at', { ascending: false }).limit(1).maybeSingle();

  let ref = existing?.tracking_ref;

  if (!ref) {
    ref = `u${crypto.randomBytes(8).toString('hex')}`;
    const { error } = await supabase.from('checkout_sessions')
      .insert({ user_id: userId, plan_id: plan.id, tracking_ref: ref });
    if (error) {
      console.error('Falha ao criar sessão de checkout:', error.message);
      return { url: plan.checkout_url, plan, ref: null }; // degrada para o link comum
    }
  }

  const sep = plan.checkout_url.includes('?') ? '&' : '?';
  return { url: `${plan.checkout_url}${sep}sck=${ref}`, plan, ref };
}

/** Procura a sessão a partir do que a Kiwify devolveu no webhook. */
async function resolveCheckoutSession(trackingRef) {
  if (!trackingRef || !/^u[a-f0-9]{16}$/.test(trackingRef)) return null;
  const { data } = await db().from('checkout_sessions')
    .select('id, user_id, plan_id, status').eq('tracking_ref', trackingRef).maybeSingle();
  return data || null;
}

async function markSessionConverted(sessionId) {
  await db().from('checkout_sessions')
    .update({ status: 'converted', converted_at: new Date().toISOString() })
    .eq('id', sessionId);
}

module.exports = { getCheckoutLink, resolveCheckoutSession, markSessionConverted };
