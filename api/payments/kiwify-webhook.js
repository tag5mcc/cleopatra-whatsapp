// Webhook de pagamento — Kiwify.
//
// Ordem de identificação da usuária, do mais confiável para o menos:
//   1. referência do checkout (sck) — não depende do que ela digitou
//   2. telefone informado no checkout
//   3. e-mail
//
// A camada é abstrata de propósito: para acrescentar Mercado Pago ou
// Stripe, escreva outro arquivo que normalize o payload e reaproveite a
// mesma lógica de assinatura. Nada aqui é específico do resto do sistema.

const crypto = require('crypto');
const { db } = require('../../lib/db');
const wa = require('../../lib/whatsapp');
const { resolveCheckoutSession, markSessionConverted } = require('../../lib/checkout');

module.exports.config = { api: { bodyParser: false } };

const APPROVE_EVENTS = new Set([
  'order_approved', 'compra_aprovada', 'subscription_renewed', 'subscription_renewal'
]);
const REVOKE_EVENTS = new Set([
  'order_refunded', 'order_refused', 'compra_reembolsada', 'compra_recusada',
  'chargeback', 'chargedback', 'subscription_canceled', 'subscription_cancelled'
]);
const PAST_DUE_EVENTS = new Set(['subscription_late']);
const APPROVE_STATUS = new Set(['paid', 'approved']);
const REVOKE_STATUS = new Set(['refunded', 'refused', 'chargedback', 'canceled', 'cancelled']);

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function pick(body, paths) {
  for (const p of paths) {
    const v = p.split('.').reduce((o, k) => (o == null ? o : o[k]), body);
    if (v) return v;
  }
  return null;
}

// A Kiwify aceita src, sck, utm_* e s1/s2/s3 na URL do checkout e guarda no
// pedido. O nome exato do campo no payload do webhook varia conforme a
// versão, então procuramos em todos os lugares plausíveis.
const extractTrackingRef = (b) => pick(b, [
  'TrackingParameters.sck', 'tracking_parameters.sck', 'trackingParameters.sck',
  'TrackingParameters.s1', 'tracking_parameters.s1',
  'TrackingParameters.utm_content', 'tracking_parameters.utm_content',
  'sck', 'data.TrackingParameters.sck', 'data.tracking_parameters.sck', 'data.sck'
]);

const extractEmail = (b) => {
  const e = pick(b, [
    'Customer.email', 'customer.email', 'data.Customer.email', 'data.customer.email',
    'data.customer_email', 'customer_email', 'buyer.email', 'data.buyer.email'
  ]);
  return typeof e === 'string' && e.includes('@') ? e.toLowerCase().trim() : null;
};

const extractPhone = (b) => {
  const p = pick(b, [
    'Customer.mobile', 'Customer.phone', 'customer.mobile', 'customer.phone',
    'data.customer.phone', 'data.customer.mobile', 'buyer.phone'
  ]);
  if (!p) return null;
  const digits = String(p).replace(/\D/g, '');
  if (digits.length < 10) return null;
  return digits.startsWith('55') ? digits : `55${digits}`;
};

const extractProductId = (b) => pick(b, [
  'Product.product_id', 'product.product_id', 'Product.id', 'product_id',
  'data.Product.product_id', 'data.product_id'
]);

const eventType = (b) =>
  String(b?.webhook_event_type || b?.event || b?.trigger || b?.type || '').toLowerCase();
const orderStatus = (b) => String(b?.order_status || '').toLowerCase();

function periodEnd(period) {
  const d = new Date();
  if (period === 'yearly') d.setFullYear(d.getFullYear() + 1);
  else if (period === 'quarterly') d.setMonth(d.getMonth() + 3);
  else if (period === 'lifetime') d.setFullYear(d.getFullYear() + 50);
  else d.setMonth(d.getMonth() + 1);
  return d.toISOString();
}

/**
 * A Kiwify envia ?signature= com o HMAC do corpo cru. O algoritmo já variou
 * entre versões, então testamos SHA-1 e SHA-256 e, por padrão, apenas
 * registramos a divergência sem recusar — recusar com o algoritmo errado
 * derrubaria pagamentos legítimos. Depois de confirmar no log que bate,
 * ligue KIWIFY_ENFORCE_SIGNATURE=true e a verificação passa a valer.
 */
function checkSignature(raw, signature, secret) {
  if (!signature || !secret) return { valid: false, checked: false };
  for (const algo of ['sha1', 'sha256']) {
    const expected = crypto.createHmac(algo, secret).update(raw).digest('hex');
    if (expected.length === signature.length &&
        crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature))) {
      return { valid: true, checked: true, algo };
    }
  }
  return { valid: false, checked: true };
}

async function findUser(body) {
  const supabase = db();

  // 1. Referência do checkout — o caminho confiável.
  const ref = extractTrackingRef(body);
  if (ref) {
    const session = await resolveCheckoutSession(ref);
    if (session) {
      const { data } = await supabase.from('users').select('*').eq('id', session.user_id).maybeSingle();
      if (data) return { user: data, session, via: 'sck' };
    }
  }

  // 2. Telefone.
  const phone = extractPhone(body);
  if (phone) {
    const { data } = await supabase.from('users').select('*').eq('wa_id', phone).maybeSingle();
    if (data) return { user: data, session: null, via: 'telefone' };
  }

  // 3. E-mail.
  const email = extractEmail(body);
  if (email) {
    const { data } = await supabase.from('users').select('*').ilike('email', email).maybeSingle();
    if (data) return { user: data, session: null, via: 'email' };
  }

  return { user: null, session: null, via: null };
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Método não permitido' });
  }

  const secret = process.env.KIWIFY_WEBHOOK_SECRET;
  if (!secret) return res.status(500).json({ error: 'Servidor não configurado.' });

  let raw, body;
  try {
    raw = await readRawBody(req);
    body = JSON.parse(raw.toString('utf8'));
  } catch (e) {
    return res.status(400).json({ error: 'Corpo inválido.' });
  }

  const tokenOk = req.query?.token === secret;
  const sig = checkSignature(raw, req.query?.signature, secret);
  const enforce = process.env.KIWIFY_ENFORCE_SIGNATURE === 'true';

  if (enforce) {
    if (!sig.valid) {
      console.error('Webhook Kiwify recusado: assinatura inválida.');
      return res.status(401).json({ error: 'Assinatura inválida.' });
    }
  } else if (!tokenOk && !sig.valid) {
    console.error('Webhook Kiwify recusado: sem token nem assinatura válidos.');
    return res.status(401).json({ error: 'Não autorizado.' });
  }

  if (sig.checked) {
    console.log(sig.valid
      ? `Assinatura Kiwify confere (${sig.algo}). Já pode ligar KIWIFY_ENFORCE_SIGNATURE=true.`
      : 'Assinatura Kiwify presente mas não confere — confirme o algoritmo antes de exigir.');
  }

  const evt = eventType(body);
  const status = orderStatus(body);
  const supabase = db();
  const orderId = body?.order_id || body?.order_ref || null;

  console.log(`Kiwify — evento: "${evt}", status: "${status}", pedido: ${orderId}`);

  try {
    // Idempotência: a Kiwify reenvia quando não recebe 2xx.
    if (orderId) {
      const { data: dup } = await supabase.from('payments')
        .select('id').eq('provider_ref', orderId).eq('event_type', evt || status).maybeSingle();
      if (dup) return res.status(200).json({ received: true, duplicate: true });
    }

    const { user, session, via } = await findUser(body);

    await supabase.from('payments').insert({
      user_id: user?.id || null,
      amount_cents: Number(body?.Commissions?.charge_amount || body?.charge_amount || 0) || null,
      provider: 'kiwify',
      provider_ref: orderId,
      event_type: evt || status,
      raw_payload: body
    });

    if (!user) {
      console.warn(`Pagamento sem usuária correspondente. Pedido ${orderId}. ` +
        'Verifique se o link enviado no WhatsApp levava o parâmetro sck.');
      return res.status(200).json({ received: true, warning: 'usuária não encontrada' });
    }

    console.log(`Usuária ${user.id} identificada por ${via}.`);

    const email = extractEmail(body);
    if (email && !user.email) {
      await supabase.from('users').update({ email }).eq('id', user.id);
    }

    const approve = APPROVE_EVENTS.has(evt) || APPROVE_STATUS.has(status);
    const revoke = REVOKE_EVENTS.has(evt) || REVOKE_STATUS.has(status);
    const pastDue = PAST_DUE_EVENTS.has(evt);

    if (approve) {
      // Qual plano foi comprado: pelo produto da Kiwify, pela sessão, ou o padrão.
      const productId = extractProductId(body);
      let plan = null;

      if (productId) {
        const { data } = await supabase.from('plans')
          .select('id, period, name').eq('provider_product_id', String(productId)).maybeSingle();
        plan = data;
      }
      if (!plan && session?.plan_id) {
        const { data } = await supabase.from('plans')
          .select('id, period, name').eq('id', session.plan_id).maybeSingle();
        plan = data;
      }
      if (!plan) {
        const { data } = await supabase.from('plans')
          .select('id, period, name').eq('status', 'active').order('sort_order').limit(1).maybeSingle();
        plan = data;
        if (productId) {
          console.warn(`Produto ${productId} não mapeado em plans.provider_product_id — usando o plano padrão.`);
        }
      }

      // Renovação atualiza a assinatura existente em vez de criar outra.
      const { data: current } = await supabase.from('subscriptions')
        .select('id').eq('user_id', user.id).eq('status', 'active')
        .order('created_at', { ascending: false }).limit(1).maybeSingle();

      const payload = {
        user_id: user.id,
        plan_id: plan?.id || null,
        status: 'active',
        provider: 'kiwify',
        provider_ref: orderId,
        current_period_end: periodEnd(plan?.period || 'monthly')
      };

      if (current) {
        await supabase.from('subscriptions').update(payload).eq('id', current.id);
      } else {
        await supabase.from('subscriptions')
          .insert({ ...payload, started_at: new Date().toISOString() });
      }

      if (session) await markSessionConverted(session.id);

      // Renovação é silenciosa: não avisa de novo no WhatsApp todo mês.
      const isRenewal = evt.includes('renew') || !!current;

      if (!isRenewal) {
        const nome = user.name ? user.name.split(' ')[0] : null;
        const { data: lastMsg } = await supabase.from('messages')
          .select('content').eq('user_id', user.id).eq('role', 'user')
          .order('created_at', { ascending: false }).limit(1).maybeSingle();

        try {
          await wa.sendText(user.wa_id,
            `Pronto${nome ? `, ${nome}` : ''} ❤️\n\nAgora posso continuar acompanhando sua história.\n\n` +
            (lastMsg?.content ? 'Onde nós paramos...' : 'Me conta: o que está acontecendo?'),
            { userId: user.id });
        } catch (e) {
          console.error('Falha ao avisar no WhatsApp:', e.message);
        }
      }

      console.log(`Assinatura ${isRenewal ? 'RENOVADA' : 'ATIVADA'} — usuária ${user.id}, plano ${plan?.name}`);

    } else if (revoke) {
      const novoStatus = (status === 'refunded' || evt.includes('reembols') || evt.includes('refund'))
        ? 'refunded' : 'cancelled';
      await supabase.from('subscriptions')
        .update({ status: novoStatus, cancelled_at: new Date().toISOString() })
        .eq('user_id', user.id).eq('status', 'active');
      console.log(`Assinatura ${novoStatus.toUpperCase()} — usuária ${user.id}`);

    } else if (pastDue) {
      await supabase.from('subscriptions')
        .update({ status: 'past_due' }).eq('user_id', user.id).eq('status', 'active');

    } else {
      console.log(`Evento "${evt}" não mapeado — apenas registrado.`);
    }

    return res.status(200).json({ received: true });

  } catch (e) {
    console.error('Erro no webhook de pagamento:', e);
    return res.status(500).json({ error: 'Erro interno.' });
  }
};
