// Embrulha publicar/saida/ na página que vai ao ar e escreve em docs/.
//
// O repositório É este projeto (auxiliarvendasindaia/area-do-formando), e o
// GitHub Pages serve a pasta docs/ — mesma lógica do app do casal: fonte
// versionado, com o que vai ao ar numa pasta separada. Antes de 28/09/2026 o
// site morava num repositório à parte, em site-github/.
//
// O montar.mjs gera um fragmento (sem <html>/<head>), porque o publicador do
// Claude embrulha sozinho. No GitHub Pages o arquivo é servido como está, então
// o cabeçalho — charset, viewport, cor da barra, favicon e o noindex — entra aqui.
//
// Rodar: node publicar/montar.mjs && node publicar/para-github.mjs

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const AQUI = path.dirname(fileURLToPath(import.meta.url));
const RAIZ = path.resolve(AQUI, '..');
const SAIDA = path.join(AQUI, 'saida');
const DESTINO = path.join(RAIZ, 'docs');

/**
 * O endereço oficial do portal, quando houver.
 *
 * Vazio = o site continua em `auxiliarvendasindaia.github.io/area-do-formando`.
 * Preencher ANTES de o DNS resolver tira o site do ar, porque o Pages passa a
 * responder só no domínio novo (ver o comentário mais abaixo, onde o CNAME é
 * escrito). `DOMINIO_PORTAL=...` no ambiente serve para testar sem editar isto.
 */
const DOMINIO_OFICIAL = 'areaformando.eventosindaia.com.br';


const FAVICON = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='7' fill='%23160C24'/%3E%3Ctext x='16' y='23' font-family='Georgia,serif' font-size='17' fill='%23E4C878' text-anchor='middle'%3E%E2%9C%A6%3C/text%3E%3C/svg%3E";

const CABECA = `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<meta name="theme-color" content="#2E1A4F" />
<meta name="robots" content="noindex" />
<link rel="icon" href="${FAVICON}" />
<title>Área do Formando — Indaiá Formaturas</title>
<link rel="manifest" href="./manifest.webmanifest" />
<link rel="apple-touch-icon" href="./icone-192.png" />
<meta name="apple-mobile-web-app-capable" content="yes" />
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
<meta name="apple-mobile-web-app-title" content="Meu Formando" />
`;

const fragmento = fs.readFileSync(path.join(SAIDA, 'index.html'), 'utf8');
// o fragmento começa com o <title> curto e os preconnect das fontes
const semTitulo = fragmento.replace(/^<title>[^<]*<\/title>\n/, '');
const [antesDoCorpo, ...resto] = semTitulo.split('</style>');
const corpo = resto.join('</style>');

const html = `${CABECA}${antesDoCorpo}</style>
</head>
<body>
${corpo}</body>
</html>
`;

fs.writeFileSync(path.join(DESTINO, 'index.html'), html, 'utf8');
fs.copyFileSync(path.join(SAIDA, 'Daniel.ttf'), path.join(DESTINO, 'Daniel.ttf'));
fs.copyFileSync(path.join(SAIDA, 'logo-formaturas.png'), path.join(DESTINO, 'logo-formaturas.png'));
for (const f of ['manifest.webmanifest', 'sw.js', 'icone-192.png', 'icone-512.png', 'logo-formaturas-email.png']) {
  fs.copyFileSync(path.join(SAIDA, f), path.join(DESTINO, f));
}
// o .nojekyll evita que o Pages ignore arquivos; recriado se alguém apagar
fs.writeFileSync(path.join(DESTINO, '.nojekyll'), '');

// O endereço oficial. O GitHub guarda o domínio próprio num arquivo DENTRO da
// pasta publicada, então ele é escrito aqui junto com o resto: se dependesse de
// alguém lembrar, uma publicação futura levaria o site de volta para o endereço
// github.io — e o link que os formandos têm pararia de funcionar.
//
// SÓ VALE COM O DNS DE PÉ: um CNAME apontando para um domínio que não resolve
// deixa o site inacessível, porque o Pages passa a responder apenas nele. Por
// isso o domínio entra aqui depois que `areaformando.eventosindaia.com.br`
// estiver resolvendo na Cloudflare (registro CNAME → auxiliarvendasindaia.github.io,
// sem proxy: a nuvem laranja impede a emissão do certificado).
const DOMINIO = process.env.DOMINIO_PORTAL || DOMINIO_OFICIAL;
if (DOMINIO) fs.writeFileSync(path.join(DESTINO, 'CNAME'), `${DOMINIO}\n`);

const kb = (p) => Math.round(fs.statSync(p).size / 1024);
console.log('OK — docs/');
console.log(`  index.html ${kb(path.join(DESTINO, 'index.html'))}KB`);
console.log('  fonte, logo e .nojekyll no lugar');
