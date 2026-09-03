// Service worker mínimo — necessário para os navegadores permitirem
// "Instalar app" / "Adicionar à tela inicial". Não faz cache agressivo,
// apenas repassa as requisições normalmente.
self.addEventListener('install', () => {
  self.skipWaiting();
});
self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});
self.addEventListener('fetch', () => {
  // deixa o navegador lidar normalmente com a requisição
});
