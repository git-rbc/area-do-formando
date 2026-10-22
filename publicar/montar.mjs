// Monta a versão publicável da Área do Formando: uma página só, que roda sem o
// servidor Node (a API vive no navegador, em api-demo.js).
//
// O que muda em relação ao ambiente local:
//   - o CPF e o e-mail do cadastro de teste viram fictícios (o link pode ser
//     compartilhado, e dado pessoal real não vai junto);
//   - caminhos absolutos (/fotos, /Daniel.ttf) viram relativos.
//
// Rodar: node publicar/montar.mjs

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const AQUI = path.dirname(fileURLToPath(import.meta.url));
const RAIZ = path.resolve(AQUI, '..');
const SAIDA = path.join(AQUI, 'saida');

const CADASTROS = [
  'ades-7506-teste',   // o principal, com um caso de cada situação
  'ades-7506-01',      // outra carteira, com atraso
  'ades-7506-03',      // em dia
  'ades-7506-99',      // adesão cancelada
  'ades-7506-02',      // mesmo CPF em duas turmas
  'ades-dupla-02',
];

const CPF_DEMO = '11111111111';                 // CPF de entrada da demonstração, fácil de digitar
const EMAIL_DEMO = 'formando@exemplo.com.br';

// --- dados -------------------------------------------------------------------
const dados = JSON.parse(fs.readFileSync(path.join(RAIZ, 'dados', 'exemplo.json'), 'utf8'));
// TODOS os cadastros, para a página publicada mostrar o mesmo que o ambiente local.
// CADASTROS fica como referência do recorte mínimo que cobre os casos de teste.
const adesoes = dados.adesoes
  .map((a) => (a.adesaoId === 'ades-7506-teste'
    ? { ...a, cpf: CPF_DEMO, email: EMAIL_DEMO, telefone: '5547999000000' }
    : a));

const demo = {
  hojeSimulado: dados.hojeSimulado,
  aviso: 'Demonstração. Formandos, CPFs, valores, convites, cronograma e avisos são fictícios.',
  turmas: dados.turmas,
  adesoes,
  config: dados.config,
};

// --- arquivos do front -------------------------------------------------------
const relativo = (t) => t
  .replace(/url\('\/Daniel\.ttf'\)/g, "url('Daniel.ttf')")
  .replace(/src="\/logo-formaturas\.png"/g, 'src="logo-formaturas.png"')
  .replace(/src="\/fotos\//g, 'src="fotos/');

const css = relativo(fs.readFileSync(path.join(RAIZ, 'publico', 'estilo.css'), 'utf8'));
/**
 * De onde o site publicado lê os dados (06/10/2026).
 *
 * Vazio = DEMONSTRAÇÃO, com os dados de exemplo e o CPF 111.111.111-11.
 * Preenchido = o portal fala com o CRM e cada formando vê a própria vida
 * financeira.
 *
 * A escolha mora aqui, e não no `publico/index.html`, porque aquele arquivo é o
 * mesmo que o `servidor.mjs` serve na máquina de quem desenvolve: com a URL
 * lá, abrir o protótipo local passaria a mexer em produção — inclusive mandando
 * código de acesso por WhatsApp a formando de verdade a cada teste. O local
 * continua em demonstração; só o que vai ao ar aponta para o CRM.
 */
const API_DO_CRM = 'https://comercial-api.squareweb.app/api/area-formando';

// Os DOIS vão embutidos, e `window.API_URL` decide qual vale: o adaptador do
// CRM começa com `if (!window.API_URL) return`, então sem a URL ele não se
// instala e a demonstração assume. Assim voltar para demonstração é apagar uma
// linha, sem remontar nada.
const api = [
  fs.readFileSync(path.join(AQUI, 'api-demo.js'), 'utf8'),
  fs.readFileSync(path.join(RAIZ, 'publico', 'api-crm.js'), 'utf8'),
].join('\n');
const appjs = relativo(fs.readFileSync(path.join(RAIZ, 'publico', 'app.js'), 'utf8'));
// A PORTARIA vem num arquivo à parte (22/10/2026): ela é outro assunto — a
// equipe na porta no dia da festa —, e misturá-la no app.js engordaria um
// arquivo que já passa de quatro mil linhas. Entra DEPOIS do app porque usa
// `escapar`, `marca` e `baseEventoPublico`, que moram lá.
const portariajs = relativo(fs.readFileSync(path.join(RAIZ, 'publico', 'portaria.js'), 'utf8'));

// --- página ------------------------------------------------------------------
// Sem <!doctype>/<html>/<head>/<body>: o publicador embrulha o arquivo.
const html = `<title>Área do Formando</title>
<link rel="manifest" href="./manifest.webmanifest" />
<link rel="apple-touch-icon" href="./icone-192.png" />
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,300;0,400;0,600;1,300;1,400;1,600&family=Montserrat:wght@400;500;600;700&display=swap" rel="stylesheet" />
<style>
${css}
</style>

<div id="app" class="carregando">
  <div class="splash"><img src="logo-formaturas.png" alt="Indaiá Formaturas" /></div>
</div>
<div id="folha" class="folha" hidden>
  <div class="folha-fundo" data-fechar-folha></div>
  <div class="folha-corpo" role="dialog" aria-modal="true"></div>
</div>
<div id="aviso-flutuante" class="toast" hidden></div>
<div class="pelicula" aria-hidden="true"></div>

<script>window.API_URL = ${JSON.stringify(API_DO_CRM)};</script>
<script>window.DADOS_DEMO = ${JSON.stringify(demo)};</script>
<script>
${api}
</script>
<script>
${appjs}
</script>
<script>
${portariajs}
</script>
`;

// --- escreve -----------------------------------------------------------------
fs.rmSync(SAIDA, { recursive: true, force: true });
fs.mkdirSync(SAIDA, { recursive: true });
fs.writeFileSync(path.join(SAIDA, 'index.html'), html, 'utf8');
fs.copyFileSync(path.join(RAIZ, 'publico', 'Daniel.ttf'), path.join(SAIDA, 'Daniel.ttf'));
fs.copyFileSync(path.join(RAIZ, 'publico', 'logo-formaturas.png'), path.join(SAIDA, 'logo-formaturas.png'));
// PWA: manifesto, service worker e ícones do atalho na tela de início
for (const f of ['manifest.webmanifest', 'sw.js', 'icone-192.png', 'icone-512.png']) {
  fs.copyFileSync(path.join(RAIZ, 'publico', f), path.join(SAIDA, f));
}

const kb = (p) => Math.round(fs.statSync(p).size / 1024);
console.log(`OK — publicar/saida/`);
console.log(`  index.html ${kb(path.join(SAIDA, 'index.html'))}KB (css + dados + api + app)`);
console.log(`  ${adesoes.length} cadastros · CPF de entrada: ${CPF_DEMO.replace(/^(\d{3})(\d{3})(\d{3})(\d{2})$/, '$1.$2.$3-$4')}`);
console.log('  fonte, logo, manifesto, service worker e ícones copiados');
