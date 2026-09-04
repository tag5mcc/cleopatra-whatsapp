// Conexão com o Supabase usando a service_role key.
// Esta chave passa por cima do RLS — ela NUNCA pode chegar ao navegador.
// Use apenas dentro de /api.

const { createClient } = require('@supabase/supabase-js');

let client = null;

function db() {
  if (client) return client;

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !key) {
    throw new Error('SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY precisam estar configuradas na Vercel.');
  }

  client = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false }
  });
  return client;
}

// ---------------------------------------------------------------------
// app_settings — leitura em cache por invocação (serverless recicla sozinho)
// ---------------------------------------------------------------------

let settingsCache = null;
let settingsLoadedAt = 0;
const SETTINGS_TTL_MS = 60 * 1000;

async function getSettings() {
  if (settingsCache && Date.now() - settingsLoadedAt < SETTINGS_TTL_MS) {
    return settingsCache;
  }
  const { data, error } = await db().from('app_settings').select('key, value');
  if (error) {
    console.error('Falha ao ler app_settings:', error.message);
    return settingsCache || {};
  }
  settingsCache = Object.fromEntries((data || []).map((r) => [r.key, r.value]));
  settingsLoadedAt = Date.now();
  return settingsCache;
}

async function getSetting(key, fallback) {
  const s = await getSettings();
  return s[key] !== undefined ? s[key] : fallback;
}

module.exports = { db, getSettings, getSetting };
