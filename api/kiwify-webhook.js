// Recebe as notificações da Kiwify quando alguém compra, renova, cancela
// ou tem reembolso/chargeback, e atualiza quem tem acesso liberado ao chat.
//
// Configure este webhook no painel da Kiwify (Apps -> Webhooks -> Criar webhook):
//   URL do Webhook: https://SEU-SITE.vercel.app/api/kiwify-webhook?token=SEU_SEGREDO
//   Eventos a marcar: todos os relacionados a pedido/assinatura
//
// A variável de ambiente KIWIFY_WEBHOOK_SECRET na Vercel precisa ter o MESMO
// valor que você colocar em "SEU_SEGREDO" na URL acima.

const { redisSet, redisDel } = require('./_redis');

// Nomes de evento conhecidos (a Kiwify usa nomes em inglês tipo "order_approved",
// mas guardamos também variantes em português por segurança).
const APPROVE_EVENT_TYPES = new Set([
  'order_approved', 'compra_aprovada', 'subscription_renewed', 'subscription_renewal'
]);
const REVOKE_EVENT_TYPES = new Set([
  'order_refunded', 'order_refused', 'compra_reembolsada', 'compra_recusada',
  'chargeback', 'chargedback', 'subscription_canceled', 'subscription_cancelled', 'subscription_late'
]);

// Valores conhecidos do campo "order_status" que a Kiwify sempre envia.
const APPROVE_ORDER_STATUS = new Set(['paid', 'approved']);
const REVOKE_ORDER_STATUS = new Set(['refunded', 'refused', 'chargedback', 'canceled', 'cancelled']);

function extractEmail(body) {
  const candidates = [
    body?.Customer?.email,
    body?.customer?.email,
    body?.data?.Customer?.email,
    body?.data?.customer?.email,
    body?.data?.customer_email,
    body?.customer_email,
    body?.buyer?.email,
    body?.data?.buyer?.email
  ];
  const found = candidates.find((e) => typeof e === 'string' && e.includes('@'));
  return found ? found.toLowerCase().trim() : null;
}

function extractEventType(body) {
  return (
    body?.webhook_event_type ||
    body?.event ||
    body?.trigger ||
    body?.type ||
    ''
  ).toString().toLowerCase();
}

function extractOrderStatus(body) {
  return (body?.order_status || '').toString().toLowerCase();
}

function isApproveEvent(body) {
  return APPROVE_EVENT_TYPES.has(extractEventType(body)) || APPROVE_ORDER_STATUS.has(extractOrderStatus(body));
}

function isRevokeEvent(body) {
  return REVOKE_EVENT_TYPES.has(extractEventType(body)) || REVOKE_ORDER_STATUS.has(extractOrderStatus(body));
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Método não permitido' });
  }

  const expectedSecret = process.env.KIWIFY_WEBHOOK_SECRET;
  const providedSecret = req.query?.token;

  if (!expectedSecret) {
    console.error('KIWIFY_WEBHOOK_SECRET não configurado no servidor.');
    return res.status(500).json({ error: 'Servidor não configurado.' });
  }
  if (providedSecret !== expectedSecret) {
    console.error('Webhook recebido com token inválido.');
    return res.status(401).json({ error: 'Token inválido.' });
  }

  const body = req.body || {};
  const eventType = extractEventType(body);
  const orderStatus = extractOrderStatus(body);
  console.log(`Webhook Kiwify recebido — evento: "${eventType}", order_status: "${orderStatus}"`);

  const email = extractEmail(body);

  if (!email) {
    console.error('Não encontrei e-mail no payload do webhook.');
    return res.status(200).json({ received: true, warning: 'email não encontrado' });
  }

  try {
    if (isApproveEvent(body)) {
      await redisSet(`paid:${email}`, '1');
      console.log(`Acesso LIBERADO para ${email} (evento: ${eventType}, status: ${orderStatus})`);
    } else if (isRevokeEvent(body)) {
      await redisDel(`paid:${email}`);
      console.log(`Acesso REVOGADO para ${email} (evento: ${eventType}, status: ${orderStatus})`);
    } else {
      console.log(`Evento "${eventType}" (status: "${orderStatus}") não mapeado como aprovação nem revogação, ignorando.`);
    }
    return res.status(200).json({ received: true });
  } catch (err) {
    console.error('Erro ao processar webhook:', err);
    return res.status(500).json({ error: 'Erro interno.' });
  }
};
