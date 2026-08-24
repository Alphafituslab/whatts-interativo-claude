/*
 * Service worker do Seja Alpha.
 *
 * Existe por dois motivos: (1) é o que torna o site instalável como app
 * no celular, e (2) dá uma tela decente quando o celular fica sem
 * internet, em vez do dinossauro do Chrome.
 *
 * DE PROPÓSITO ele quase não usa cache: já tivemos problema com versão
 * antiga do app.js grudada no navegador. A regra aqui é sempre buscar da
 * rede primeiro; o cache só entra como último recurso quando a rede
 * falhou. Nada de /api/ é guardado — atendimento não pode mostrar
 * conversa velha achando que é a de agora.
 */
const CACHE = "whatts-inbox-v1";
const ESSENCIAIS = ["/", "/static/styles.css", "/static/app.js"];

self.addEventListener("install", (evento) => {
  self.skipWaiting();
  evento.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(ESSENCIAIS)).catch(() => {})
  );
});

self.addEventListener("activate", (evento) => {
  evento.waitUntil(
    caches.keys()
      .then((nomes) => Promise.all(nomes.filter((n) => n !== CACHE).map((n) => caches.delete(n))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (evento) => {
  const req = evento.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  // API nunca passa pelo cache: dado de atendimento é sempre ao vivo.
  if (url.pathname.startsWith("/api/")) return;

  evento.respondWith(
    fetch(req)
      .then((resposta) => {
        if (resposta && resposta.ok) {
          const copia = resposta.clone();
          caches.open(CACHE).then((c) => c.put(req, copia)).catch(() => {});
        }
        return resposta;
      })
      .catch(() =>
        caches.match(req).then((cacheado) => cacheado || caches.match("/"))
      )
  );
});
