// Helper compartilhado para falar com o Redis, usado para controlar
// o teste grátis de 5 minutos e quem já pagou a assinatura.
// Usa a variável REDIS_URL, criada automaticamente quando você conecta
// um banco "Redis" em Vercel -> seu projeto -> Storage -> Create Database.

const { createClient } = require('redis');

let clientPromise = null;

function getClient() {
  if (!clientPromise) {
    const url = process.env.REDIS_URL || process.env.KV_URL;
    if (!url) {
      throw new Error('REDIS_URL não configurada (conecte um banco Redis ao projeto na Vercel).');
    }
    const client = createClient({ url });
    client.on('error', (err) => console.error('Erro de conexão com o Redis:', err));
    clientPromise = client.connect().then(() => client).catch((err) => {
      clientPromise = null;
      throw err;
    });
  }
  return clientPromise;
}

async function redisGet(key) {
  const client = await getClient();
  return client.get(key);
}

async function redisSet(key, value, ttlSeconds) {
  const client = await getClient();
  if (ttlSeconds) {
    return client.set(key, value, { EX: ttlSeconds });
  }
  return client.set(key, value);
}

async function redisDel(key) {
  const client = await getClient();
  return client.del(key);
}

async function redisPush(key, value) {
  const client = await getClient();
  return client.rPush(key, value);
}

module.exports = { redisGet, redisSet, redisDel, redisPush };
