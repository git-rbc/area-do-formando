// Área do Formando — front do protótipo local.
// Conversa só com os endpoints /area-formando/* descritos na Parte 4 do plano.
// Trocar pela API real depois = mudar API_BASE e de onde vem o token.

const API_BASE = '/area-formando';

/**
 * O endereço de um arquivo que vem da API (PDF, principalmente).
 *
 * Download não passa pelo adaptador do CRM: o navegador precisa ir direto, para
 * receber o binário. Com `window.API_URL` apontando para o CRM, o caminho
 * relativo `/area-formando/...` cairia no servidor do SITE — que não tem API
 * nenhuma —, e todo PDF falharia em silêncio.
 */
function urlDoArquivo(caminho) {
  const base = String(window.API_URL || '').replace(/\/+$/, '');
  return base ? base + caminho : API_BASE + caminho;
}
const app = document.getElementById('app');
const folha = document.getElementById('folha');
const toast = document.getElementById('aviso-flutuante');

const estado = {
  token: null,
  tokenEscolha: null,
  cpf: '',
  config: null,
  eu: null,
  financeiro: null,
  contrato: null,
  turma: null,
  avisos: null,
  aba: 'inicio',
  filtro: 'todas',
  visao: 'ano',
  menuAberto: false,
};

// ---------- utilidades -------------------------------------------------------
const guardar = (t) => { try { sessionStorage.setItem('formando_token', t); } catch { /* modo privado */ } };
const recuperar = () => { try { return sessionStorage.getItem('formando_token'); } catch { return null; } };
const esquecer = () => { try { sessionStorage.removeItem('formando_token'); } catch { /* ignora */ } };

const brl = (v) => (v ?? 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const dataCurta = (iso) => iso ? new Date(`${iso}T12:00:00`).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' }) : '—';
const dataLonga = (iso) => iso ? new Date(`${iso}T12:00:00`).toLocaleDateString('pt-BR', { day: '2-digit', month: 'long', year: 'numeric' }) : '—';
/** A hora de um instante completo (ISO), para "o código vale até 14:35". */
const horaCurta = (iso) => (iso ? new Date(iso).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) : '');
const mesAno = (iso) => iso ? new Date(`${iso}T12:00:00`).toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' }) : '—';
const escapar = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Tira o "(TESTE)" do nome do cadastro de teste na hora de mostrar na tela.
const semMarca = (n) => String(n || '').replace(/\s*\(TESTE\)\s*/i, '').trim();

const hoje = () => estado.config?.hojeSimulado || new Date().toISOString().slice(0, 10);
const diasAte = (iso) => Math.round((new Date(`${iso}T12:00:00`) - new Date(`${hoje()}T12:00:00`)) / 86400000);

// "agendado" e "nao_gerado" são diferentes na Vindi, mas para o formando são a
// mesma coisa: o boleto ainda não foi gerado.
const ROTULO_STATUS = {
  pago: 'Pago', em_aberto: 'Em aberto', em_atraso: 'Em atraso',
  agendado: 'Programada', nao_gerado: 'Programada',
  em_analise: 'Em análise', expirado: 'Expirado',
};

// Decisões da equipe (22/09/2026): a 2ª via vence em 5 dias; com mais de duas
// parcelas vencidas, a negociação vira um pedido para a equipe entrar em contato.
const DIAS_SEGUNDA_VIA = 5;
const MAX_VENCIDAS_SEM_EQUIPE = 2;

const nomeCobranca = (b) => b.nome || (b.unico ? 'Boleto único' : `Parcela ${b.parcela}`);
// O que aparece como "Referente a": o código do CRM (E08058 - PARC FORMATURA) não
// diz nada para o formando e fica só no PDF do boleto.
function descricaoAmigavel(b) {
  const turma = estado.eu?.turma?.codigo ? ` · turma ${estado.eu.turma.codigo}` : '';
  if (b.unico) return `Boleto único · ${rotuloParcelas(b.unico.parcelas)}${turma}`;
  const total = estado.financeiro?.resumo?.parcelas;
  return `Parcela ${b.parcela}${total ? ` de ${total}` : ''} da formatura${turma}`;
}

const rotuloParcelas = (ps) => (ps.length === 1 ? `parcela ${ps[0].parcela}` : `parcelas ${ps[0].parcela} a ${ps[ps.length - 1].parcela}`);
const maiuscula = (t) => t.charAt(0).toUpperCase() + t.slice(1);
// a linha de apoio de uma cobrança: "Parcela 6" ou, no boleto único, "Parcelas 6 a 8"
const apoioCobranca = (b) => (b.unico ? maiuscula(rotuloParcelas(b.unico.parcelas)) : nomeCobranca(b));
// o que se deve hoje: vencida já vem com os encargos, 2ª via com o valor novo
const arredondar = (n) => Math.round(n * 100) / 100;
const devido = (b) => b.valorDevido ?? b.valorAtualizado ?? b.valor;
// o que o banco cobra: o devido mais a taxa administrativa do contrato
const aPagar = (b) => b.totalBoleto ?? devido(b);

function avisar(texto) {
  toast.textContent = texto;
  toast.hidden = false;
  clearTimeout(avisar._t);
  avisar._t = setTimeout(() => { toast.hidden = true; }, 2600);
}

/**
 * A fonte de dados oferece esta ação?
 *
 * No protótipo tudo existe. Ligado ao CRM, algumas coisas ainda não foram
 * construídas (2ª via e boleto único escrevem cobrança na Vindi e entram uma a
 * uma) — e oferecer um botão que morre em erro é pior do que não oferecer.
 * `api-crm.js` declara o que falta em `window.API_RECURSOS`.
 */
function temRecurso(nome) {
  const r = window.API_RECURSOS;
  return !r || r[nome] !== false;
}

async function chamar(caminho, opcoes = {}) {
  // Com `window.API_URL` apontando para o CRM, o portal lê dados REAIS — a
  // tradução dos caminhos e formatos mora em api-crm.js.
  if (window.API_CRM) {
    const corpo = opcoes.body ? JSON.parse(opcoes.body) : null;
    return window.API_CRM(opcoes.method || 'GET', caminho, corpo, estado.token || estado.tokenEscolha);
  }
  // Na versão publicada não há servidor: a mesma API roda no navegador.
  if (window.API_DEMO) {
    const corpo = opcoes.body ? JSON.parse(opcoes.body) : null;
    return window.API_DEMO(opcoes.method || 'GET', caminho, corpo, estado.token || estado.tokenEscolha);
  }
  const resposta = await fetch(API_BASE + caminho, {
    ...opcoes,
    headers: {
      'content-type': 'application/json',
      ...(estado.token || estado.tokenEscolha ? { authorization: `Bearer ${estado.token || estado.tokenEscolha}` } : {}),
      ...opcoes.headers,
    },
  });
  const corpo = await resposta.json().catch(() => ({}));
  if (!resposta.ok) throw Object.assign(new Error(corpo.erro || 'falha'), { status: resposta.status, corpo });
  return corpo;
}

function abrirFolha(html, depois) {
  folha.querySelector('.folha-corpo').innerHTML = html;
  folha.hidden = false;
  if (depois) depois(folha.querySelector('.folha-corpo'));
}
const fecharFolha = () => { folha.hidden = true; };
folha.addEventListener('click', (e) => { if (e.target.hasAttribute('data-fechar-folha')) fecharFolha(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { fecharBaloes(); fecharFolha(); } });

async function copiar(texto) {
  try {
    await navigator.clipboard.writeText(texto);
  } catch {
    const campo = document.createElement('textarea');
    campo.value = texto; document.body.appendChild(campo); campo.select();
    document.execCommand('copy'); campo.remove();
  }
  avisar('Linha digitável copiada');
}

// ---------- tela: entrar -----------------------------------------------------
function mascaraCpf(v) {
  const d = v.replace(/\D/g, '').slice(0, 11);
  return d.replace(/(\d{3})(\d)/, '$1.$2').replace(/(\d{3})(\d)/, '$1.$2').replace(/(\d{3})(\d{1,2})$/, '$1-$2');
}

const marca = () => `
  <div class="marca">
    <img src="/logo-formaturas.png" alt="Indaiá Formaturas" />
    <div class="assinatura">transformando histórias.</div>
  </div>`;

function telaEntrar(erro) {
  app.className = 'entrar';
  app.innerHTML = `
    <div class="entrar-caixa">
      ${marca()}
      <div class="cartao">
        <div class="kicker">Área do Formando</div>
        <h1>Acesse sua <span class="grifo">conta</span></h1>
        <p class="sub">Informe seu CPF para receber um código de acesso por WhatsApp ou e-mail.</p>
        <form id="form-cpf" novalidate>
          <div class="campo">
            <label for="cpf">CPF</label>
            <input id="cpf" inputmode="numeric" autocomplete="off" placeholder="000.000.000-00" value="${escapar(mascaraCpf(estado.cpf))}" />
          </div>
          ${erro ? `<p class="erro">${escapar(erro)}</p>` : ''}
          <button class="botao" type="submit">Receber código</button>
        </form>
        ${estado.config?.cpfExemplo ? `
          <div class="dev">
            Ambiente de teste: nenhum código é enviado por e-mail ou WhatsApp — ele aparece
            aqui na tela. Entre com <strong class="cpf">${escapar(mascaraCpf(estado.config.cpfExemplo))}</strong>
          </div>` : ''}
      </div>
      ${notaRodape()}
    </div>`;

  const campo = app.querySelector('#cpf');
  campo.addEventListener('input', () => { campo.value = mascaraCpf(campo.value); });
  app.querySelector('#form-cpf').addEventListener('submit', async (e) => {
    e.preventDefault();
    const cpf = campo.value.replace(/\D/g, '');
    if (cpf.length !== 11) return telaEntrar('Digite os 11 números do CPF.');
    estado.cpf = cpf;
    const botao = app.querySelector('button[type=submit]');
    botao.disabled = true; botao.textContent = 'Enviando…';
    try {
      const r = await chamar('/auth/otp/solicitar', { method: 'POST', body: JSON.stringify({ cpf }) });
      // Em produção a resposta é sempre a mesma, exista o CPF ou não. No protótipo,
      // onde nada é enviado, ficar na tela do código sem código só confunde.
      if (r.cadastrado === false) {
        const sugerido = estado.config?.cpfExemplo ? ` Use ${mascaraCpf(estado.config.cpfExemplo)}.` : '';
        return telaEntrar(`Esse CPF não está nos dados de exemplo.${sugerido}`);
      }
      telaCodigo(r);
    } catch (err) {
      const mensagens = {
        cpf_invalido: 'CPF inválido.',
        aguarde: `Aguarde ${err.corpo?.segundos || 60} segundos para pedir outro código.`,
        muitas_tentativas: 'Você já pediu muitos códigos hoje. Fale com a gente pelo WhatsApp.',
      };
      telaEntrar(mensagens[err.message] || 'Não foi possível enviar o código agora.');
    }
  });
}

function telaCodigo(envio, erro) {
  app.className = 'entrar';
  const destinos = [envio.destinos?.whatsapp, envio.destinos?.email].filter(Boolean);
  app.innerHTML = `
    <div class="entrar-caixa">
      ${marca()}
      <div class="cartao">
        <div class="kicker">Código de acesso</div>
        <h1>Digite o código</h1>
        <p class="sub">${destinos.length ? escapar(`Enviado para ${destinos.join(' e ')}.`) : 'Se o CPF estiver cadastrado, o código já foi enviado.'}</p>
        <form id="form-codigo" novalidate>
          <div class="campo">
            <label for="codigo">6 dígitos</label>
            <input id="codigo" class="codigo" inputmode="numeric" maxlength="6" autocomplete="one-time-code" placeholder="000000" />
            <!-- CINCO minutos, que é o que o servidor faz. Dizia dez, e quem
                 confiava no texto digitava um código já expirado e via "código
                 incorreto" — a mensagem acusa a pessoa de um erro que é nosso. -->
            <div class="dica">Vale por 5 minutos.</div>
          </div>
          ${erro ? `<p class="erro">${escapar(erro)}</p>` : ''}
          <button class="botao" type="submit">Entrar</button>
          <!-- Sem este botão, quem deixou o código expirar só tinha "Usar outro
               CPF": sair da tela, digitar o CPF de novo e torcer. -->
          <button class="botao fantasma" type="button" id="reenviar">Enviar outro código</button>
          <button class="botao fantasma" type="button" id="voltar">Usar outro CPF</button>
        </form>
        ${envio.codigoDev ? `<div class="dev">Ambiente de teste — o código é <strong>${escapar(envio.codigoDev)}</strong>. Em produção ele só chega por WhatsApp e e-mail.</div>` : ''}
      </div>
    </div>`;

  const campo = app.querySelector('#codigo');
  campo.focus();
  campo.addEventListener('input', () => { campo.value = campo.value.replace(/\D/g, ''); });
  app.querySelector('#voltar').addEventListener('click', () => telaEntrar());

  // Pedir outro código sem sair da tela. O servidor só aceita um por minuto, e
  // a recusa volta como `aguarde` — que aqui vira uma frase, não um erro.
  app.querySelector('#reenviar').addEventListener('click', async (e) => {
    const botao = e.currentTarget;
    botao.disabled = true; botao.textContent = 'Enviando…';
    try {
      const novo = await chamar('/auth/otp/solicitar', { method: 'POST', body: JSON.stringify({ cpf: estado.cpf }) });
      // Volta para a tela limpa, com os destinos atualizados do envio novo.
      telaCodigo(novo, null);
      avisar('Código novo enviado');
    } catch (err) {
      botao.disabled = false; botao.textContent = 'Enviar outro código';
      const mensagens = {
        aguarde: 'Espere um minuto para pedir outro código.',
        muitas_tentativas: 'Você pediu muitos códigos hoje. Fale com a equipe.',
      };
      telaCodigo(envio, mensagens[err.message] || 'Não foi possível enviar outro código agora.');
    }
  });

  app.querySelector('#form-codigo').addEventListener('submit', async (e) => {
    e.preventDefault();
    const botao = app.querySelector('button[type=submit]');
    botao.disabled = true; botao.textContent = 'Verificando…';
    try {
      const r = await chamar('/auth/otp/verificar', { method: 'POST', body: JSON.stringify({ cpf: estado.cpf, codigo: campo.value }) });
      if (r.precisaEscolherTurma) { estado.tokenEscolha = r.tokenEscolha; return telaEscolherTurma(r.turmas); }
      estado.token = r.token; guardar(r.token);
      await entrar();
    } catch (err) {
      const mensagens = {
        // O servidor responde a mesma coisa para código errado e código
        // vencido, de propósito. Como vencer é o caso mais comum, a frase diz o
        // que fazer em vez de deixar a pessoa conferindo dígito por dígito.
        codigo_invalido: 'Código incorreto ou vencido. Se passaram mais de 5 minutos, peça outro código.',
        muitas_tentativas: 'Muitas tentativas. Peça um código novo.',
      };
      telaCodigo(envio, mensagens[err.message] || 'Não foi possível entrar agora.');
    }
  });
}

function telaEscolherTurma(turmas) {
  app.className = 'entrar';
  app.innerHTML = `
    <div class="entrar-caixa">
      ${marca()}
      <div class="cartao">
        <div class="kicker">Quase lá</div>
        <h1>Qual turma?</h1>
        <p class="sub">Seu CPF está em mais de uma formatura.</p>
        <div class="opcoes-turma">
          ${turmas.map((t) => `
            <button class="opcao-turma" data-adesao="${escapar(t.adesaoId)}">
              <strong>${escapar(t.turma)}</strong>
              <span>${escapar(t.curso)} · ${escapar(t.cidade)} · ${dataCurta(t.dataEvento)}</span>
            </button>`).join('')}
        </div>
        <button class="botao fantasma" type="button" id="voltar">Voltar</button>
      </div>
    </div>`;
  app.querySelector('#voltar').addEventListener('click', () => telaEntrar());
  app.querySelectorAll('.opcao-turma').forEach((b) => b.addEventListener('click', async () => {
    try {
      const r = await chamar('/auth/escolher-turma', { method: 'POST', body: JSON.stringify({ adesaoId: b.dataset.adesao }) });
      estado.tokenEscolha = null;
      estado.token = r.token; guardar(r.token);
      await entrar();
    } catch { telaEntrar('Não foi possível abrir essa turma.'); }
  }));
}

function telaCancelada() {
  app.className = 'entrar';
  app.innerHTML = `
    <div class="entrar-caixa">
      ${marca()}
      <div class="cartao">
        <div class="kicker">Área do Formando</div>
        <h1>Sua adesão foi cancelada</h1>
        <p class="sub">${escapar(estado.eu?.canceladaEm ? `Cancelamento registrado em ${dataCurta(estado.eu.canceladaEm)}.` : '')}</p>
        <p style="margin:0 0 18px">Por isso o financeiro e os documentos não aparecem aqui. Se você acha que houve engano, fale com a gente — a equipe de formaturas resolve pelo WhatsApp.</p>
        ${temRecurso('falarComEquipe') ? '<button class="botao" id="zap">Falar com a equipe</button>' : ''}
        <button class="botao fantasma" id="sair">Sair</button>
      </div>
    </div>`;
  app.querySelector('#zap')?.addEventListener('click', abrirWhatsapp);
  app.querySelector('#sair').addEventListener('click', sair);
}

// ---------- moldura com menu lateral ----------------------------------------
const ICONES = {
  inicio: '<svg viewBox="0 0 24 24"><path d="M3.5 10.5 12 3.5l8.5 7M5.5 9.5v10h13v-10"/><path d="M10 19.5v-5.5h4v5.5"/></svg>',
  financeiro: '<svg viewBox="0 0 24 24"><rect x="2.5" y="5.5" width="19" height="13" rx="2.5"/><path d="M2.5 10h19M6 14.5h3"/></svg>',
  contrato: '<svg viewBox="0 0 24 24"><path d="M6 2.5h8l4.5 4.5v14a1.5 1.5 0 0 1-1.5 1.5H6a1.5 1.5 0 0 1-1.5-1.5v-17A1.5 1.5 0 0 1 6 2.5Z"/><path d="M13.5 2.8V7.5h4.7M8 12.5h8M8 16.5h5"/></svg>',
  turma: '<svg viewBox="0 0 24 24"><path d="M12 3.5 22 8.5l-10 5-10-5 10-5Z"/><path d="M6 11v5.5c0 1.4 2.7 2.5 6 2.5s6-1.1 6-2.5V11M22 8.5v5"/></svg>',
  cronograma: '<svg viewBox="0 0 24 24"><rect x="3.5" y="5" width="17" height="15.5" rx="2.5"/><path d="M3.5 10h17M8 3v4M16 3v4M7.5 14h3M7.5 17.5h7"/></svg>',
  zap: '<svg viewBox="0 0 24 24"><path d="M3.5 20.5 5 16.3a8 8 0 1 1 3.2 3.1l-4.7 1.1Z"/></svg>',
  sair: '<svg viewBox="0 0 24 24"><path d="M9.5 4.5h-4v15h4M14 8l4 4-4 4M18 12H9"/></svg>',
  menu: '<svg viewBox="0 0 24 24"><path d="M3.5 7h17M3.5 12h17M3.5 17h17"/></svg>',
  tema: '<svg viewBox="0 0 24 24"><path d="M20 14.2A8.2 8.2 0 0 1 9.8 4 8.5 8.5 0 1 0 20 14.2Z"/></svg>',
  pessoa: '<svg viewBox="0 0 24 24"><circle cx="12" cy="8" r="3.6"/><path d="M4.8 20.5c0-3.6 3.2-6.2 7.2-6.2s7.2 2.6 7.2 6.2"/></svg>',
  pedidos: '<svg viewBox="0 0 24 24"><path d="M8 4.5h8a2 2 0 0 1 2 2v13a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2v-13a2 2 0 0 1 2-2Z"/><path d="M9.5 9h5M9.5 13h5M9.5 17h3M9 4.5V3.5h6v1"/></svg>',
  anexo: '<svg viewBox="0 0 24 24"><path d="M14 6.5 8 12.5a3 3 0 0 0 4.2 4.2l6.3-6.3a5 5 0 0 0-7-7L5 9.7a7 7 0 0 0 9.9 9.9l5-5"/></svg>',
  lixeira: '<svg viewBox="0 0 24 24"><path d="M4.5 7h15M9.5 7V5.2A1.2 1.2 0 0 1 10.7 4h2.6a1.2 1.2 0 0 1 1.2 1.2V7"/><path d="M6.5 7l.9 12.2A1.8 1.8 0 0 0 9.2 21h5.6a1.8 1.8 0 0 0 1.8-1.8L17.5 7"/><path d="M10.5 11v6M13.5 11v6"/></svg>',
  sino: '<svg viewBox="0 0 24 24"><path d="M6 9a6 6 0 1 1 12 0c0 4 1.5 5.5 2 6.5H4c.5-1 2-2.5 2-6.5Z"/><path d="M10 19a2 2 0 0 0 4 0"/></svg>',
  recibo: '<svg viewBox="0 0 24 24"><path d="M5 3.5h14v17l-2.3-1.5-2.4 1.5-2.3-1.5-2.3 1.5L7.4 19 5 20.5Z"/><path d="M9 8.5h6M9 12.5h6"/></svg>',
  antecipar: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5"/><path d="M12 7v5l3.2 2"/></svg>',
  extrato: '<svg viewBox="0 0 24 24"><path d="M6 3.5h12v17H6Z"/><path d="M9 8h6M9 12h6M9 16h3"/></svg>',
  informe: '<svg viewBox="0 0 24 24"><path d="M7 3.5h10v17H7Z"/><path d="M10 8h4M10 12h4M10 16h2"/><circle cx="17.5" cy="17.5" r="3.5"/></svg>',
  calendario: '<svg viewBox="0 0 24 24"><rect x="3.5" y="5" width="17" height="15.5" rx="2.5"/><path d="M3.5 10h17M8 3v4M16 3v4"/></svg>',
  mapa: '<svg viewBox="0 0 24 24"><path d="M12 21s6.5-6 6.5-10.5a6.5 6.5 0 1 0-13 0C5.5 15 12 21 12 21Z"/><circle cx="12" cy="10.5" r="2.4"/></svg>',
  check: '<svg viewBox="0 0 24 24"><path d="m5 12.5 4.5 4.5L19 7"/></svg>',
  duvida: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5"/><path d="M9.6 9.4a2.5 2.5 0 1 1 3.3 2.4c-.6.2-.9.8-.9 1.4v.5"/><path d="M12 17h.01"/></svg>',
  relogio: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5"/><path d="M12 7.5v5l3 1.8"/></svg>',
  celular: '<svg viewBox="0 0 24 24"><rect x="6" y="2.5" width="12" height="19" rx="2.5"/><path d="M10.5 18.5h3"/></svg>',
};

// ---------- tema claro/escuro ------------------------------------------------
// Sem escolha salva, vale o tema do sistema. A escolha fica no navegador.
const temaAtual = () => {
  try {
    const salvo = localStorage.getItem('formando_tema');
    if (salvo) return salvo;
  } catch { /* modo privado */ }
  return matchMedia('(prefers-color-scheme: dark)').matches ? 'escuro' : 'claro';
};

function aplicarTema(tema) {
  document.documentElement.setAttribute('data-tema', tema);
  try { localStorage.setItem('formando_tema', tema); } catch { /* segue sem lembrar */ }
}

function alternarTema() {
  aplicarTema(temaAtual() === 'escuro' ? 'claro' : 'escuro');
  if (estado.eu) irPara(estado.aba);
}

// O título de cada aba leva um <em> em itálico violeta, como os títulos do site de formaturas.
const ABAS = [
  { id: 'inicio', rotulo: 'Início', titulo: 'Minha <em>formatura</em>' },
  { id: 'financeiro', rotulo: 'Financeiro', titulo: 'Meu <em>financeiro</em>' },
  { id: 'cronograma', rotulo: 'Cronograma', titulo: 'O <em>cronograma</em>' },
  { id: 'contrato', rotulo: 'Contrato', titulo: 'Contrato e <em>convites</em>' },
  { id: 'turma', rotulo: 'Minha turma', titulo: 'Minha <em>turma</em>' },
];

// ---------- cursos: símbolo e frase ------------------------------------------
// Cada curso tem o símbolo que o representa e uma frase escrita para ele.
// A busca é pelo nome do curso que vem da adesão; sem correspondência, cai no
// genérico (o capelo).
const CURSOS = [
  { re: /enfermagem/i, nome: 'Enfermagem', frase: 'Quem passou noites cuidando de gente merece uma noite {inteira sua}.',
    svg: '<path d="M12 3c-2.2 2.6-4 4.7-4 7.2a4 4 0 0 0 8 0C16 7.7 14.2 5.6 12 3Z"/><path d="M8.5 17.5h7M9.5 21h5"/>' },
  // Biomedicina vem ANTES de medicina: "biomedicina" contém "medicina" e cairia na regra errada.
  { re: /biomedicin/i, nome: 'Biomedicina', frase: 'Cada lâmina, cada análise, cada madrugada no laboratório levou você [até aqui].',
    svg: '<path d="M10 4.5h3.5v5H10zM11.8 9.5v3"/><path d="M8 20.5h9M7 17.5c0-3 2.2-5 4.8-5s4.8 2 4.8 5"/><path d="M5.5 12.5h3"/>' },
  { re: /medicina|m[eé]dic/i, nome: 'Medicina', frase: 'Anos de plantão e de entrega. Hoje a bata dá lugar ao {traje de gala}.',
    svg: '<path d="M12 3v18"/><path d="M12 5.5c3 0 3 2.6 0 2.6s-3 2.6 0 2.6 3 2.6 0 2.6-3 2.6 0 2.6"/><path d="M9.5 3h5"/>' },
  { re: /nutri[cç][aã]o/i, nome: 'Nutrição', frase: 'Você aprendeu a cuidar das pessoas pelo que elas comem. Hoje o jantar é [em sua homenagem].',
    svg: '<path d="M12 8c-3 0-5 2.2-5 5.4C7 17 9.5 21 12 21s5-4 5-7.6C17 10.2 15 8 12 8Z"/><path d="M12 8c0-2.2 1.4-4 3.5-4.5C15.5 6 14.2 7.7 12 8Z" class="cheio"/>' },
  { re: /fisioterap/i, nome: 'Fisioterapia', frase: 'Você devolveu movimento a tanta gente. Agora é a sua vez de {dançar}.',
    svg: '<circle cx="13.5" cy="5" r="2"/><path d="M14 8 10.5 11l3 2.5.5 5M10.5 11 6.5 12M13.5 13.5 18 15M14 18.5l-3.5 2.5"/>' },
  { re: /psicolog/i, nome: 'Psicologia', frase: 'Você escutou histórias demais para não ter [a sua celebrada].',
    svg: '<path d="M8 6v5a4 4 0 0 0 8 0V6M12 6v15M8.5 21h7"/>' },
  { re: /direito|jur[ií]dic/i, nome: 'Direito', frase: 'Cada código estudado, cada tese defendida — a sentença de hoje é {comemorar}.',
    svg: '<path d="M12 4v16M7 20.5h10M5 8h14M12 4.5 5 8M12 4.5 19 8"/><path d="M5 8 2.8 13h4.4L5 8ZM19 8l-2.2 5h4.4L19 8Z"/>' },
  { re: /arquitetur/i, nome: 'Arquitetura', frase: 'Você passou anos desenhando o espaço dos outros. Este aqui é [para você].',
    svg: '<path d="M12 3.5 4 20.5M12 3.5l8 17M7.5 14.5h9"/><path d="M12 3.5a1.6 1.6 0 1 0 0-.1Z" class="cheio"/>' },
  { re: /odontolog/i, nome: 'Odontologia', frase: 'Você devolveu o sorriso de muita gente. Hoje o sorriso é {o seu}.',
    svg: '<path d="M8 3.8c-2.4 0-3.8 1.9-3.8 4.6 0 4.3 1.7 12.6 3.6 12.6 1.4 0 1.3-5.3 4.2-5.3s2.8 5.3 4.2 5.3c1.9 0 3.6-8.3 3.6-12.6 0-2.7-1.4-4.6-3.8-4.6-1.9 0-2.6 1.1-4 1.1s-2.1-1.1-4-1.1Z"/>' },
  { re: /farm[aá]c/i, nome: 'Farmácia', frase: 'Da fórmula ao balcão, você cuidou de gente. Hoje [cuidamos de você].',
    svg: '<path d="M8 4h8M9.5 4c0 4-3 4.5-3 9.5a5.5 5.5 0 0 0 11 0c0-5-3-5.5-3-9.5"/><path d="M11 9.5c2.5 0 2.5 2.4 0 2.4s-2.5 2.4 0 2.4"/>' },
  { re: /veterin[aá]r/i, nome: 'Veterinária', frase: 'Você cuidou de quem não agradece com palavras. Hoje agradecemos com uma {festa}.',
    svg: '<circle cx="7" cy="9" r="1.8" class="cheio"/><circle cx="11" cy="6.5" r="1.8" class="cheio"/><circle cx="15.5" cy="7.5" r="1.8" class="cheio"/><circle cx="18" cy="11.5" r="1.8" class="cheio"/><path d="M12.5 11.5c-3 0-5.5 2.4-5.5 5 0 2 1.6 3 3.4 3 1.4 0 1.6-.7 2.6-.7s1.2.7 2.6.7c1.8 0 3.4-1 3.4-3 0-2.6-2.5-5-5.5-5Z"/>' },
  { re: /educa[cç][aã]o f[ií]sica/i, nome: 'Educação Física', frase: 'Você ensinou o corpo a ir além. A linha de chegada tem [música e brinde].',
    svg: '<path d="M4 9v6M7 7v10M17 7v10M20 9v6M7 12h10"/>' },
  { re: /engenhar/i, nome: 'Engenharia', frase: 'Cada cálculo, cada projeto, cada noite virada — a estrutura {ficou de pé}.',
    svg: '<circle cx="12" cy="12" r="3.4"/><path d="M12 3.5v3M12 17.5v3M3.5 12h3M17.5 12h3M6 6l2.1 2.1M15.9 15.9 18 18M18 6l-2.1 2.1M8.1 15.9 6 18"/>' },
  { re: /pedagog|letras|hist[oó]ria|geografia/i, nome: 'Licenciatura', frase: 'Você formou gente antes de se formar. Hoje a turma é [a sua].',
    svg: '<path d="M12 6.5C10.3 5.2 8 4.5 4 4.5v13c4 0 6.3.7 8 2 1.7-1.3 4-2 8-2v-13c-4 0-6.3.7-8 2Z"/><path d="M12 6.5v13"/>' },
  { re: /administra[cç][aã]o|cont[aá]beis|economia|gest[aã]o/i, nome: 'Gestão', frase: 'Você aprendeu a fazer as contas fecharem. Esta noite é o {melhor investimento}.',
    svg: '<path d="M4 20h16M7 20v-6M12 20V8M17 20v-9"/><path d="m5.5 9 5-4.5 4 3 4.5-4"/>' },
  { re: /.*/, nome: 'sua turma', frase: 'Foram anos de estudo para chegar até aqui. A noite é [à altura da conquista].',
    svg: '<path d="M12 3.5 22 8l-10 4.5L2 8l10-4.5Z"/><path d="M6.5 10.2V15c0 1.5 2.5 2.7 5.5 2.7s5.5-1.2 5.5-2.7v-4.8"/><path d="M22 8v5.5M22 13.5a1 1 0 1 0 0 3.2"/>' },
];

const cursoDe = (nome) => CURSOS.find((c) => c.re.test(nome || '')) || CURSOS[CURSOS.length - 1];

// ---------- cláusulas do contrato --------------------------------------------
// Texto igual ao do termo de adesão (adesao-contrato.template.ts). Toda citação
// na tela vira um "?" que abre o trecho, para o formando conferir sem sair daqui.
const CLAUSULAS = {
  // 06/10/2026: a parcela passou a ter VALOR FIXO. As cláusulas 4.1, 4.2 e 4.4
  // tratavam do desconto de pontualidade e saíram da tela — citar ao formando
  // uma regra que a cobrança não cumpre é pior do que não citar nada. Fica a
  // 4.3, na parte que vale.
  '4.3': 'Não quitada a parcela até o vencimento, incidirão juros de mora de 1% (um por cento) ao mês, calculados pro rata die.',
  // Cláusulas Sexta e Sétima do Termo de Adesão (adesao-contrato.template.ts), para a tela do pedido de cancelamento.
  '6.1': 'A desistência dependerá de comunicação formal por escrito (e-mail ou WhatsApp) à CONTRATADA. O simples abandono do contrato, a ausência aos eventos, a interrupção dos pagamentos ou qualquer forma de silêncio não será considerada desistência válida, mantendo-se a vigência das obrigações contratuais assumidas.',
  '6.2': 'Comunicada a desistência, incidirá cláusula penal, a título de pena convencional (art. 416, caput, do Código Civil), calculada sobre o valor total da adesão conforme a antecedência da comunicação em relação à festa de formatura.',
  '6.5': 'Após o cálculo da pena, a CONTRATADA realizará o encontro de contas com os valores já pagos pelo CONTRATANTE: se houver pago mais do que o devido, a diferença lhe será restituída em até 30 (trinta) dias úteis da formalização da desistência; se houver pago menos, complementará a diferença em até 10 (dez) dias úteis da notificação.',
  '7': 'O projeto de formatura compreende entregas escalonadas ao longo de todo o período contratado. Em caso de desistência, os valores correspondentes aos serviços já prestados serão devidos na proporção do serviço executado e não integram a base de restituição.',
  '8.1': 'O CONTRATANTE que estiver inadimplente com quaisquer parcelas do contrato terá seus direitos suspensos, ficando impedido de participar de eventos, ensaios e cerimônias (incluindo festa de meio de curso, foto-convite, pré-eventos e formatura), bem como de retirar convites ou benefícios, até a regularização total do débito.',
  '8.2': 'A inscrição do CONTRATANTE em cadastro de proteção ao crédito será precedida de notificação por escrito, com prazo de 15 (quinze) dias para regularização.',
  '8.3': 'A parte que der causa à cobrança extrajudicial de valores devidos por força deste contrato arcará com honorários de cobrança de 10% (dez por cento) sobre o valor exigido, obrigação que se aplica reciprocamente a ambas as partes.',
  '17.1': 'Este contrato poderá ser rescindido: (a) por acordo entre as partes; (b) por inadimplência superior a 90 (noventa) dias; ou (c) por descumprimento comprovado de suas cláusulas.',
  '17.3': 'Toda reprogramação da forma de pagamento acordada gera uma taxa de alteração fixa no valor de R$ 75,00 (setenta e cinco reais).',
};

// Citação com o "?" ao lado. O balão abre no hover e também no foco pelo
// teclado; no celular, o toque no "?" resolve.
function clausula(numero, prefixo = 'cláusula ') {
  const texto = CLAUSULAS[numero];
  if (!texto) return `<small>(cláusula ${escapar(numero)})</small>`;
  return `<span class="cita">(${escapar(prefixo)}${escapar(numero)})<button class="ajuda" type="button" aria-label="Ver a cláusula ${escapar(numero)}">?</button><span class="balao" role="tooltip"><b>Cláusula ${escapar(numero)}</b>${escapar(texto)}</span></span>`;
}

// O balão da cláusula é posicionado na janela (position: fixed), porque quase
// sempre ele nasce dentro de algo que rola — a folha, uma lista — e ali seria
// cortado pela borda da caixa. Aqui a conta é: centralizado na citação, acima
// dela se couber, senão abaixo, sempre dentro da tela. A seta acompanha.
function abrirBalao(cita) {
  const balao = cita.querySelector('.balao');
  if (!balao) return;
  fecharBaloes();
  balao.classList.remove('abaixo');
  balao.classList.add('aberto');

  const margem = 12;
  const c = cita.getBoundingClientRect();
  const b = balao.getBoundingClientRect();
  const meio = c.left + c.width / 2;

  const esquerda = Math.max(margem, Math.min(meio - b.width / 2, innerWidth - b.width - margem));
  let topo = c.top - b.height - 10;
  if (topo < margem) { topo = c.bottom + 10; balao.classList.add('abaixo'); }

  balao.style.left = `${Math.round(esquerda)}px`;
  balao.style.top = `${Math.round(topo)}px`;
  balao.style.setProperty('--seta-x', `${Math.round(Math.max(14, Math.min(meio - esquerda, b.width - 14)))}px`);
}

const fecharBaloes = () => document.querySelectorAll('.balao.aberto').forEach((b) => b.classList.remove('aberto'));
const citaDe = (alvo) => (alvo instanceof Element ? alvo.closest('.cita') : null);

document.addEventListener('mouseover', (e) => { const c = citaDe(e.target); if (c) abrirBalao(c); });
document.addEventListener('mouseout', (e) => {
  const c = citaDe(e.target);
  if (c && !c.contains(e.relatedTarget)) fecharBaloes();
});
document.addEventListener('focusin', (e) => { const c = citaDe(e.target); if (c) abrirBalao(c); else fecharBaloes(); });
// No celular não há hover: quem abre é o toque no "?". O toque sempre abre (e
// nunca alterna), porque o navegador emula um mouseover antes do clique — se
// alternasse, o balão abriria no emulado e fecharia no clique. Para fechar,
// toca-se fora, rola a tela ou aperta Esc.
document.addEventListener('click', (e) => {
  const ajuda = e.target instanceof Element ? e.target.closest('.ajuda') : null;
  if (ajuda) {
    e.preventDefault();
    return abrirBalao(ajuda.closest('.cita'));
  }
  if (!citaDe(e.target)) fecharBaloes();
});
// rolou ou redimensionou, a âncora saiu do lugar: some
document.addEventListener('scroll', fecharBaloes, true);
addEventListener('resize', fecharBaloes);

// Rabisco de caneta em volta da palavra, como no hero do site de formaturas.
// Vai atrás do texto, esticado pelo tamanho do span.
const RABISCO = `<svg class="rabisco" viewBox="0 0 200 64" preserveAspectRatio="none" aria-hidden="true">
  <path d="M167 12C143 5 107 3 76 5 45 7 14 14 8 27c-6 13 20 25 55 30 35 5 79 4 108-3 22-5 32-13 24-21-6-6-22-11-41-14" />
</svg>`;

// A frase do curso vem marcada: [assim] ganha o rabisco, {assim} vem na manuscrita.
function frasePintada(texto) {
  return escapar(texto)
    .replace(/\[([^\]]+)\]/g, (_, p) => `<span class="dest-circulo">${p}${RABISCO}</span>`)
    .replace(/\{([^}]+)\}/g, (_, p) => `<span class="dest-manu">${p}</span>`);
}

function moldura(conteudo, sub) {
  const t = estado.eu?.turma;
  const aba = ABAS.find((a) => a.id === estado.aba);
  const atrasadas = estado.financeiro?.boletos.filter((b) => b.status === 'em_atraso').length || 0;
  const naoLidas = estado.avisos?.naoLidas || 0;

  app.className = `app${estado.menuAberto ? ' menu-aberto' : ''}`;
  app.innerHTML = `
    <aside class="lateral">
      <div class="lateral-marca"><img src="/logo-formaturas.png" alt="Indaiá Formaturas" /></div>
      <div class="lateral-pessoa">
        <div class="nome">${escapar(semMarca(estado.eu?.nome))}</div>
        <div class="turma">${escapar(t ? `Turma ${t.codigo} · ${t.cidade}` : '')}</div>
      </div>
      <nav>
        ${ABAS.map((a) => `
          <button data-aba="${a.id}" class="${estado.aba === a.id ? 'ativo' : ''}">
            ${ICONES[a.id]}<span>${a.rotulo}</span>
            ${a.id === 'financeiro' && atrasadas ? `<span class="aviso">${atrasadas}</span>` : ''}
          </button>`).join('')}
      </nav>
      <div class="lateral-assinatura">transformando histórias.</div>
      <div class="lateral-rodape">
        <button id="meus-pedidos">${ICONES.pedidos}<span>Meus pedidos</span></button>
        <button id="meus-dados">${ICONES.pessoa}<span>Meus dados</span></button>
        <button id="duvidas">${ICONES.duvida}<span>Dúvidas frequentes</span></button>
        ${instalado() ? '' : `<button id="instalar">${ICONES.celular}<span>Instalar no celular</span></button>`}
        <button id="tema">${ICONES.tema}<span>${temaAtual() === 'escuro' ? 'Tema claro' : 'Tema escuro'}</span></button>
        <button id="ajuda">${ICONES.duvida}<span>Preciso de ajuda</span></button>
        <button id="sair">${ICONES.sair}<span>Sair</span></button>
      </div>
    </aside>
    <div class="cortina" id="cortina"></div>
    <div class="conteudo">
     <div class="faixa-central">
      <header class="topo">
        <div class="topo-interno">
          <button class="abrir-menu" id="abrir-menu" aria-label="Abrir menu">${ICONES.menu}</button>
          <div>
            <h1>${aba?.titulo || ''}</h1>
            ${sub ? `<div class="sub">${escapar(sub)}</div>` : ''}
          </div>
          <div class="topo-nome">
            <span class="kicker">Formando</span>
            <strong>${escapar(semMarca(estado.eu?.nome))}</strong>
          </div>
          ${temRecurso('notificacoes') ? `
          <button class="sino" id="sino" aria-label="Avisos">
            ${ICONES.sino}
            ${naoLidas ? `<span class="contador">${naoLidas > 9 ? '9+' : naoLidas}</span>` : ''}
          </button>` : ''}
        </div>
      </header>
      <main>${conteudo}</main>
     </div>
    </div>`;

  app.querySelectorAll('[data-aba]').forEach((b) => b.addEventListener('click', () => { estado.menuAberto = false; irPara(b.dataset.aba); }));
  app.querySelector('#sino')?.addEventListener('click', telaAvisos);
  app.querySelector('#meus-pedidos').addEventListener('click', telaMeusPedidos);
  // `() => telaMeusDados()` e não `telaMeusDados`: o primeiro parâmetro dela é a
  // mensagem de erro, e passar o handler direto fazia o evento do clique virar
  // essa mensagem — a tela abria com "[object PointerEvent]" escrito em cima do
  // botão.
  app.querySelector('#meus-dados').addEventListener('click', () => telaMeusDados());
  app.querySelector('#duvidas').addEventListener('click', telaPerguntas);
  app.querySelector('#ajuda').addEventListener('click', telaAjuda);
  app.querySelector('#instalar')?.addEventListener('click', telaInstalar);
  app.querySelector('#tema').addEventListener('click', alternarTema);
  app.querySelector('#sair').addEventListener('click', sair);
  app.querySelector('#abrir-menu').addEventListener('click', () => { estado.menuAberto = true; app.classList.add('menu-aberto'); });
  app.querySelector('#cortina').addEventListener('click', () => { estado.menuAberto = false; app.classList.remove('menu-aberto'); });
}

function notaRodape() {
  if (!estado.config?.modoDev) return '';
  // Na página publicada não existe "ambiente local": é uma demonstração aberta.
  const onde = estado.config.demo ? 'Versão de demonstração.' : 'Ambiente de teste local.';
  return `<p class="rodape-nota">${onde} ${escapar(estado.config.avisoDados || '')} Data simulada: ${dataCurta(estado.config.hojeSimulado)}.</p>`;
}

// ---------- pedaços reaproveitados ------------------------------------------
// A próxima cobrança a pagar: vencida primeiro, depois o que já tem boleto,
// depois o que ainda vai ser gerado. Parcela que está num boleto único não conta
// — quem conta é o boleto único.
function proximaParaPagar() {
  const bs = estado.financeiro?.boletos || [];
  const ordem = { em_atraso: 0, em_analise: 1, em_aberto: 2, agendado: 3, nao_gerado: 3 };
  return bs.filter((b) => !b.unico && b.status in ordem)
    .sort((a, b) => (ordem[a.status] - ordem[b.status]) || a.vencimento.localeCompare(b.vencimento))[0];
}

function cartaoDestaque(b) {
  if (!b) return '';
  const atraso = b.status === 'em_atraso';
  const temBoleto = b.status === 'em_aberto' || atraso;
  return `
    <div class="cartao destaque">
      <div class="rotulo">${atraso ? `${nomeCobranca(b)} em atraso` : b.unico ? 'Boleto único' : 'Próxima parcela'}</div>
      <div class="valor-grande">${brl(aPagar(b))}</div>
      <div class="quando">${escapar(apoioCobranca(b))} · ${atraso ? `venceu em ${dataCurta(b.vencimento)}` : `vence em ${dataCurta(b.vencimento)}`}</div>
      <div class="acoes"><button class="botao" data-boleto="${escapar(b.id)}">${atraso ? 'Gerar 2ª via' : temBoleto ? 'Ver boleto' : 'Ver parcela'}</button></div>
    </div>`;
}

function itemBoleto(b) {
  const atraso = b.status === 'em_atraso';
  const faixa = b.unico ? `${maiuscula(rotuloParcelas(b.unico.parcelas))} · ` : '';
  const quando = b.status === 'pago' ? `${faixa}${b.unico ? 'pago' : 'Pago'} em ${dataCurta(b.pagoEm)}`
    : b.status === 'em_analise' ? `Venceu em ${dataCurta(b.vencimento)} · comprovante em análise`
    : atraso ? `${faixa}${b.unico ? 'venceu' : 'Venceu'} em ${dataCurta(b.vencimento)}`
    : `${faixa}${b.unico ? 'vence' : 'Vence'} em ${dataCurta(b.vencimento)}`;
  return `
    <button class="item" data-boleto="${escapar(b.id)}">
      <div class="quando">
        <strong>${escapar(nomeCobranca(b))}${estado.visao === 'mes' ? '' : ` · ${mesAno(b.vencimento)}`}</strong>
        <span>${quando}</span>
        <br><span class="marca-status s-${b.status}">${ROTULO_STATUS[b.status]}</span>
        ${b.unicoAtivo ? '<span class="marca-status s-no_unico">No boleto único</span>' : ''}
        ${b.contestacao ? '<span class="marca-status s-contestada">Contestada</span>' : ''}
        ${b.qtdComprovantes ? '<span class="marca-status s-comprovante">Comprovante enviado</span>' : ''}
      </div>
      <div class="quanto">
        <b>${brl(aPagar(b))}</b>
        ${atraso && b.encargosHoje ? '<span class="economia">com juros e taxa</span>'
          : b.taxaBoleto ? `<span class="economia">inclui ${brl(b.taxaBoleto)} de taxa</span>` : ''}
      </div>
      <div class="seta">›</div>
    </button>`;
}

const ligarBoletos = () => app.querySelectorAll('[data-boleto]').forEach((b) => b.addEventListener('click', () => abrirBoleto(b.dataset.boleto)));


// Primeira coisa da tela inicial: o que precisa de você agora. Sai da mesma
// lista do sino, que já vem ordenada por urgência — aqui ficam os três
// primeiros, para a ação não morar embaixo da foto.
function painelAtencao() {
  const itens = (estado.avisos?.itens || []).slice(0, 3);
  const proxima = proximaParaPagar();

  if (!itens.length) {
    return `
      <div class="atencao">
        <div class="atencao-topo"><span class="kicker traco">Tudo em dia</span></div>
        <button class="atencao-item ok" data-ir="financeiro">
          <span class="selo">${ICONES.check}</span>
          <span class="texto">
            <strong>Nada pendente por aqui</strong>
            <span>${proxima ? `A próxima parcela vence em ${dataCurta(proxima.vencimento)}.` : 'Contrato quitado.'}</span>
          </span>
          <span class="seta">›</span>
        </button>
      </div>`;
  }

  return `
    <div class="atencao">
      <div class="atencao-topo">
        <span class="kicker traco">Importante</span>
        ${estado.avisos?.itens.length > 3 ? `<button class="botao fantasma" id="ver-todos-avisos" style="width:auto;padding:6px 10px">ver todos (${estado.avisos.itens.length})</button>` : ''}
      </div>
      ${itens.map((n) => `
        <button class="atencao-item ${n.tipo === 'atraso' ? 'urgente' : ''}" data-ir-aviso="${escapar(n.ir)}" ${n.billId ? `data-aviso-boleto="${escapar(n.billId)}"` : ''}>
          <span class="selo">${ICONE_AVISO[n.tipo] || ICONES.zap}</span>
          <span class="texto">
            <strong>${escapar(n.titulo)}</strong>
            <span>${escapar(n.texto)}</span>
          </span>
          <span class="seta">›</span>
        </button>`).join('')}
    </div>`;
}

function ligarPainelAtencao() {
  app.querySelector('#ver-todos-avisos')?.addEventListener('click', telaAvisos);
  app.querySelectorAll('[data-ir-aviso]').forEach((b) => b.addEventListener('click', async () => {
    const destino = b.dataset.irAviso;
    if (destino === 'pedidos') return telaMeusPedidos();
    await irPara(destino);
    if (b.dataset.avisoBoleto) abrirBoleto(b.dataset.avisoBoleto);
  }));
}

// ---------- aba: início ------------------------------------------------------
function abaInicio() {
  const t = estado.turma;
  const { resumo } = estado.financeiro;
  const proxima = proximaParaPagar();
  const dias = diasAte(t.dataEvento);
  const curso = cursoDe(estado.eu?.curso);

  moldura(`
    ${painelAtencao()}

    <div class="frase">
      <div class="simbolo">
        <svg viewBox="0 0 24 24" aria-hidden="true">${curso.svg}</svg>
      </div>
      <div>
        <p>${frasePintada(curso.frase)}</p>
        <div class="kicker curso">${escapar(estado.eu?.curso || curso.nome)}</div>
      </div>
    </div>

    <div class="cartao">
      <div class="kicker traco">Baile de gala</div>
      <h2 class="serif" style="margin:6px 0 2px;font-size:32px">${dataLonga(t.dataEvento)}</h2>
      <p style="margin:0;color:var(--texto-suave)">${escapar(t.espaco || t.cidade)} · ${escapar(t.cidade)}</p>
      <div class="contagem">
        <div><b>${dias}</b><span>dias para o baile</span></div>
        <div><b>${t.formandos}</b><span>formandos na turma</span></div>
        <div><b>${resumo.parcelasPagas}/${resumo.parcelas}</b><span>parcelas pagas</span></div>
      </div>
    </div>

    <div class="colunas duas">
      ${cartaoDestaque(proxima)}
      <div class="cartao">
        <div class="kicker">Seu contrato</div>
        <div class="dado"><span>Total</span><b>${brl(resumo.contratado)}</b></div>
        <div class="dado"><span>Pago</span><b>${brl(resumo.pago)}</b></div>
        <div class="dado"><span>Em aberto</span><b>${brl(resumo.emAberto + resumo.emAtraso + (resumo.emAnalise || 0) + resumo.aEmitir)}</b></div>
        <div class="barra"><i style="width:${(resumo.contratado ? Math.min(100, (resumo.pago / resumo.contratado) * 100) : 0).toFixed(1)}%"></i></div>
        <button class="botao secundario" data-ir="financeiro">Ver financeiro</button>
      </div>
    </div>

    ${notaRodape()}
  `, estado.eu?.turma ? `Turma ${estado.eu.turma.codigo} · ${escapar(t.curso)}` : '');

  ligarBoletos();
  ligarPainelAtencao();
  app.querySelectorAll('[data-ir]').forEach((b) => b.addEventListener('click', () => irPara(b.dataset.ir)));
}

// ---------- aba: financeiro --------------------------------------------------
// Mesmos recortes dos chips da Área do Cliente (Todas · Vencidas · Aguardando ·
// Pendentes · Pagas), com os nomes que valem para formatura.
const FILTROS = [
  { id: 'todas', rotulo: 'Todas', teste: () => true },
  { id: 'vencidas', rotulo: 'Vencidas', teste: (b) => b.status === 'em_atraso' || b.status === 'em_analise' },
  { id: 'aguardando', rotulo: 'Aguardando', teste: (b) => b.status === 'em_aberto' },
  { id: 'programadas', rotulo: 'Programadas', teste: (b) => b.status === 'agendado' || b.status === 'nao_gerado' },
  { id: 'pagas', rotulo: 'Pagas', teste: (b) => b.status === 'pago' },
];

function abaFinanceiro() {
  const { resumo, boletos } = estado.financeiro;
  // o boleto único mora numa seção própria; a lista é das parcelas do contrato
  const parcelas = boletos.filter((b) => !b.unico);
  // boleto único que expirou some daqui: as parcelas dele voltam para a lista
  const unicos = boletos.filter((b) => b.unico && b.status === 'em_aberto');
  const pct = resumo.contratado ? Math.min(100, (resumo.pago / resumo.contratado) * 100) : 0;
  const filtro = FILTROS.find((f) => f.id === estado.filtro) || FILTROS[0];
  const lista = parcelas.filter(filtro.teste).sort((a, b) => (filtro.id === 'pagas' ? -1 : 1) * a.vencimento.localeCompare(b.vencimento));
  const proxima = proximaParaPagar();
  const podeAntecipar = temRecurso('boletoUnico')
    && parcelas.some((b) => !b.unicoAtivo && ['em_aberto', 'em_atraso', 'agendado', 'nao_gerado'].includes(b.status));

  const emAberto = resumo.emAberto + resumo.emAtraso + (resumo.emAnalise || 0) + resumo.aEmitir;
  // As parcelas que o valor "Em aberto" ao lado REALMENTE soma: as que existem
  // e não foram pagas. O contrato pode ter mais — a soma nunca inclui parcela
  // que ainda não virou boleto, porque ela não tem valor conhecido. Contar as do
  // contrato aqui fazia a tela dizer "R$ 825,37 · 12 parcelas" quando só três
  // existiam, sugerindo R$ 68 cada. Quem fala do contrato é a nota do rodapé.
  const aPagarAgora = parcelas.filter((b) => b.status !== 'pago').length;
  // Quanto do contrato ainda não virou boleto — a nota do rodapé só aparece se
  // houver diferença, para não poluir quem já tem tudo emitido.
  const porGerar = Math.max(0, (resumo.parcelas || parcelas.length) - parcelas.length);
  const atrasadas = boletos.filter((b) => b.status === 'em_atraso');
  const emAnalise = boletos.filter((b) => b.status === 'em_analise');
  const negociar = atrasadas.length > MAX_VENCIDAS_SEM_EQUIPE;
  const diasMaisAntiga = atrasadas.length
    ? Math.max(...atrasadas.map((b) => Math.abs(diasAte(b.vencimento))))
    : 0;
  // prazo de rescisão por inadimplência, do termo de adesão (cláusula 17.1)
  const { diasInadimplenciaRescisao = 90 } = estado.config?.contrato || {};

  moldura(`
    <div class="hero-financeiro">
      <div class="kicker">Total do contrato · turma ${escapar(estado.eu?.turma?.codigo || '')}</div>
      <div class="total">${brl(resumo.contratado)}</div>
      <div class="par">
        <div>
          <div class="rot">Pago</div>
          <b class="ok">${brl(resumo.pago)}</b>
          <small>${resumo.parcelasPagas} parcela${resumo.parcelasPagas === 1 ? '' : 's'}</small>
        </div>
        <div>
          <div class="rot">Em aberto</div>
          <b>${brl(emAberto)}</b>
          <small>${aPagarAgora} parcela${aPagarAgora === 1 ? '' : 's'}</small>
        </div>
      </div>
      <div class="trilho"><i style="width:${pct.toFixed(1)}%"></i></div>
      <div class="pct">${pct.toFixed(0)}% pago</div>
      ${atrasadas.length > 1 ? `
        <div class="atraso">
          <span>${atrasadas.length} parcela${atrasadas.length > 1 ? 's' : ''} em atraso</span>
          <b>${brl(resumo.emAtraso)}</b>
        </div>` : ''}
      ${proxima ? `
        <div class="proxima ${proxima.status === 'em_atraso' ? 'atrasada' : ''}">
          <div>
            <div class="rot" style="font-size:13px;color:rgba(242,233,218,.6)">${proxima.status === 'em_atraso' ? `${escapar(nomeCobranca(proxima))} em atraso` : proxima.unico ? 'Boleto único' : 'Próxima parcela'}</div>
            <div class="valor">${brl(aPagar(proxima))}</div>
            <div class="quando">${escapar(apoioCobranca(proxima))} · ${proxima.status === 'em_atraso' ? 'venceu' : 'vence'} em ${dataCurta(proxima.vencimento)}${proxima.status === 'em_atraso' && proxima.encargosHoje ? ' · valor com encargos até hoje' : ''}</div>
          </div>
          <button class="botao" data-boleto="${escapar(proxima.id)}">${proxima.status === 'em_atraso' && temRecurso('segundaVia') ? 'Gerar 2ª via' : proxima.status === 'em_aberto' ? 'Ver boleto' : 'Ver parcela'}</button>
        </div>` : ''}
    </div>

    ${atrasadas.length ? `
      <div class="faixa alerta">
        <div>
          <b>${atrasadas.length === 1 ? 'Uma parcela vencida' : `${atrasadas.length} parcelas vencidas`}${diasMaisAntiga >= 30 ? ` — a mais antiga há ${diasMaisAntiga} dias` : ''}.</b>
          Enquanto houver parcela em aberto, a participação nos eventos, ensaios e a retirada de
          convites ficam suspensas ${clausula("8.1")}.
          ${diasMaisAntiga >= 60 ? ` Acima de ${diasInadimplenciaRescisao} dias o contrato pode ser rescindido ${clausula("17.1", "")}.` : ''}
          <b>Já pagou?</b> Anexe o comprovante na parcela que a equipe confere.
        </div>
      </div>
      <div class="acoes ${negociar ? 'dupla' : ''}" style="margin-bottom:12px">
        ${negociar ? '<button class="botao secundario" id="negociar">Quero falar com a equipe e negociar</button>' : ''}
        <button class="botao secundario" data-boleto="${escapar(atrasadas[0].id)}">${atrasadas.length === 1 ? 'Ver a parcela vencida' : 'Ver a vencida mais antiga'}</button>
      </div>` : ''}

    ${emAnalise.length ? `
      <div class="faixa ouro">
        <div>${emAnalise.length === 1 ? 'Uma parcela vencida está' : `${emAnalise.length} parcelas vencidas estão`}
        <b>em análise</b>: você anexou o comprovante e a equipe está conferindo. Assim que a baixa sair, a
        situação muda sozinha.</div>
      </div>` : ''}

    <div class="acoes-financeiro">
      ${podeAntecipar ? `
        <button class="acao-financeira" id="antecipar">
          <span class="ico">${ICONES.antecipar}</span>
          <span><strong>Antecipar ou quitar</strong><span class="desc">Boleto único na hora</span></span>
        </button>` : ''}
      <button class="acao-financeira" id="ver-extrato">
        <span class="ico">${ICONES.extrato}</span>
        <span><strong>Extrato e comprovantes</strong><span class="desc">O que você pagou e o que anexou</span></span>
      </button>
      ${temRecurso('informeIr') ? `
      <button class="acao-financeira" id="informe-ir">
        <span class="ico">${ICONES.informe}</span>
        <span><strong>Informe de pagamentos</strong><span class="desc">Para a declaração anual</span></span>
      </button>` : ''}
    </div>

    ${unicos.length ? `
      <div class="secao-titulo">Boleto único</div>
      <div class="lista" style="margin-bottom:14px">${unicos.map(itemBoleto).join('')}</div>` : ''}

    <div class="titulo-linha">
      <div class="secao-titulo" style="margin:0">Minhas parcelas</div>
      <div class="visao">
        ${VISOES.map((v) => `<button data-visao="${v.id}" class="${v.id === estado.visao ? 'ativo' : ''}">${v.rotulo}</button>`).join('')}
      </div>
    </div>
    <div class="filtros">
      ${FILTROS.map((f) => {
        const n = parcelas.filter(f.teste).length;
        // chip com contagem zero só ocupa espaço para dizer que não há nada
        if (!n && f.id !== 'todas' && f.id !== estado.filtro) return '';
        return `<button data-filtro="${f.id}" class="${f.id === estado.filtro ? 'ativo' : ''}"><i class="ponto p-${f.id}"></i>${f.rotulo} · ${n}</button>`;
      }).join('')}
    </div>
    ${lista.length ? agruparParcelas(lista)
      : '<div class="cartao plano"><div class="vazio">Nenhuma parcela nesta situação.</div></div>'}

    ${boletos.some((b) => b.taxaBoleto) ? `<p class="rodape-nota">Cada boleto soma a <b>taxa administrativa de gestão de conta</b> prevista no seu contrato.</p>` : ''}
    ${porGerar ? `<p class="rodape-nota">Seu contrato tem <b>${resumo.parcelas} parcelas</b>. Aqui aparecem as <b>${parcelas.length}</b> já emitidas — as outras ${porGerar} entram na lista conforme os boletos forem gerados. Nada a fazer por enquanto.</p>` : ''}
    <p class="rodape-nota">As parcelas <b>programadas</b> ainda não têm boleto — ele é gerado alguns dias antes do vencimento. Para pagar antes, use <b>Antecipar ou quitar</b>: o boleto único sai na hora.</p>
    ${notaRodape()}
  `, `${resumo.parcelasPagas} de ${resumo.parcelas} parcelas pagas`);

  app.querySelectorAll('[data-filtro]').forEach((b) => b.addEventListener('click', () => { estado.filtro = b.dataset.filtro; abaFinanceiro(); }));
  app.querySelectorAll('[data-visao]').forEach((b) => b.addEventListener('click', () => { guardarVisao(b.dataset.visao); abaFinanceiro(); }));
  app.querySelector('#antecipar')?.addEventListener('click', simulacaoAntecipacao);
  app.querySelector('#negociar')?.addEventListener('click', formularioNegociacao);
  app.querySelector('#ver-extrato')?.addEventListener('click', telaExtrato);
  app.querySelector('#informe-ir')?.addEventListener('click', telaInformeIr);
  ligarBoletos();
}

// ---------- antecipar / quitar ----------------------------------------------
// Decisão da equipe: o portal emite o boleto único na hora, sem aprovação caso a
// caso. A conta vem do servidor (/financeiro/antecipar/simular) — é a mesma que
// gera o boleto, então o valor da simulação é o valor do boleto. Parcela em dia
// entra pelo valor de face; vencida, com o juro de mora corrido até o
// vencimento do boleto único.
async function simulacaoAntecipacao() {
  const abertas = estado.financeiro.boletos
    .filter((b) => !b.unico && !b.unicoAtivo && ['em_aberto', 'em_atraso', 'agendado', 'nao_gerado'].includes(b.status))
    .sort((a, b) => a.parcela - b.parcela);
  const vencidas = abertas.filter((b) => b.status === 'em_atraso');

  const opcoes = [
    { id: '3', rotulo: 'Próximas 3 parcelas', lista: abertas.slice(0, 3) },
    { id: '6', rotulo: 'Próximas 6 parcelas', lista: abertas.slice(0, 6) },
    { id: '12', rotulo: 'Próximas 12 parcelas', lista: abertas.slice(0, 12) },
    { id: 'tudo', rotulo: 'Quitar o contrato', lista: abertas },
  ]
    // sem opção repetida: com 5 parcelas em aberto, "6" e "12" seriam o mesmo que quitar
    .filter((o) => o.lista.length && (o.id === 'tudo' || o.lista.length < abertas.length));

  if (!opcoes.length) return avisar('Suas parcelas em aberto já estão num boleto único');

  abrirFolha('<div class="vazio">Calculando…</div>');
  let sims;
  try {
    sims = await Promise.all(opcoes.map((o) => chamar('/financeiro/antecipar/simular', {
      method: 'POST', body: JSON.stringify({ billIds: o.lista.map((b) => b.id) }),
    })));
  } catch { return abrirFolha('<div class="vazio">Não foi possível simular agora.</div>'); }

  abrirFolha(`
    <h2>Antecipar ou <em>quitar</em></h2>
    <div class="sub">Escolha o que pagar e o boleto único sai na hora, com vencimento em ${sims[0].unico.diasParaVencer} dias.
    A taxa de boleto é cobrada uma vez, e não em cada parcela.</div>

    ${vencidas.length ? `<div class="faixa alerta"><div>${vencidas.length === 1 ? 'A parcela vencida entra' : 'As parcelas vencidas entram'}
      com os juros de mora corridos até o vencimento do boleto único ${clausula("4.3")}.</div></div>` : ''}

    <div class="lista-antecipa">
      ${opcoes.map((o, i) => `
        <button class="opcao-antecipa" data-opcao="${i}">
          <div class="quando">
            <strong>${o.rotulo}</strong>
            <span>${maiuscula(rotuloParcelas(sims[i].unico.parcelas))}</span>
          </div>
          <div class="quanto">
            <b>${brl(sims[i].totalBoleto ?? sims[i].valor)}</b>
            ${sims[i].economiaTaxa > 0 ? `<span class="economia">${brl(sims[i].economiaTaxa)} menos de taxa</span>` : ''}
          </div>
        </button>`).join('')}
    </div>

    <div class="acoes"><button class="botao fantasma" data-fechar-folha>Fechar</button></div>
  `, (el) => {
    el.querySelectorAll('[data-opcao]').forEach((b) => b.addEventListener('click', () => {
      const i = Number(b.dataset.opcao);
      confirmarAntecipacao(opcoes[i], sims[i]);
    }));
  });
}

function confirmarAntecipacao(opcao, sim) {
  const ps = sim.unico.parcelas;
  const linhaParcela = (p) => `
    <div class="dado">
      <span>Parcela ${p.parcela}${p.vencida ? ' <small>(vencida · com juros)</small>' : p.encargos ? ' <small>(valor da 2ª via)</small>' : ''}</span>
      <b>${brl(p.valor)}</b>
    </div>`;
  // quitar o contrato tem dezenas de parcelas: as primeiras à vista, o resto recolhido
  const visiveis = ps.slice(0, 6);
  const resto = ps.slice(6);

  abrirFolha(`
    <h2>${escapar(opcao.rotulo)}</h2>
    <div class="sub">${maiuscula(rotuloParcelas(ps))} num boleto só</div>

    <div class="secao-titulo">O que entra no boleto</div>
    ${visiveis.map(linhaParcela).join('')}
    ${resto.length ? `
      <details class="faq-item" style="margin-top:8px">
        <summary>e mais ${resto.length} parcela${resto.length > 1 ? 's' : ''}</summary>
        <div style="padding:0 16px 8px">${resto.map(linhaParcela).join('')}</div>
      </details>` : ''}

    <div class="secao-titulo">Boleto único</div>
    ${sim.taxaBoleto ? `<div class="dado"><span>Taxa administrativa <small>(uma só, em vez de ${ps.length})</small></span><b>+ ${brl(sim.taxaBoleto)}${sim.economiaTaxa > 0 ? ` <small class="verde">poupa ${brl(sim.economiaTaxa)}</small>` : ''}</b></div>` : ''}
    <div class="dado"><span>Vencimento</span><b>${dataCurta(sim.vencimento)}</b></div>
    <div class="dado"><span>Total do boleto</span><b class="destaque-valor">${brl(sim.totalBoleto ?? sim.valor)}</b></div>

    <p class="rodape-nota">As parcelas continuam com os boletos delas. Pagando o boleto único, elas são
    quitadas de uma vez; se ele não for pago até o vencimento, é cancelado e nada muda nas parcelas.</p>
    <div class="acoes dupla">
      <button class="botao" id="gerar-unico">Gerar boleto único</button>
      <button class="botao secundario" id="voltar-antecipa">Ver outras opções</button>
    </div>
  `, (el) => {
    el.querySelector('#voltar-antecipa').addEventListener('click', simulacaoAntecipacao);
    el.querySelector('#gerar-unico').addEventListener('click', async (e) => {
      e.target.disabled = true; e.target.textContent = 'Gerando…';
      try {
        const novo = await chamar('/financeiro/antecipar', {
          method: 'POST', body: JSON.stringify({ billIds: ps.map((p) => p.id) }),
        });
        estado.financeiro = await chamar('/financeiro');
        estado.avisos = await chamar('/notificacoes').catch(() => estado.avisos);
        abaFinanceiro();
        avisar('Boleto único gerado');
        abrirBoleto(novo.id);
      } catch (err) {
        e.target.disabled = false; e.target.textContent = 'Gerar boleto único';
        // Igual à 2ª via: endereço que falta não é erro, é um passo que ficou
        // para trás. Nada foi gerado, e as parcelas seguem como estavam.
        if (codigoDoErro(err) === 'endereco_incompleto') {
          return telaEndereco({
            aviso: err.detalhe || err?.corpo?.message || 'Para emitir o boleto, falta o seu endereço.',
            depois: simulacaoAntecipacao,
          });
        }
        avisar('Não foi possível gerar o boleto agora');
      }
    });
  });
}

// Como a lista é mostrada: corrida, agrupada por mês ou por ano. A escolha fica
// no navegador, como o tema.
const VISOES = [
  { id: 'lista', rotulo: 'Lista' },
  { id: 'mes', rotulo: 'Mês' },
  { id: 'ano', rotulo: 'Ano' },
];

const visaoGuardada = () => {
  try {
    const salva = localStorage.getItem('formando_visao');
    if (VISOES.some((v) => v.id === salva)) return salva;
  } catch { /* modo privado */ }
  return 'ano';
};

function guardarVisao(v) {
  estado.visao = v;
  try { localStorage.setItem('formando_visao', v); } catch { /* segue sem lembrar */ }
}

const agruparParcelas = (lista) => (estado.visao === 'lista'
  ? `<div class="lista">${lista.map(itemBoleto).join('')}</div>`
  : estado.visao === 'mes' ? listaPorMes(lista) : listaPorAno(lista));

// Por mês: abre o mês corrente e todo mês com parcela vencida.
function listaPorMes(boletos) {
  const meses = [...new Set(boletos.map((b) => b.vencimento.slice(0, 7)))];
  const mesCorrente = hoje().slice(0, 7);
  return meses.map((mes) => {
    const doMes = boletos.filter((b) => b.vencimento.startsWith(mes));
    const total = doMes.reduce((a, b) => a + aPagar(b), 0);
    const atrasadas = doMes.filter((b) => b.status === 'em_atraso').length;
    return `
      <details class="grupo-ano" ${mes === mesCorrente || atrasadas ? 'open' : ''}>
        <summary>
          <span class="ano mes">${maiuscula(mesAno(`${mes}-01`))}</span>
          <span class="qtd">${doMes.length} parcela${doMes.length === 1 ? '' : 's'}${atrasadas ? ` · <b class="atrasada">${atrasadas} em atraso</b>` : ''}</span>
          <span class="soma">${brl(total)}</span>
        </summary>
        <div class="lista">${doMes.map(itemBoleto).join('')}</div>
      </details>`;
  }).join('');
}

// Com 30+ parcelas a lista vira um paredão: agrupa por ano e abre o ano
// corrente e o que tiver parcela em atraso.
function listaPorAno(boletos) {
  const anos = [...new Set(boletos.map((b) => b.vencimento.slice(0, 4)))];
  if (anos.length === 1) return corpoDoAno(boletos);

  const anoAtual = hoje().slice(0, 4);
  return anos.map((ano) => {
    const doAno = boletos.filter((b) => b.vencimento.startsWith(ano));
    const total = doAno.reduce((a, b) => a + aPagar(b), 0);
    const atrasadas = doAno.filter((b) => b.status === 'em_atraso').length;
    const aberto = ano === anoAtual || atrasadas > 0;
    return `
      <details class="grupo-ano" ${aberto ? 'open' : ''}>
        <summary>
          <span class="ano">${ano}</span>
          <span class="qtd">${doAno.length} parcela${doAno.length === 1 ? '' : 's'}${atrasadas ? ` · <b class="atrasada">${atrasadas} em atraso</b>` : ''}</span>
          <span class="soma">${brl(total)}</span>
        </summary>
        ${corpoDoAno(doAno)}
      </details>`;
  }).join('');
}

// Dentro do ano, o que já foi pago fica recolhido: quem abre o financeiro quer
// ver o que falta, não a lista do que acabou.
function corpoDoAno(doAno) {
  const pagas = doAno.filter((b) => b.status === 'pago');
  const resto = doAno.filter((b) => b.status !== 'pago');
  if (pagas.length < 3 || !resto.length) return `<div class="lista">${doAno.map(itemBoleto).join('')}</div>`;

  const somaPagas = pagas.reduce((a, b) => a + (b.valorPago || b.valor), 0);
  return `
    <details class="grupo-ano">
      <summary>
        <span class="qtd"><b>${pagas.length} parcelas pagas</b> · parcela ${pagas[0].parcela} a ${pagas[pagas.length - 1].parcela}</span>
        <span class="soma">${brl(somaPagas)}</span>
      </summary>
      <div class="lista">${pagas.map(itemBoleto).join('')}</div>
    </details>
    <div class="lista">${resto.map(itemBoleto).join('')}</div>`;
}

// Onde o valor mudou por atraso, a tela explica a conta: o valor da parcela,
// o juro de mora que correu e o total. A conta aparece no momento de pagar uma
// cobrança vencida ou com valor atualizado, não como aviso solto pelo site.
function composicaoAtraso(e, rotuloTotal, taxa = 0) {
  return `
    <div class="dado"><span>Valor da parcela</span><b>${brl(e.valorParcela)}</b></div>
    <div class="dado"><span>Juros de mora <small>(1% ao mês, ${e.diasAtraso} dia${e.diasAtraso === 1 ? '' : 's'})</small></span><b>+ ${brl(e.juros)}</b></div>
    ${taxa ? `<div class="dado"><span>${rotuloTotal}</span><b>${brl(e.total)}</b></div>
    <div class="dado"><span>Taxa administrativa de gestão de conta</span><b>+ ${brl(taxa)}</b></div>
    <div class="dado"><span>Total do boleto</span><b class="destaque-valor">${brl(arredondar(e.total + taxa))}</b></div>`
      : `<div class="dado"><span>${rotuloTotal}</span><b class="destaque-valor">${brl(e.total)}</b></div>`}
    <p class="rodape-nota" style="margin-top:8px">O valor da parcela é fixo. Depois do vencimento
    entram juros de mora de 1% ao mês, calculados por dia de atraso ${clausula("4.3")}.</p>`;
}

// \`individual\`: a pessoa já disse que quer pagar esta parcela sozinha, mesmo ela
// estando num boleto único.
async function abrirBoleto(id, { individual = false } = {}) {
  abrirFolha('<div class="vazio">Carregando…</div>');
  let b;
  try { b = await chamar(`/financeiro/${id}`); }
  catch { return abrirFolha('<div class="vazio">Não foi possível abrir esta cobrança.</div>'); }

  const atraso = b.status === 'em_atraso';
  const semBoleto = b.status === 'agendado' || b.status === 'nao_gerado';
  // Pagável = dá para pagar agora. O protótipo só conhecia a linha digitável;
  // o CRM devolve o LINK da fatura na operadora, que abre o boleto com código
  // de barras. Sem isto o formando via a parcela e não tinha como pagar.
  const pagavel = b.status === 'em_aberto' && (b.linhaDigitavel || b.urlPagamento);
  // Não dá para impedir o pagamento de um boleto que já existe (ele pode estar
  // salvo, impresso ou no app do banco). O que dá é segurar a linha digitável
  // e a 2ª via desta parcela atrás de um aviso quando ela está num boleto único.
  const noUnicoPagavel = Boolean(b.unicoAtivo) && (b.status === 'em_aberto' || atraso);
  const segurarIndividual = noUnicoPagavel && !individual;

  // o que se deve e por quê
  let valores;
  if (b.unico) {
    valores = `
      <div class="secao-titulo" style="margin-top:4px">Parcelas neste boleto</div>
      ${b.unico.parcelas.map((p) => `
        <div class="dado">
          <span>Parcela ${p.parcela}${p.vencida ? ` <small>(vencida · com juros até ${dataCurta(b.vencimento)})</small>` : p.encargos ? ' <small>(valor da 2ª via)</small>' : ''}</span>
          <b>${brl(p.valor)}</b>
        </div>`).join('')}
      ${b.taxaBoleto ? `<div class="dado"><span>Taxa administrativa <small>(uma só, em vez de ${b.unico.parcelas.length})</small></span><b>+ ${brl(b.taxaBoleto)}</b></div>` : ''}
      <div class="dado"><span>Total do boleto único</span><b class="destaque-valor">${brl(aPagar(b))}</b></div>
      ${b.status === 'em_aberto' ? `<p class="rodape-nota" style="margin-top:8px">As parcelas continuam com os boletos delas.
      Pagando este, elas são quitadas de uma vez; se ele não for pago até ${dataCurta(b.vencimento)}, é
      cancelado e nada muda nas parcelas.</p>` : ''}`;
  } else if (b.encargos) {
    // já tem 2ª via: a conta é a da data nova
    valores = composicaoAtraso(b.encargos, 'Valor da 2ª via', b.taxaBoleto);
  } else if (b.encargosHoje) {
    // Vale também para "em análise": a parcela continua vencida e o valor
    // continua com o juro corrido — esconder a composição deixava o formando
    // olhando para R$ 319,57 numa parcela de R$ 250 sem explicação.
    valores = composicaoAtraso(b.encargosHoje, 'Valor hoje', b.taxaBoleto);
  } else if (b.status === 'pago') {
    valores = `<div class="dado"><span>Valor pago</span><b class="destaque-valor">${brl(b.valorPago || b.valor)}</b></div>`;
  } else {
    valores = `
      <div class="dado"><span>Valor da parcela</span><b>${brl(b.valor)}</b></div>
      ${b.taxaBoleto ? `<div class="dado"><span>Taxa administrativa de gestão de conta</span><b>+ ${brl(b.taxaBoleto)}</b></div>` : ''}
      <div class="dado"><span>Total do boleto</span><b class="destaque-valor">${brl(aPagar(b))}</b></div>`;
  }

  // o que dá para fazer com ela
  let acoes = '';
  if (b.status === 'em_analise') {
    const c = (b.comprovantes || []).find((x) => x.status === 'em_analise');
    acoes = `
      <div class="faixa ouro" style="margin-top:16px">
        <div><b>Comprovante em análise.</b> Você anexou ${c ? escapar(c.arquivo) : 'o comprovante'} em
        ${c ? dataCurta(c.enviadoEm.slice(0, 10)) : 'dias atrás'} e a equipe está conferindo. Quando a baixa sair,
        a parcela muda sozinha.${temRecurso('segundaVia') ? ' Se o pagamento não for confirmado, você ainda pode gerar a 2ª via.' : ''}</div>
      </div>
      ${temRecurso('segundaVia') ? '<div class="acoes"><button class="botao secundario" id="segunda-via">Gerar 2ª via mesmo assim</button></div>' : ''}`;
  } else if (atraso && !b.unico) {
    acoes = `
      ${temRecurso('segundaVia') ? `
        <div class="faixa alerta" style="margin-top:14px">
          <div><b>O boleto vencido não é aceito pelo banco.</b> Gere a 2ª via com uma data nova — ela
          já sai com o valor acima atualizado até o dia escolhido.</div>
        </div>
        <div class="acoes"><button class="botao" id="segunda-via">Gerar 2ª via</button></div>` : `
        <div class="faixa alerta" style="margin-top:14px">
          <div><b>O boleto vencido não é aceito pelo banco.</b> Fale com a equipe para receber a 2ª
          via com o valor atualizado — é o mesmo valor mostrado acima, até a data do pagamento.</div>
        </div>
        <div class="acoes"><button class="botao secundario" id="falar-equipe">Falar com a equipe</button></div>`}`;
  } else if (pagavel) {
    acoes = b.linhaDigitavel
      ? `
      <div class="secao-titulo">Linha digitável</div>
      <div class="linha-digitavel" id="linha">${escapar(b.linhaDigitavel)}</div>
      <div class="acoes ${window.API_RECURSOS?.pdfDoBoleto === false ? '' : 'dupla'}">
        <button class="botao" id="copiar">Copiar linha</button>
        ${window.API_RECURSOS?.pdfDoBoleto === false ? '' : '<button class="botao secundario" id="pdf">Abrir PDF</button>'}
      </div>
      <div class="acoes"><button class="botao secundario" id="compartilhar">Compartilhar</button></div>`
      // Só o link: é a fatura na operadora, com o código de barras e o PDF.
      // Abre em aba nova para o formando não perder o portal. A casa NÃO
      // trabalha com Pix — não prometer aqui o que a cobrança não aceita.
      : `
      <div class="acoes"><a class="botao" id="abrir-boleto" href="${escapar(b.urlPagamento)}" target="_blank" rel="noopener">Abrir boleto para pagar</a></div>
      <p class="rodape-nota">O boleto abre em outra aba, com o código de barras para pagar no
      aplicativo do seu banco e a opção de salvar em PDF.</p>`;
  } else if (semBoleto) {
    // Decisão da equipe: só se paga o que já tem boleto gerado. Para adiantar,
    // o caminho é o boleto único.
    acoes = `
      <div class="faixa info" style="margin-top:16px"><div>O boleto desta parcela ainda não foi gerado —
      ele fica disponível alguns dias antes do vencimento. Se quiser pagar antes, inclua esta
      parcela num boleto único.</div></div>
      <div class="acoes"><button class="botao secundario" id="ir-antecipar">Antecipar parcelas</button></div>`;
  } else if (b.status === 'expirado') {
    acoes = `
      <div class="faixa info" style="margin-top:16px"><div>Este boleto único venceu sem pagamento e foi cancelado.
      As parcelas dele continuam com os boletos delas, como estavam.</div></div>`;
  } else if (b.status === 'pago') {
    acoes = `
      <div class="faixa info" style="margin-top:16px">${b.unico ? 'Boleto quitado.' : 'Parcela quitada.'}</div>
      ${b.unico || !temRecurso('recibo') ? '' : '<div class="acoes"><button class="botao secundario" id="recibo">Baixar recibo desta parcela</button></div>'}`;
  }

  const comprovantesDaCobranca = (b.comprovantes || []);
  const corpo = `
    <h2>${escapar(nomeCobranca(b))}</h2>
    <div class="sub">${escapar(ROTULO_STATUS[b.status])} · ${atraso ? 'venceu' : b.status === 'pago' ? 'venceu' : 'vence'} em ${dataLonga(b.vencimento)}${b.pagoEm ? ` · pago em ${dataCurta(b.pagoEm)}` : ''}</div>

    ${valores}
    <div class="dado"><span>Referente a</span><b>${escapar(descricaoAmigavel(b))}</b></div>

    ${segurarIndividual ? `
      <div class="faixa ouro" style="margin-top:16px"><div><b>Esta parcela já está num boleto único</b> que vence em
      ${dataCurta(b.unicoAtivo.vencimento)}. Pague só um dos dois — pagando o boleto único, ela é quitada junto.
      Se pagar esta parcela sozinha, não pague mais o boleto único.</div></div>
      <div class="acoes dupla">
        <button class="botao" id="ver-unico">Pagar pelo boleto único</button>
        <button class="botao secundario" id="so-esta">Pagar só esta parcela</button>
      </div>` : b.unicoAtivo ? `
      <div class="faixa ouro" style="margin-top:16px"><div>Você escolheu pagar só esta parcela. Ela continua no
      boleto único de ${dataCurta(b.unicoAtivo.vencimento)}: <b>não pague os dois</b>.</div></div>` : b.unicoAtivo && !noUnicoPagavel ? `
      <div class="faixa info" style="margin-top:16px"><div>Esta parcela está no boleto único que vence em
      ${dataCurta(b.unicoAtivo.vencimento)}. Pagando ele, ela é quitada junto.</div></div>
      <div class="acoes"><button class="botao secundario" id="ver-unico">Ver o boleto único</button></div>` : ''}

    ${segurarIndividual || (b.unicoAtivo && !noUnicoPagavel) ? '' : acoes}

    ${semBoleto ? '' : `
      <div class="secao-titulo">Comprovante</div>
      ${comprovantesDaCobranca.length ? `
        <div class="lista-comprovantes">
          ${comprovantesDaCobranca.map((c) => `
            <div class="comprovante">
              <span class="ico">${ICONES.anexo}</span>
              <div class="quando">
                <strong>${escapar(c.arquivo)}</strong>
                <span>Enviado em ${dataCurta(c.enviadoEm.slice(0, 10))} · ${Math.max(1, Math.round(c.tamanho / 1024))} KB</span>
              </div>
              <span class="marca-status s-em_aberto">${c.status === 'em_analise' ? 'Em análise' : escapar(c.status)}</span>
            </div>`).join('')}
        </div>` : `
        <p class="rodape-nota" style="margin-top:0">Pagou e ainda não baixou? Anexe o comprovante que a equipe confere.</p>`}
      <div class="acoes"><button class="botao secundario" id="enviar-comprovante">Enviar comprovante</button></div>
    `}

    ${(b.historico || []).length ? `
      <div class="secao-titulo">O que já aconteceu ${b.unico ? 'com este boleto' : 'com esta parcela'}</div>
      ${b.historico.map((h) => `
        <div class="historico-item">
          <div class="quando">${dataCurta(h.quando.slice(0, 10))}</div>
          <div class="oque">
            <strong>${escapar(h.oQue)}</strong>
            ${h.detalhe ? `<span>${escapar(h.detalhe)}</span>` : ''}
          </div>
        </div>`).join('')}` : ''}

    ${b.contestacao ? `
      <div class="faixa ouro" style="margin-top:16px">
        <div><b>Você contestou esta cobrança</b> em ${dataCurta(b.contestacao.criadoEm.slice(0, 10))}${b.contestacao.motivo ? `: ${escapar(b.contestacao.motivo.toLowerCase())}` : ''}.
        Protocolo ${escapar(b.contestacao.protocolo)}. A equipe está analisando; até lá a cobrança continua valendo.</div>
      </div>
      <div class="acoes"><button class="botao fantasma" id="ver-contestacao">Ver minha contestação</button></div>`
      : semBoleto || b.status === 'pago' ? '' : `
      <div class="acoes"><button class="botao fantasma" id="contestar">Não reconheço esta cobrança</button></div>`}

    <div class="acoes"><button class="botao fantasma" data-fechar-folha>Fechar</button></div>`;

  abrirFolha(corpo, (el) => {
    el.querySelector('#recibo')?.addEventListener('click', () => abrirRecibo(id));
    el.querySelector('#segunda-via')?.addEventListener('click', () => formularioSegundaVia(id, b));
    // Só aparece quando a 2ª via ainda não existe do outro lado: a conversa é a
    // saída, e já vai com a parcela escrita para ninguém ter de explicar qual é.
    el.querySelector('#falar-equipe')?.addEventListener('click', () =>
      abrirWhatsapp(`Olá! Preciso da 2ª via da ${nomeCobranca(b)}, que venceu em ${dataCurta(b.vencimento)}.`));
    el.querySelector('#contestar')?.addEventListener('click', () => formularioContestacao(id, b));
    el.querySelector('#ver-contestacao')?.addEventListener('click', telaMeusPedidos);
    el.querySelector('#enviar-comprovante')?.addEventListener('click', () => formularioComprovante(id, b));
    el.querySelector('#copiar')?.addEventListener('click', () => copiar(b.linhaDigitavel));
    el.querySelector('#pdf')?.addEventListener('click', () => abrirPdf(id, b));
    el.querySelector('#compartilhar')?.addEventListener('click', () => compartilharBoleto(id, b));
    el.querySelector('#ir-antecipar')?.addEventListener('click', simulacaoAntecipacao);
    el.querySelector('#ver-unico')?.addEventListener('click', () => abrirBoleto(b.unicoAtivo.id));
    el.querySelector('#so-esta')?.addEventListener('click', () => abrirBoleto(id, { individual: true }));
  });
}

// O PDF sai de /financeiro/:id/pdf, que exige o token — por isso vem por fetch e
// não por link direto. O blob é aberto numa aba nova.
async function baixarPdf(id) {
  const resposta = await fetch(urlDoArquivo(`/financeiro/${id}/pdf`), {
    headers: { authorization: `Bearer ${estado.token}` },
  });
  if (!resposta.ok) throw new Error('falha');
  return resposta.blob();
}

// Prévia do boleto na própria tela. É o que a versão publicada mostra no lugar
// do PDF: o visualizador de páginas publicadas não deixa a página iniciar um
// download. No ambiente local, o botão baixa o PDF de verdade.
function previaBoleto(d) {
  abrirFolha(`
    <div class="boleto-papel">
      <div class="boleto-marca">INDAIÁ EVENTOS · FORMATURAS</div>
      <div class="boleto-sub">${d.unico ? 'Boleto único de antecipação' : 'Boleto de parcela do termo de adesão'}</div>
      <h2>${d.unico ? 'Boleto único' : `Parcela ${d.parcela} de ${d.totalParcelas}`}</h2>
      <div class="sub">${escapar(d.turma)}</div>
      <div class="dado"><span>Formando</span><b>${escapar(semMarca(d.formando))}</b></div>
      <div class="dado"><span>CPF</span><b>${escapar(d.cpf)}</b></div>
      <div class="dado"><span>Evento</span><b>${escapar(d.evento)}</b></div>
      <div class="dado"><span>Descrição</span><b>${escapar(d.descricao)}</b></div>
      <div class="dado"><span>Vencimento</span><b>${dataCurta(d.vencimento)}</b></div>
      <div class="dado"><span>Valor</span><b>${brl(d.valor)}</b></div>
      <div class="dado"><span>Situação</span><b>${ROTULO_STATUS[d.status] || d.status}</b></div>
      ${d.pagoEm ? `<div class="dado"><span>Pago em</span><b>${dataCurta(d.pagoEm)}</b></div>` : ''}
      ${d.linhaDigitavel ? `
        <div class="secao-titulo">Linha digitável</div>
        <div class="linha-digitavel">${escapar(d.linhaDigitavel)}</div>` : ''}
    </div>
    <p class="rodape-nota">No app de verdade este botão baixa o PDF do boleto. Aqui, na página
    publicada, o navegador não deixa a página iniciar downloads — então o boleto aparece na tela.</p>
    <div class="acoes"><button class="botao fantasma" data-fechar-folha>Fechar</button></div>
  `);
}

async function abrirPdf(id, b) {
  if (estado.config?.demo) {
    try { return previaBoleto(await chamar(`/financeiro/${id}/pdf`)); }
    catch { return avisar('Não foi possível abrir o boleto agora'); }
  }
  avisar('Gerando o PDF…');
  try {
    const blob = await baixarPdf(id);
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.target = '_blank';
    a.rel = 'noopener';
    a.download = `${b.unico ? 'boleto-unico' : `parcela-${b.parcela}`}.pdf`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  } catch { avisar('Não foi possível abrir o PDF agora'); }
}

// Compartilhar: no celular abre a folha nativa (WhatsApp, e-mail, arquivos) com o
// PDF anexado; sem suporte a arquivo, manda só o texto; sem Web Share, cai no
// WhatsApp Web.
async function compartilharBoleto(id, b) {
  const texto = [
    `${nomeCobranca(b)} · ${escapar(estado.eu?.turma?.rotulo || '')}`.replace(/&[a-z]+;/g, ' '),
    `Vencimento: ${dataCurta(b.vencimento)}`,
    `Valor: ${brl(devido(b))}`,
    b.linhaDigitavel ? `Linha digitável: ${b.linhaDigitavel}` : '',
  ].filter(Boolean).join('\n');

  try {
    if (estado.config?.demo) throw new Error('sem arquivo na demonstração');
    const blob = await baixarPdf(id);
    const arquivo = new File([blob], `${b.unico ? 'boleto-unico' : `parcela-${b.parcela}`}.pdf`, { type: 'application/pdf' });
    if (navigator.canShare?.({ files: [arquivo] })) {
      await navigator.share({ title: nomeCobranca(b), text: texto, files: [arquivo] });
      return;
    }
  } catch (err) {
    if (err?.name === 'AbortError') return; // a pessoa fechou a folha de compartilhamento
  }

  try {
    if (navigator.share) { await navigator.share({ title: nomeCobranca(b), text: texto }); return; }
  } catch (err) {
    if (err?.name === 'AbortError') return;
  }

  window.open(`https://wa.me/?text=${encodeURIComponent(texto)}`, '_blank', 'noopener');
}

// ---------- extrato de pagamentos --------------------------------------------
// O que responde a "estão me cobrando de novo" e serve de comprovação.
async function telaExtrato() {
  abrirFolha('<div class="vazio">Carregando…</div>');
  let e, qtdComprovantes = 0;
  try {
    const [extrato, comps] = await Promise.all([chamar('/extrato'), chamar('/comprovantes').catch(() => ({ comprovantes: [] }))]);
    e = extrato; qtdComprovantes = comps.comprovantes.length;
  }
  catch { return abrirFolha('<div class="vazio">Não foi possível montar o extrato agora.</div>'); }

  abrirFolha(`
    <h2>Extrato de <em>pagamentos</em></h2>
    <div class="sub">Emitido em ${dataCurta(e.emitidoEm.slice(0, 10))}</div>

    <button class="comprovante" id="ver-comprovantes" style="margin-bottom:14px">
      <span class="ico">${ICONES.anexo}</span>
      <span class="quando">
        <strong>Meus comprovantes</strong>
        <span>${qtdComprovantes ? `${qtdComprovantes} anexado${qtdComprovantes > 1 ? 's' : ''} por você` : 'Os comprovantes que você anexar ficam aqui'}</span>
      </span>
      <span class="seta">›</span>
    </button>

    <div class="dado"><span>Contrato</span><b>${brl(e.contrato.total)} em ${e.contrato.parcelas}×</b></div>
    <div class="dado"><span>Assinado em</span><b>${dataCurta(e.contrato.assinadoEm)}</b></div>
    <div class="dado"><span>Parcelas pagas</span><b>${e.totais.parcelasPagas} de ${e.contrato.parcelas}</b></div>
    <div class="dado"><span>Total pago</span><b class="verde">${brl(e.totais.pago)}</b></div>
    <div class="dado"><span>Em aberto</span><b>${brl(e.totais.emAberto)}</b></div>
    <div class="dado"><span>Parcela contratada</span><b>${brl(e.contrato.mensalidade)}</b></div>

    <div class="secao-titulo">Pagamentos</div>
    ${e.pagamentos.length ? `
      <div class="lista">
        ${e.pagamentos.map((pg) => `
          <div class="item inerte">
            <div class="quando">
              <strong>Parcela ${pg.parcela}</strong>
              <span>Vencia em ${dataCurta(pg.vencimento)} · pago em ${dataCurta(pg.pagoEm)} · ${escapar(pg.forma)}</span>
            </div>
            <div class="quanto"><b>${brl(pg.valorPago)}</b></div>
          </div>`).join('')}
      </div>` : '<div class="cartao plano"><div class="vazio">Nenhuma parcela paga ainda.</div></div>'}

    <div class="acoes dupla">
      <button class="botao secundario" id="extrato-pdf">Abrir em PDF</button>
      ${e.totais.quitado
        ? '<button class="botao" id="pedir-quitacao">Pedir declaração de quitação</button>'
        : '<button class="botao secundario" data-fechar-folha>Fechar</button>'}
    </div>
    ${e.totais.quitado ? '' : `
      <p class="rodape-nota">A declaração de quitação fica disponível quando a última parcela for paga.</p>`}
  `, (el) => {
    el.querySelector('#extrato-pdf').addEventListener('click', abrirExtratoPdf);
    el.querySelector('#ver-comprovantes').addEventListener('click', telaComprovantes);
    el.querySelector('#pedir-quitacao')?.addEventListener('click', async (ev) => {
      ev.target.disabled = true; ev.target.textContent = 'Enviando…';
      try {
        const s = await chamar('/solicitacoes', {
          method: 'POST',
          body: JSON.stringify({ tipo: 'quitacao', mensagem: 'Pedido de declaração de quitação do contrato.' }),
        });
        fecharFolha();
        avisar(`Pedido enviado — protocolo ${s.protocolo}`);
      } catch { avisar('Não foi possível pedir agora'); }
    });
  });
}

async function abrirExtratoPdf() {
  if (estado.config?.demo) return avisar('No app de verdade, este botão baixa o extrato em PDF');
  avisar('Gerando o PDF…');
  try {
    const resposta = await fetch(urlDoArquivo(`/extrato/pdf`), { headers: { authorization: `Bearer ${estado.token}` } });
    if (!resposta.ok) throw new Error('falha');
    const url = URL.createObjectURL(await resposta.blob());
    const a = document.createElement('a');
    a.href = url; a.target = '_blank'; a.rel = 'noopener'; a.download = 'extrato.pdf';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  } catch { avisar('Não foi possível abrir o PDF agora'); }
}

// ---------- meus comprovantes ------------------------------------------------
// Tudo o que o formando anexou, num lugar só — é o que responde ao "mandei o
// comprovante e ninguém viu". Daqui também dá para mandar um novo.
// "Conferido" e "Não conferido" saíram em 25/09: o comprovante não passa por
// aprovação de ninguém — fica guardado, e o que resolve a parcela é a baixa.
// Enquanto ela não sai, o que o formando precisa saber é que está em análise.
const STATUS_COMPROVANTE = { em_analise: 'Em análise' };

async function telaComprovantes() {
  abrirFolha('<div class="vazio">Carregando…</div>');
  let r;
  try { r = await chamar('/comprovantes'); }
  catch { return abrirFolha('<div class="vazio">Não foi possível abrir seus comprovantes agora.</div>'); }

  // só faz sentido mandar comprovante do que tem boleto e ainda não baixou
  const cobrancas = (estado.financeiro?.boletos || [])
    .filter((b) => b.status === 'em_aberto' || b.status === 'em_atraso')
    .sort((a, b) => a.vencimento.localeCompare(b.vencimento));

  abrirFolha(`
    <h2>Meus <em>comprovantes</em></h2>
    <div class="sub">Tudo o que você anexou por aqui. O comprovante fica em análise até a equipe conferir e dar a baixa.</div>

    ${r.comprovantes.length ? `
      <div class="lista-comprovantes">
        ${r.comprovantes.map((c) => `
          <button class="comprovante" data-ver="${escapar(c.id)}" ${c.temArquivo ? '' : 'disabled'}>
            <span class="ico">${ICONES.anexo}</span>
            <span class="quando">
              <strong>${escapar(c.arquivo)}</strong>
              <span>${escapar(c.cobranca)} · enviado em ${dataCurta(c.enviadoEm.slice(0, 10))} · ${Math.max(1, Math.round(c.tamanho / 1024))} KB</span>
              ${c.protocolo ? `<br><span class="protocolo">${escapar(c.protocolo)}</span>` : ''}
            </span>
            <span class="marca-status s-em_aberto">${STATUS_COMPROVANTE[c.status] || 'Em análise'}</span>
          </button>`).join('')}
      </div>` : '<div class="cartao plano"><div class="vazio">Você ainda não enviou nenhum comprovante.</div></div>'}

    ${cobrancas.length ? `
      <div class="secao-titulo">Enviar um novo</div>
      <div class="campo">
        <label for="qual-cobranca">De qual cobrança</label>
        <select id="qual-cobranca">
          ${cobrancas.map((b) => `<option value="${escapar(b.id)}">${escapar(nomeCobranca(b))} · ${brl(devido(b))} · vence ${dataCurta(b.vencimento)}</option>`).join('')}
        </select>
      </div>
      <div class="acoes"><button class="botao" id="novo-comprovante">Anexar comprovante</button></div>` : ''}

    <div class="acoes dupla">
      <button class="botao secundario" id="voltar-extrato">Voltar ao extrato</button>
      <button class="botao fantasma" data-fechar-folha>Fechar</button>
    </div>
  `, (el) => {
    el.querySelector('#voltar-extrato').addEventListener('click', telaExtrato);
    el.querySelectorAll('[data-ver]').forEach((b) => b.addEventListener('click', () => verComprovante(b.dataset.ver)));
    el.querySelector('#novo-comprovante')?.addEventListener('click', async () => {
      const id = el.querySelector('#qual-cobranca').value;
      try { formularioComprovante(id, await chamar(`/financeiro/${id}`), null, 'comprovantes'); }
      catch { avisar('Não foi possível abrir esta cobrança'); }
    });
  });
}

// Imagem abre na própria folha; PDF abre numa aba nova.
async function verComprovante(id) {
  let c;
  try { c = await chamar(`/comprovantes/${id}`); }
  catch { return avisar('Não foi possível abrir o comprovante'); }
  if (!c.conteudo) return avisar('O arquivo deste comprovante não está disponível');

  if (c.tipo.startsWith('image/')) {
    return abrirFolha(`
      <h2>${escapar(c.arquivo)}</h2>
      <img class="previa-comprovante" style="max-height:66vh" src="${escapar(c.conteudo)}" alt="Comprovante enviado" />
      <div class="acoes dupla">
        <button class="botao secundario" id="voltar-comprovantes">Voltar aos comprovantes</button>
        <button class="botao fantasma" data-fechar-folha>Fechar</button>
      </div>
    `, (el) => el.querySelector('#voltar-comprovantes').addEventListener('click', telaComprovantes));
  }

  // data URL → blob, para o navegador abrir o PDF (ele não abre data: numa aba)
  const [cabeca, base64] = c.conteudo.split(',');
  const bytes = Uint8Array.from(atob(base64), (ch) => ch.charCodeAt(0));
  const url = URL.createObjectURL(new Blob([bytes], { type: cabeca.match(/data:([^;]+)/)?.[1] || c.tipo }));
  const a = document.createElement('a');
  a.href = url; a.target = '_blank'; a.rel = 'noopener';
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

// ---------- preciso de ajuda -------------------------------------------------
// Decisão da equipe (30/09/2026): em vez de mandar o formando para o WhatsApp,
// uma LISTA de motivos. Cada um vira demanda no CRM, com protocolo e
// responsável — a fila fica organizada e o financeiro para de receber o mesmo
// assunto por três caminhos diferentes.
//
// Os rótulos são o que o FORMANDO diria, não o nome do tipo no sistema: ele não
// pensa "renegociação", pensa "não estou conseguindo pagar". O tipo técnico vai
// junto, para a equipe filtrar a fila.
//
// "Outro motivo" existe porque nenhuma lista cobre tudo, e sem ela a pessoa
// desiste ou escolhe o item errado — que é pior, porque some da estatística.
const MOTIVOS_DE_AJUDA = [
  {
    tipo: 'renegociacao',
    titulo: 'Não estou conseguindo pagar',
    desc: 'Quero combinar uma forma de colocar em dia',
    exemplo: 'Conte a sua situação e o que consegue pagar por mês.',
  },
  {
    tipo: 'contestacao',
    titulo: 'Paguei e continua aparecendo em aberto',
    desc: 'A baixa não saiu',
    exemplo: 'Diga a parcela e a data em que pagou. Se tiver o comprovante, anexe na parcela.',
  },
  {
    tipo: 'pagamento_duplicado',
    titulo: 'Paguei a mesma parcela duas vezes',
    desc: 'Preciso de devolução',
    exemplo: 'Diga qual parcela e as duas datas de pagamento.',
  },
  {
    tipo: 'convites_extras',
    titulo: 'Quero convites extras',
    desc: 'Comprar convite além dos do pacote',
    exemplo: 'Diga quantos convites e de qual evento.',
  },
  {
    tipo: 'quitacao',
    titulo: 'Preciso da declaração de quitação',
    desc: 'Comprovante de que está tudo pago',
    exemplo: 'Se for para algum fim específico, conte qual.',
  },
  {
    tipo: 'dados_contato',
    titulo: 'Meus dados estão errados',
    desc: 'Nome, CPF ou algo do cadastro',
    exemplo: 'Diga o que está errado e qual é o certo. E-mail e telefone você mesmo corrige em "Meus dados".',
  },
  {
    tipo: 'outro',
    titulo: 'Outro motivo',
    desc: 'Conte o que você precisa',
    exemplo: 'Escreva com as suas palavras — quanto mais detalhe, mais rápido a equipe resolve.',
  },
];

async function telaAjuda() {
  abrirFolha(`
    <h2>Preciso de <em>ajuda</em></h2>
    <div class="sub">Escolha o assunto. A equipe recebe o seu pedido com um número de protocolo, e a
    resposta aparece aqui em <b>Meus pedidos</b>.</div>

    <div class="lista-antecipa">
      ${MOTIVOS_DE_AJUDA.map((m, i) => `
        <button class="opcao-antecipa" data-motivo="${i}">
          <div class="quando">
            <strong>${escapar(m.titulo)}</strong>
            <span>${escapar(m.desc)}</span>
          </div>
          <div class="quanto"><span class="seta">›</span></div>
        </button>`).join('')}
    </div>

    ${temRecurso('falarComEquipe') ? `<p class="rodape-nota">Prefere conversar? <button class="link-inline" id="ajuda-zap">Fale com a equipe no WhatsApp</button>.</p>` : ''}
    <div class="acoes"><button class="botao fantasma" data-fechar-folha>Fechar</button></div>
  `, (el) => {
    el.querySelector('#ajuda-zap')?.addEventListener('click', () => abrirWhatsapp());
    el.querySelectorAll('[data-motivo]').forEach((b) =>
      b.addEventListener('click', () => formularioAjuda(MOTIVOS_DE_AJUDA[Number(b.dataset.motivo)])));
  });
}

function formularioAjuda(motivo, erro) {
  abrirFolha(`
    <h2>${escapar(motivo.titulo)}</h2>
    <div class="sub">${escapar(motivo.exemplo)}</div>

    <div class="campo">
      <label for="ajuda-texto">O que você precisa${motivo.tipo === 'outro' ? '' : ' <small>(opcional)</small>'}</label>
      <textarea id="ajuda-texto" rows="5" placeholder="Escreva aqui"></textarea>
    </div>
    ${erro ? `<p class="erro">${escapar(erro)}</p>` : ''}

    <div class="acoes dupla">
      <button class="botao" id="enviar-ajuda">Enviar pedido</button>
      <button class="botao secundario" id="voltar-ajuda">Voltar</button>
    </div>
    <p class="rodape-nota">Você recebe um número de protocolo e acompanha a resposta em
    <b>Meus pedidos</b>.</p>
  `, (el) => {
    el.querySelector('#voltar-ajuda').addEventListener('click', telaAjuda);
    el.querySelector('#enviar-ajuda').addEventListener('click', async (e) => {
      const texto = el.querySelector('#ajuda-texto').value.trim();
      // Em "Outro motivo" o texto é a única informação que a equipe terá.
      if (motivo.tipo === 'outro' && texto.length < 5) {
        return formularioAjuda(motivo, 'Conte um pouco do que você precisa para a equipe poder ajudar.');
      }
      e.target.disabled = true; e.target.textContent = 'Enviando…';
      try {
        const r = await chamar('/solicitacoes', {
          method: 'POST',
          body: JSON.stringify({
            tipo: motivo.tipo,
            // O título vai junto: em "outro", é o que a fila mostra antes de
            // alguém abrir o pedido.
            mensagem: [motivo.titulo, texto].filter(Boolean).join(' — '),
          }),
        });
        folhaPedidoEnviado({
          titulo: 'Pedido <em>registrado</em>',
          sub: escapar(motivo.titulo),
          protocolo: r.protocolo,
        });
      } catch (err) {
        e.target.disabled = false; e.target.textContent = 'Enviar pedido';
        formularioAjuda(motivo, err.detalhe || 'Não foi possível enviar agora. Tente de novo.');
      }
    });
  });
}

// ---------- pedido de cancelamento -------------------------------------------
// Decisão do dono (05/10/2026): o portal TEM o pedido, mas sem chamar atenção —
// um link pequeno no fim de "Contrato e convites", fora do menu e fora da lista
// do "Preciso de ajuda". Quanto mais o formando vê a opção, mais ele pensa nela.
//
// O caminho tem duas paradas de propósito:
//   1. as multas do contrato, com a faixa em que ele está HOJE e a saída para
//      negociar o pagamento — "li, estou ciente" é o que libera o passo seguinte;
//   2. o motivo e as observações.
// O pedido vira demanda no CRM. Ele NÃO cancela nada: é a comunicação por
// escrito da cláusula 6.1, e a equipe formaliza o cancelamento num aditivo.

// Os mesmos motivos do CRM (formatura-cancelamento.regras) — a equipe filtra por eles.
const MOTIVOS_CANCELAMENTO = [
  'Financeiro',
  'Saiu do curso ou trocou de turma',
  'Mudança de cidade',
  'Insatisfação',
  'Divergências com a turma',
  'Outros',
];

async function telaCancelamentoAviso() {
  abrirFolha('<div class="vazio">Carregando…</div>');
  let c;
  try { c = await chamar('/cancelamento/condicoes'); }
  catch { return abrirFolha('<div class="vazio">Não foi possível abrir agora. Tente de novo em instantes.</div><div class="acoes"><button class="botao fantasma" data-fechar-folha>Fechar</button></div>'); }

  if (c.pedidoAberto) {
    return abrirFolha(`
      <h2>Pedido em <em>análise</em></h2>
      <div class="sub">Você já pediu o cancelamento em ${dataCurta(String(c.pedidoAberto.criadoEm).slice(0, 10))}. A equipe vai entrar em contato.</div>
      <div class="dado"><span>Protocolo</span><b>${escapar(c.pedidoAberto.protocolo)}</b></div>
      <div class="acoes"><button class="botao" data-fechar-folha>Entendi</button></div>`);
  }

  const e = c.escada;
  const faixas = [
    ['Mais de 360 dias antes da festa', `${e.mais360}%`, 'Mais de 360'],
    ['De 360 a 181 dias antes', `${e.de360a181}%`, 'De 360 a 181'],
    ['De 180 a 121 dias antes', `${e.de180a121}%`, 'De 180 a 121'],
    ['De 120 a 31 dias antes', `${e.de120a31}%`, 'De 120 a 31'],
    ['30 dias ou menos', 'valor integral', '30 dias ou menos'],
  ];
  const atual = (rotulo) => (c.faixa?.rotulo || '').startsWith(rotulo);
  const hoje = c.faixa?.pct == null
    ? 'A data da festa ainda não está definida: a equipe confirma a multa com você.'
    : c.faixa.integral
      ? `Faltam ${c.diasAteFesta} dias para a festa (${dataCurta(c.dataFesta)}). Nessa antecedência, o valor da adesão é devido por inteiro.`
      : `Faltam ${c.diasAteFesta} dias para a festa (${dataCurta(c.dataFesta)}). A multa prevista é de <b>${c.faixa.pct}% do valor total da adesão</b>.`;

  abrirFolha(`
    <h2>Antes de pedir o <em>cancelamento</em></h2>
    <div class="sub">O cancelamento segue as regras do seu Termo de Adesão. Leia com atenção.</div>

    <div class="secao-titulo">Multa por desistência ${clausula('6.2')}</div>
    <div class="cartao">
      ${faixas.map(([rot, val, chave]) => `
        <div class="dado${atual(chave) ? ' destaque-faixa' : ''}"><span>${rot}</span><b>${val}</b></div>`).join('')}
    </div>

    <div class="faixa info" style="margin-top:14px"><div>${hoje}</div></div>

    <div class="secao-titulo">Como funciona</div>
    <ul class="lista-simples">
      <li>Este pedido é a sua comunicação por escrito ${clausula('6.1')}. A data dele é a que conta para a multa.</li>
      <li>Os boletos continuam valendo até o cancelamento ser formalizado num termo aditivo, que a equipe envia para você assinar.</li>
    </ul>

    <div class="faixa" style="margin-top:14px">
      <div>O motivo é dificuldade para pagar? Dá para combinar uma forma de colocar em dia sem cancelar.
      <button class="link-inline" id="cancel-negociar">Quero negociar o pagamento</button></div>
    </div>

    <div class="acoes dupla">
      <button class="botao" data-fechar-folha>Voltar</button>
      <button class="botao secundario" id="cancel-ciente">Li, estou ciente e quero dar continuidade na solicitação</button>
    </div>
  `, (el) => {
    el.querySelector('#cancel-negociar').addEventListener('click', () =>
      formularioAjuda(MOTIVOS_DE_AJUDA.find((m) => m.tipo === 'renegociacao')));
    el.querySelector('#cancel-ciente').addEventListener('click', () => formularioCancelamento());
  });
}

function formularioCancelamento(erro, preenchido = {}) {
  abrirFolha(`
    <h2>Pedido de <em>cancelamento</em></h2>
    <div class="sub">Conte o motivo. A equipe recebe o pedido com um número de protocolo e entra em contato para
    conferir os valores com você.</div>

    <div class="campo">
      <label for="cancel-motivo">Motivo</label>
      <select id="cancel-motivo">
        <option value="">Escolha…</option>
        ${MOTIVOS_CANCELAMENTO.map((m) => `<option${preenchido.motivo === m ? ' selected' : ''}>${escapar(m)}</option>`).join('')}
      </select>
    </div>
    <div class="campo" id="cancel-outro" ${preenchido.motivo === 'Outros' ? '' : 'hidden'}>
      <label for="cancel-detalhe">Qual é o motivo?</label>
      <input id="cancel-detalhe" maxlength="300" value="${escapar(preenchido.motivoDetalhe || '')}" />
    </div>
    <div class="campo">
      <label for="cancel-obs">Observações <small>(opcional)</small></label>
      <textarea id="cancel-obs" rows="5" maxlength="2000" placeholder="Algo que a equipe precise saber">${escapar(preenchido.observacoes || '')}</textarea>
    </div>
    ${erro ? `<p class="erro">${escapar(erro)}</p>` : ''}

    <div class="acoes dupla">
      <button class="botao" id="cancel-enviar">Enviar pedido de cancelamento</button>
      <button class="botao secundario" id="cancel-voltar">Voltar</button>
    </div>
  `, (el) => {
    const motivo = el.querySelector('#cancel-motivo');
    motivo.addEventListener('change', () => { el.querySelector('#cancel-outro').hidden = motivo.value !== 'Outros'; });
    el.querySelector('#cancel-voltar').addEventListener('click', telaCancelamentoAviso);
    el.querySelector('#cancel-enviar').addEventListener('click', async (ev) => {
      const dados = {
        motivo: motivo.value,
        motivoDetalhe: el.querySelector('#cancel-detalhe').value.trim(),
        observacoes: el.querySelector('#cancel-obs').value.trim(),
      };
      if (!dados.motivo) return formularioCancelamento('Escolha o motivo.', dados);
      if (dados.motivo === 'Outros' && !dados.motivoDetalhe) return formularioCancelamento('Conte qual é o motivo.', dados);
      ev.target.disabled = true; ev.target.textContent = 'Enviando…';
      try {
        const r = await chamar('/solicitacoes', {
          method: 'POST',
          body: JSON.stringify({ tipo: 'cancelamento', payload: { ...dados, ciente: true } }),
        });
        folhaPedidoEnviado({
          titulo: 'Pedido de cancelamento <em>registrado</em>',
          sub: 'A equipe vai entrar em contato para conferir os valores e enviar o termo de cancelamento para você assinar.',
          protocolo: r.protocolo,
          nota: 'Até o cancelamento ser formalizado, os seus boletos continuam valendo.',
        });
      } catch (err) {
        formularioCancelamento(err.detalhe || 'Não foi possível enviar agora. Tente de novo.', dados);
      }
    });
  });
}

// ---------- meus pedidos -----------------------------------------------------
// Todo pedido tem protocolo, data e prazo. É o que responde ao "abri e ninguém
// me deu retorno".
const STATUS_PEDIDO = { aberta: 'Solicitação em aberto com a equipe', atendida: 'Resolvido', recusada: 'Não aprovado' };

async function telaMeusPedidos() {
  abrirFolha('<div class="vazio">Carregando…</div>');
  let r;
  try { r = await chamar('/solicitacoes'); }
  catch { return abrirFolha('<div class="vazio">Não foi possível abrir seus pedidos agora.</div>'); }

  abrirFolha(`
    <h2>Meus <em>pedidos</em></h2>
    <div class="sub">Tudo o que você pediu por aqui, com o número de protocolo de cada pedido.</div>

    ${r.solicitacoes.length ? `
      <div class="lista">
        ${r.solicitacoes.map((s) => `
          <div class="item inerte">
            <div class="quando">
              <strong>${escapar(s.rotulo || 'Pedido')}</strong>
              <span>${escapar(s.payload?.mensagem || '')}</span>
              <br><span class="protocolo">${escapar(s.protocolo || '')}</span>
              <span class="marca-status s-${s.status === 'aberta' ? 'em_aberto' : 'pago'}">${STATUS_PEDIDO[s.status] || escapar(s.status)}</span>
            </div>
            <div class="quanto">
              <b>${dataCurta(s.criadoEm.slice(0, 10))}</b>
            </div>
          </div>`).join('')}
      </div>` : '<div class="cartao plano"><div class="vazio">Você ainda não fez nenhum pedido.</div></div>'}

    <div class="acoes"><button class="botao fantasma" data-fechar-folha>Fechar</button></div>
  `);
}

// ---------- 2ª via de parcela vencida ----------------------------------------
// Boleto vencido o banco recusa. Decisão da equipe (22/09/2026): a 2ª via vence
// em 5 dias — sem escolha de data. O valor vem do servidor
// (/segunda-via/simular), com a mesma conta da emissão: o que aparece aqui é o
// valor do boleto.
function formularioSegundaVia(id, boleto, erro) {
  const venc = new Date(`${hoje()}T12:00:00`);
  venc.setDate(venc.getDate() + DIAS_SEGUNDA_VIA);
  const novoVencimento = venc.toISOString().slice(0, 10);
  const atraso = Math.abs(diasAte(boleto.vencimento));

  abrirFolha(`
    <h2>2ª via da <em>${escapar(nomeCobranca(boleto).toLowerCase())}</em></h2>
    <div class="sub">Venceu em ${dataCurta(boleto.vencimento)} · ${atraso} dia${atraso === 1 ? '' : 's'} de atraso</div>

    <div class="dado"><span>Valor da parcela</span><b>${brl(boleto.valor)}</b></div>
    <div class="dado"><span>Juros de mora <small id="p-dias"></small></span><b id="p-juros">…</b></div>
    <div class="dado"><span>Novo vencimento</span><b>${dataCurta(novoVencimento)} <small>(em ${DIAS_SEGUNDA_VIA} dias)</small></b></div>
    <div class="dado"><span>Valor da 2ª via</span><b${boleto.taxaBoleto ? '' : ' class="destaque-valor"'} id="p-total">calculando…</b></div>
    ${boleto.taxaBoleto ? `<div class="dado"><span>Taxa administrativa de gestão de conta</span><b>+ ${brl(boleto.taxaBoleto)}</b></div>
    <div class="dado"><span>Total do boleto</span><b class="destaque-valor" id="p-total-boleto">calculando…</b></div>` : ''}

    <div class="faixa info" style="margin-top:14px">
      <div>O valor da parcela é fixo. Depois do vencimento entram juros de mora de 1% ao mês,
      calculados por dia, até o novo vencimento ${clausula("4.3")}.</div>
    </div>
    ${erro ? `<p class="erro">${escapar(erro)}</p>` : ''}

    <div class="acoes dupla">
      <button class="botao" id="gerar-2via" disabled>Gerar 2ª via</button>
      <button class="botao secundario" id="voltar-boleto">Voltar</button>
    </div>
    <p class="rodape-nota">O juro corre por dia até o vencimento escolhido. Se você já pagou
    esta parcela, envie o comprovante em vez de gerar a 2ª via.</p>
  `, (el) => {
    const gerar = el.querySelector('#gerar-2via');
    chamar(`/financeiro/${id}/segunda-via/simular`, { method: 'POST', body: JSON.stringify({ novoVencimento }) })
      .then((e) => {
        if (!el.querySelector('#p-total')) return;   // a folha já mudou
        el.querySelector('#p-juros').textContent = `+ ${brl(e.juros)}`;
        el.querySelector('#p-dias').textContent = `(1% ao mês, ${e.diasAtraso} dias)`;
        el.querySelector('#p-total').textContent = brl(e.total);
        const totalBoleto = el.querySelector('#p-total-boleto');
        if (totalBoleto) totalBoleto.textContent = brl(arredondar(e.total + boleto.taxaBoleto));
        gerar.disabled = false;
      })
      .catch(() => { const t = el.querySelector('#p-total'); if (t) t.textContent = 'não foi possível calcular'; });

    el.querySelector('#voltar-boleto').addEventListener('click', () => abrirBoleto(id, { individual: true }));
    gerar.addEventListener('click', async () => {
      gerar.disabled = true; gerar.textContent = 'Gerando…';
      try {
        const r = await chamar(`/financeiro/${id}/segunda-via`, { method: 'POST', body: JSON.stringify({ novoVencimento }) });
        estado.financeiro = await chamar('/financeiro');
        abaFinanceiro();
        avisar('2ª via gerada');
        // No protótipo a parcela mantém o id; no CRM a 2ª via é uma cobrança
        // NOVA e a antiga sai da lista — abrir o id velho mostraria "não
        // encontrada" logo depois de dar certo.
        abrirBoleto(r?.novoBillId || id, { individual: true });
      } catch (err) {
        // Falta o endereço: em vez de mostrar o erro e deixar a pessoa parada,
        // abre o formulário e volta para cá quando ela terminar. O boleto NÃO
        // foi emitido — a parcela antiga continua de pé.
        if (codigoDoErro(err) === 'endereco_incompleto') {
          return telaEndereco({
            aviso: err.detalhe || err?.corpo?.message || 'Para emitir o boleto, falta o seu endereço.',
            depois: () => formularioSegundaVia(id, boleto),
          });
        }
        const mensagens = {
          nao_esta_vencida: 'Esta parcela não está vencida.',
          data_invalida: 'Não foi possível usar esta data.',
          data_longe: `A 2ª via vence em até ${DIAS_SEGUNDA_VIA} dias.`,
        };
        // `detalhe` é a frase que o CRM já manda pronta e explicando; os códigos
        // acima são do protótipo, que devolve erro em uma palavra.
        formularioSegundaVia(id, boleto, mensagens[err.message] || err.detalhe || 'Não foi possível gerar agora.');
      }
    });
  });
}

// ---------- contestar uma cobrança -------------------------------------------
function formularioContestacao(id, boleto) {
  const MOTIVOS = [
    'Já paguei esta parcela',
    'O valor está diferente do contratado',
    'Não reconheço esta cobrança',
    'Cancelei ou troquei de turma',
    'Outro motivo',
  ];
  abrirFolha(`
    <h2>Contestar <em>cobrança</em></h2>
    <div class="sub">${escapar(nomeCobranca(boleto))} · ${brl(devido(boleto))} · vence em ${dataCurta(boleto.vencimento)}</div>

    <div class="campo">
      <label for="motivo">Motivo</label>
      <select id="motivo">${MOTIVOS.map((m) => `<option>${escapar(m)}</option>`).join('')}</select>
    </div>
    <div class="campo">
      <label for="detalhe">Conte o que aconteceu</label>
      <textarea id="detalhe" placeholder="Quanto mais detalhe, mais rápido a equipe resolve"></textarea>
    </div>
    <div class="acoes dupla">
      <button class="botao" id="enviar-contestacao">Abrir contestação</button>
      <button class="botao secundario" id="voltar-boleto">Voltar</button>
    </div>
    <p class="rodape-nota">A cobrança fica registrada como contestada enquanto a equipe analisa.
    Se você tem comprovante de pagamento, anexe também — resolve mais rápido.</p>
  `, (el) => {
    el.querySelector('#voltar-boleto').addEventListener('click', () => abrirBoleto(id));
    el.querySelector('#enviar-contestacao').addEventListener('click', async (e) => {
      e.target.disabled = true; e.target.textContent = 'Enviando…';
      try {
        const r = await chamar('/solicitacoes', {
          method: 'POST',
          body: JSON.stringify({
            tipo: 'contestacao',
            billId: boleto.id,
            motivo: el.querySelector('#motivo').value,
            mensagem: `${nomeCobranca(boleto)} · ${el.querySelector('#motivo').value}. ${el.querySelector('#detalhe').value}`.trim(),
          }),
        });
        estado.financeiro = await chamar('/financeiro').catch(() => estado.financeiro);
        if (estado.aba === 'financeiro') abaFinanceiro();
        folhaPedidoEnviado({
          titulo: 'Contestação <em>registrada</em>',
          sub: `${escapar(nomeCobranca(boleto))} · ${brl(aPagar(boleto))}`,
          protocolo: r.protocolo,
          nota: 'A cobrança fica marcada como contestada até a equipe analisar.',
        });
      } catch (err) {
        if (err.message === 'contestacao_ja_aberta') { avisar('Você já tem uma contestação aberta para esta cobrança'); return abrirBoleto(id); }
        e.target.disabled = false; e.target.textContent = 'Abrir contestação';
        avisar('Não foi possível abrir a contestação agora');
      }
    });
  });
}

// ---------- negociação de débitos --------------------------------------------
// Decisão da equipe (22/09/2026): com mais de duas parcelas vencidas, a
// negociação é feita pela equipe. Por enquanto o formando abre o pedido e diz
// como prefere ser contatado; a autonomia para negociar sozinho vem depois.
// Até duas vencidas, ele resolve pela 2ª via ou pelo boleto único.

async function formularioNegociacao() {
  const vencidas = estado.financeiro.boletos
    .filter((b) => !b.unico && b.status === 'em_atraso')
    .sort((a, b) => a.parcela - b.parcela);
  if (!vencidas.length) return avisar('Você não tem parcelas vencidas');

  // pedido já aberto não vira pedido repetido
  abrirFolha('<div class="vazio">Carregando…</div>');
  const pedidos = await chamar('/solicitacoes').catch(() => ({ solicitacoes: [] }));
  const aberto = pedidos.solicitacoes.find((s) => s.tipo === 'renegociacao' && s.status === 'aberta');
  if (aberto) {
    return abrirFolha(`
      <h2>Negociação <em>em andamento</em></h2>
      <div class="sub">Seu pedido já está com a equipe.</div>
      <div class="dado"><span>Protocolo</span><b>${escapar(aberto.protocolo)}</b></div>
      <div class="dado"><span>Pedido em</span><b>${dataCurta(aberto.criadoEm.slice(0, 10))}</b></div>
      <div class="acoes dupla">
        <button class="botao secundario" id="ver-pedidos">Ver meus pedidos</button>
        <button class="botao fantasma" data-fechar-folha>Fechar</button>
      </div>
    `, (el) => el.querySelector('#ver-pedidos').addEventListener('click', telaMeusPedidos));
  }

  const total = Math.round(vencidas.reduce((a, b) => a + devido(b), 0) * 100) / 100;
  const taxa = estado.config?.contrato?.taxaReprogramacao ?? 75;

  abrirFolha(`
    <h2>Negociar <em>com a equipe</em></h2>
    <div class="sub">Com ${vencidas.length} parcelas vencidas, quem combina a forma de pagamento é a equipe.
    Deixe o pedido e alguém fala com você.</div>

    <div class="secao-titulo">Parcelas vencidas</div>
    ${vencidas.map((b) => `
      <div class="dado">
        <span>${escapar(nomeCobranca(b))} <small>(venceu em ${dataCurta(b.vencimento)})</small></span>
        <b>${brl(devido(b))}</b>
      </div>`).join('')}
    <div class="dado"><span>Total hoje, com os encargos de atraso</span><b class="destaque-valor">${brl(total)}</b></div>

    <div class="secao-titulo">Como falar com a equipe</div>
    <div class="campo">
      <label for="obs-negociacao">Quer contar algo? <small>(opcional)</small></label>
      <textarea id="obs-negociacao" placeholder="Quero negociar meus débitos, quais as opções de pagamento?"></textarea>
    </div>
    <p class="rodape-nota">O pedido abre uma conversa no seu WhatsApp, já endereçada ao Financeiro.</p>

    <p class="rodape-nota">Se a forma de pagamento for reprogramada, o termo prevê uma taxa fixa de
    ${brl(taxa)} ${clausula("17.3")}.</p>
    <div class="acoes dupla">
      <button class="botao" id="enviar-negociacao">Pedir contato da equipe</button>
      <button class="botao fantasma" data-fechar-folha>Cancelar</button>
    </div>
  `, (el) => {
    el.querySelector('#enviar-negociacao').addEventListener('click', async (e) => {
      e.target.disabled = true; e.target.textContent = 'Enviando…';
      const obs = el.querySelector('#obs-negociacao').value.trim();
      try {
        const s = await chamar('/solicitacoes', {
          method: 'POST',
          body: JSON.stringify({
            tipo: 'renegociacao',
            quantidade: vencidas.length,
            mensagem: `${vencidas.length} parcelas vencidas (${vencidas.map((b) => b.parcela).join(', ')}) · ${brl(total)} hoje.${obs ? ` ${obs}` : ''}`,
          }),
        });
        folhaPedidoEnviado({
          titulo: 'Pedido <em>registrado</em>',
          sub: `${vencidas.length} parcelas vencidas · ${brl(total)} hoje`,
          protocolo: s.protocolo,
          nota: 'Enquanto isso, a 2ª via de cada parcela continua disponível, se você quiser pagar alguma antes.',
        });
      } catch {
        e.target.disabled = false; e.target.textContent = 'Pedir contato da equipe';
        avisar('Não foi possível enviar agora');
      }
    });
  });
}

// ---------- comprovante de pagamento -----------------------------------------
// Anexar não dá baixa na parcela: ela continua como está até a equipe conferir.
const TIPOS_COMPROVANTE = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'];
const LIMITE_COMPROVANTE = 8 * 1024 * 1024;

// `origem` diz para onde voltar: o detalhe da parcela (padrão) ou a área de
// comprovantes.
function formularioComprovante(id, boleto, erro, origem) {
  const voltar = () => (origem === 'comprovantes' ? telaComprovantes() : abrirBoleto(id));
  abrirFolha(`
    <h2>Enviar <em>comprovante</em></h2>
    <div class="sub">${escapar(nomeCobranca(boleto))} · ${brl(devido(boleto))} · vence em ${dataCurta(boleto.vencimento)}</div>

    <div class="campo">
      <label for="arquivo">Comprovante</label>
      <input id="arquivo" type="file" accept="image/jpeg,image/png,image/webp,application/pdf" />
      <div class="dica">Foto ou PDF do comprovante, até 8 MB.</div>
    </div>
    <div id="previa"></div>
    <div class="campo">
      <label for="obs">Observação</label>
      <textarea id="obs" placeholder="Opcional — por exemplo: paguei no caixa eletrônico no dia 15"></textarea>
    </div>
    ${erro ? `<p class="erro">${escapar(erro)}</p>` : ''}
    <div class="acoes dupla">
      <button class="botao" id="enviar" disabled>Enviar</button>
      <button class="botao secundario" id="voltar-boleto">Voltar</button>
    </div>
    <p class="rodape-nota">A parcela continua em aberto até a equipe conferir o pagamento. Assim que
    a baixa sair, ela muda de situação sozinha.</p>
  `, (el) => {
    const campo = el.querySelector('#arquivo');
    const botao = el.querySelector('#enviar');
    const previa = el.querySelector('#previa');
    let escolhido = null;

    campo.addEventListener('change', () => {
      const f = campo.files?.[0];
      previa.innerHTML = '';
      escolhido = null;
      botao.disabled = true;
      if (!f) return;
      if (!TIPOS_COMPROVANTE.includes(f.type)) return avisar('Aceita foto (JPG, PNG, WebP) ou PDF');
      if (f.size > LIMITE_COMPROVANTE) return avisar('Arquivo maior que 8 MB');

      escolhido = f;
      botao.disabled = false;
      if (f.type.startsWith('image/')) {
        const url = URL.createObjectURL(f);
        previa.innerHTML = `<img class="previa-comprovante" src="${url}" alt="Prévia do comprovante" />`;
        previa.querySelector('img').addEventListener('load', () => URL.revokeObjectURL(url), { once: true });
      } else {
        previa.innerHTML = `<div class="previa-pdf">${ICONES.anexo}<span>${escapar(f.name)}</span></div>`;
      }
    });

    el.querySelector('#voltar-boleto').addEventListener('click', voltar);

    botao.addEventListener('click', async () => {
      if (!escolhido) return;
      botao.disabled = true; botao.textContent = 'Enviando…';
      try {
        const conteudo = await new Promise((resolve, reject) => {
          const leitor = new FileReader();
          leitor.onload = () => resolve(leitor.result);
          leitor.onerror = () => reject(leitor.error);
          leitor.readAsDataURL(escolhido);
        });
        await chamar(`/financeiro/${id}/comprovante`, {
          method: 'POST',
          body: JSON.stringify({
            arquivo: escolhido.name,
            tipo: escolhido.type,
            tamanho: escolhido.size,
            observacao: el.querySelector('#obs').value.trim(),
            conteudo,
          }),
        });
        avisar('Comprovante enviado. A equipe confere e dá a baixa.');
        // a lista atrás da folha ganha o selo "Comprovante enviado"
        estado.financeiro = await chamar('/financeiro').catch(() => estado.financeiro);
        if (estado.aba === 'financeiro') abaFinanceiro();
        voltar();
      } catch (err) {
        const mensagens = {
          tipo_nao_aceito: 'Aceita foto (JPG, PNG, WebP) ou PDF.',
          arquivo_grande: 'Arquivo maior que 8 MB.',
        };
        formularioComprovante(id, boleto, mensagens[err.message] || 'Não foi possível enviar agora.', origem);
      }
    });
  });
}

// ---------- endereço ---------------------------------------------------------
// O banco não mostra boleto de quem não tem endereço no cadastro. Quem assinou
// antes de o formulário de adesão pedir rua, número e CEP separados ficou só
// com o texto que digitou ("Casa", "Av Rocha Pombo", um e-mail no lugar do
// endereço) — e ninguém no escritório consegue adivinhar o que falta.
//
// Em vez de a equipe ligar para cada um, quem precisa emitir boleto informa
// aqui. O CEP preenche rua, bairro, cidade e estado: sobra o número, que é a
// única coisa que só a pessoa sabe.
const mascaraCep = (v) => {
  const d = v.replace(/\D/g, '').slice(0, 8);
  return d.length > 5 ? `${d.slice(0, 5)}-${d.slice(5)}` : d;
};

/** O código que o servidor manda quando o endereço é o que está travando. */
function codigoDoErro(err) {
  return err?.codigo || err?.corpo?.codigo || null;
}

/**
 * `depois` é para onde voltar quando o endereço ficar pronto — quem caiu aqui
 * no meio de uma 2ª via quer terminar a 2ª via, não ficar numa tela de cadastro.
 */
async function telaEndereco({ aviso, depois, erro, valores } = {}) {
  let e = valores;
  if (!e) {
    abrirFolha('<div class="vazio">Carregando…</div>');
    try {
      const p = await chamar('/perfil');
      e = p.endereco || {};
    } catch {
      return abrirFolha('<div class="vazio">Não foi possível abrir seu endereço agora.</div>');
    }
  }

  abrirFolha(`
    <h2>Seu <em>endereço</em></h2>
    <div class="sub">O banco pede o endereço do pagador para emitir o boleto. Ele não aparece
    no documento para mais ninguém.</div>

    ${aviso ? `<div class="faixa alerta" style="margin-bottom:16px"><div>${escapar(aviso)}</div></div>` : ''}

    <form id="form-endereco" novalidate>
      <div class="campo">
        <label for="cep">CEP</label>
        <input id="cep" inputmode="numeric" autocomplete="postal-code" placeholder="00000-000"
               value="${escapar(e.cep || '')}" />
        <div class="dica" id="dica-cep">Digite o CEP que a gente preenche o resto.</div>
      </div>
      <div class="campo">
        <label for="rua">Rua</label>
        <input id="rua" autocomplete="address-line1" value="${escapar(e.rua || '')}" />
      </div>
      <div class="campo">
        <label for="numero">Número</label>
        <input id="numero" autocomplete="address-line2" value="${escapar(e.numero || '')}" />
        <div class="dica">Se o seu endereço não tem número, escreva <b>s/n</b>.</div>
      </div>
      <div class="campo">
        <label for="complemento">Complemento <small>(opcional)</small></label>
        <input id="complemento" placeholder="Apto, bloco, fundos" value="${escapar(e.complemento || '')}" />
      </div>
      <div class="campo">
        <label for="bairro">Bairro</label>
        <input id="bairro" value="${escapar(e.bairro || '')}" />
      </div>
      <div class="campo">
        <label for="cidade">Cidade</label>
        <input id="cidade" autocomplete="address-level2" value="${escapar(e.cidade || '')}" />
      </div>
      <div class="campo">
        <label for="uf">Estado</label>
        <input id="uf" maxlength="2" autocomplete="address-level1" placeholder="SC"
               value="${escapar(e.uf || '')}" style="text-transform:uppercase" />
      </div>
      ${erro ? `<p class="erro">${escapar(erro)}</p>` : ''}
      <div class="acoes dupla">
        <button class="botao" type="submit">Salvar endereço</button>
        <button class="botao secundario" type="button" data-fechar-folha>Agora não</button>
      </div>
    </form>
  `, (el) => {
    const campo = (id) => el.querySelector(`#${id}`);
    const cep = campo('cep');
    const dica = el.querySelector('#dica-cep');

    cep.addEventListener('input', async () => {
      cep.value = mascaraCep(cep.value);
      const digitos = cep.value.replace(/\D/g, '');
      if (digitos.length !== 8) return;
      dica.textContent = 'Procurando…';
      try {
        // Consulta pública dos Correios (ViaCEP). Se estiver fora do ar, a
        // pessoa digita tudo à mão — por isso nada aqui bloqueia o formulário.
        const r = await fetch(`https://viacep.com.br/ws/${digitos}/json/`);
        const d = await r.json();
        if (d.erro) { dica.textContent = 'CEP não encontrado. Pode preencher à mão.'; return; }
        if (d.logradouro) campo('rua').value = d.logradouro;
        if (d.bairro) campo('bairro').value = d.bairro;
        if (d.localidade) campo('cidade').value = d.localidade;
        if (d.uf) campo('uf').value = d.uf;
        dica.textContent = 'Confira e diga o número.';
        campo('numero').focus();
      } catch {
        dica.textContent = 'Não conseguimos buscar agora. Pode preencher à mão.';
      }
    });

    el.querySelector('#form-endereco').addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const botao = el.querySelector('button[type=submit]');
      const digitados = {
        cep: campo('cep').value,
        rua: campo('rua').value.trim(),
        numero: campo('numero').value.trim(),
        complemento: campo('complemento').value.trim(),
        bairro: campo('bairro').value.trim(),
        cidade: campo('cidade').value.trim(),
        uf: campo('uf').value.trim().toUpperCase(),
      };
      botao.disabled = true; botao.textContent = 'Salvando…';
      try {
        await chamar('/perfil/endereco', { method: 'PATCH', body: JSON.stringify(digitados) });
        avisar('Endereço salvo');
        // Volta para o que a pessoa estava tentando fazer. Sem isto ela
        // precisaria achar de novo a parcela e recomeçar.
        if (depois) return depois();
        telaMeusDados();
      } catch (err) {
        botao.disabled = false; botao.textContent = 'Salvar endereço';
        // Mantém o que ela digitou: refazer o formulário inteiro por causa de
        // um campo é o tipo de coisa que faz desistir.
        telaEndereco({
          aviso,
          depois,
          valores: digitados,
          erro: err.detalhe || err?.corpo?.message || 'Não foi possível salvar agora. Tente de novo.',
        });
      }
    });
  });
}

// ---------- meus dados -------------------------------------------------------
// O formando confere o contato e pede correção. O valor só muda de verdade
// depois que a equipe confere — é por aqui que a gente conserta boleto que não
// chega porque o telefone ou o e-mail estão errados.
const mascaraTelefone = (v) => {
  const d = v.replace(/\D/g, '').replace(/^55/, '').slice(0, 11);
  if (d.length <= 2) return d;
  if (d.length <= 6) return `(${d.slice(0, 2)}) ${d.slice(2)}`;
  if (d.length <= 10) return `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}`;
  return `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}`;
};

async function telaMeusDados(erro) {
  abrirFolha('<div class="vazio">Carregando…</div>');
  let p;
  try { p = await chamar('/perfil'); }
  catch { return abrirFolha('<div class="vazio">Não foi possível abrir seus dados agora.</div>'); }

  const pendente = p.pendente;
  abrirFolha(`
    <h2>Meus <em>dados</em></h2>
    <div class="sub">Confira como a gente fala com você. O boleto e os avisos da turma vão para estes contatos.</div>

    <div class="dado"><span>Nome</span><b>${escapar(semMarca(p.nome))}</b></div>
    <div class="dado"><span>CPF</span><b>${escapar(p.cpf)}</b></div>
    <div class="dado"><span>Turma</span><b>${escapar(p.turma)}</b></div>

    ${pendente ? `
      <div class="faixa info" style="margin-top:16px">
        <div>
          <b>Pedido de correção em análise.</b>
          ${pendente.email ? `<br>Novo e-mail: ${escapar(pendente.email)}` : ''}
          ${pendente.telefone ? `<br>Novo telefone: ${escapar(mascaraTelefone(pendente.telefone))}` : ''}
          <br>Enviado em ${dataCurta(pendente.pedidoEm.slice(0, 10))} — até a equipe confirmar, valem os contatos atuais.
        </div>
      </div>` : ''}

    <div class="secao-titulo">Endereço</div>
    ${p.endereco?.completo
      ? `<div class="dado"><span>Onde você mora</span><b>${escapar([
          [p.endereco.rua, p.endereco.numero].filter(Boolean).join(', '),
          p.endereco.complemento,
          p.endereco.bairro,
          [p.endereco.cidade, p.endereco.uf].filter(Boolean).join('/'),
          p.endereco.cep,
        ].filter(Boolean).join(' · '))}</b></div>
         <p class="rodape-nota" style="margin:8px 0 12px">Mudou de casa?
         <button class="link-inline" id="editar-endereco">Atualizar endereço</button>.</p>`
      : `<div class="faixa alerta" style="margin-bottom:12px">
           <div><b>Falta o seu endereço.</b> O banco pede o endereço do pagador para emitir
           boleto, então sem ele a 2ª via não sai.
           <button class="link-inline" id="editar-endereco">Informar agora</button>.</div>
         </div>`}

    ${temRecurso('lembrete') ? `
    <div class="secao-titulo">Lembrete de vencimento</div>
    <p class="rodape-nota" style="margin:0 0 12px">
      ${p.lembreteDias
        // recebe: ou porque escolheu, ou porque vale o padrão da casa
        ? `Hoje você recebe o aviso <b>${p.lembreteDias} dia${p.lembreteDias > 1 ? 's' : ''} antes</b> de cada vencimento, por e-mail.${p.lembreteEscolhido ? '' : ' É o padrão — dá para mudar aqui.'}`
        // A tela não oferece desligar: o aviso de vencimento faz parte do
        // acompanhamento da parcela. Quem pedir à equipe fica com 0 no
        // cadastro, e é este o caso que cai aqui — pode religar escolhendo.
        : 'O aviso de vencimento está desligado no seu cadastro. Para voltar a recebê-lo, escolha quando.'}
    </p>
    <div class="filtros" id="lembretes">
      ${[1, 3, 5, 7].map((d) => `<button data-lembrete="${d}" class="${p.lembreteDias === d ? 'ativo' : ''}">${d} dia${d > 1 ? 's' : ''} antes</button>`).join('')}
    </div>
    <div class="acoes" style="margin:12px 0 4px">
      <button class="botao secundario" id="salvar-lembrete" disabled>Salvar</button>
    </div>` : ''}

    <div class="secao-titulo">Contato</div>
    <form id="form-contato" novalidate>
      <div class="campo">
        <label for="email">E-mail</label>
        <input id="email" type="email" inputmode="email" autocomplete="email" value="${escapar(p.email || '')}" />
      </div>
      <div class="campo">
        <label for="telefone">Celular com WhatsApp</label>
        <input id="telefone" inputmode="tel" autocomplete="tel" value="${escapar(mascaraTelefone(p.telefone || ''))}" />
        <div class="dica">É para onde vai o código de acesso; o aviso de vencimento vai por e-mail.</div>
      </div>
      ${erro ? `<p class="erro">${escapar(erro)}</p>` : ''}
      <div class="acoes dupla">
        <button class="botao" type="submit">Pedir correção</button>
        <button class="botao secundario" type="button" data-fechar-folha>Fechar</button>
      </div>
    </form>
    <p class="rodape-nota">A mudança de contato é conferida pela equipe antes de valer — assim
    ninguém troca o contato de outra pessoa por engano.</p>
  `, (el) => {
    // ESCOLHER E SALVAR SÃO DOIS PASSOS. O clique só marca; nada vai para o
    // servidor antes do Salvar — assim um toque errado na lista não muda, em
    // silêncio, quando a pessoa é avisada do vencimento.
    const salvarLembrete = el.querySelector('#salvar-lembrete');
    if (salvarLembrete) {
      // O que está valendo hoje; se ele voltar para cá, não há o que salvar.
      const atual = p.lembreteDias || 0;
      let escolhido = atual;

      const marcar = () => {
        el.querySelectorAll('[data-lembrete]').forEach((b) =>
          b.classList.toggle('ativo', Number(b.dataset.lembrete) === escolhido));
        salvarLembrete.disabled = escolhido === atual;
      };

      el.querySelectorAll('[data-lembrete]').forEach((b) => b.addEventListener('click', () => {
        escolhido = Number(b.dataset.lembrete);
        marcar();
      }));

      salvarLembrete.addEventListener('click', async () => {
        if (escolhido === atual) return;
        salvarLembrete.disabled = true;
        try {
          await chamar('/perfil/lembrete', { method: 'POST', body: JSON.stringify({ dias: escolhido }) });
          avisar(`Combinado: aviso ${escolhido} dia${escolhido > 1 ? 's' : ''} antes`);
          telaMeusDados();
        } catch {
          // Devolve o botão: a escolha dele continua na tela, e dá para tentar de novo.
          salvarLembrete.disabled = false;
          avisar('Não foi possível salvar agora');
        }
      });
    }
    el.querySelector('#editar-endereco')?.addEventListener('click', () => telaEndereco());
    const tel = el.querySelector('#telefone');
    tel.addEventListener('input', () => { tel.value = mascaraTelefone(tel.value); });

    el.querySelector('#form-contato').addEventListener('submit', async (e) => {
      e.preventDefault();
      const botao = el.querySelector('button[type=submit]');
      botao.disabled = true; botao.textContent = 'Enviando…';
      try {
        await chamar('/perfil/contato', {
          method: 'POST',
          body: JSON.stringify({
            email: el.querySelector('#email').value.trim(),
            telefone: `55${tel.value.replace(/\D/g, '')}`,
          }),
        });
        avisar('Pedido enviado. A equipe confirma e avisa você.');
        telaMeusDados();
      } catch (err) {
        const mensagens = {
          email_invalido: 'Esse e-mail não parece válido.',
          telefone_invalido: 'Digite o celular com DDD.',
          nada_mudou: 'Os dados estão iguais aos que já temos.',
        };
        telaMeusDados(mensagens[err.message] || 'Não foi possível enviar agora.');
      }
    });
  });
}

// ---------- aba: cronograma --------------------------------------------------
const TIPO_ETAPA = {
  evento: 'Evento', reuniao: 'Reunião', prazo: 'Prazo', marco: 'Marco', baile: 'O grande dia',
};

// Cada etapa ganha um símbolo, no mesmo traço fino do símbolo do curso. A busca é
// pelo nome da etapa; sem correspondência, vale o desenho do tipo (reunião,
// prazo, evento…).
const SIMBOLOS_ETAPA = [
  // assinatura do termo: caneta sobre o papel
  { re: /assinatura|termo|contrato/i, svg: '<path d="M6 3.5h7l4 4v13H6Z"/><path d="M13 3.8V7.5h3.7"/><path d="m9 16.5 5.4-5.4 1.6 1.6-5.4 5.4-2 .4Z"/>' },
  // reunião de comissão: pessoas à mesa
  { re: /reuni[aã]o|comiss[aã]o|alinhamento/i, svg: '<circle cx="9" cy="8.5" r="2.4"/><circle cx="16" cy="9.5" r="2"/><path d="M4.5 17c0-2.5 2-4.2 4.5-4.2s4.5 1.7 4.5 4.2"/><path d="M15 12.9c2.2.1 3.8 1.7 3.8 4.1"/><path d="M3 20.5h18"/>' },
  // cardápio e degustação: talheres
  { re: /card[aá]pio|degusta|jantar|buffet/i, svg: '<path d="M7 3.5v7a2 2 0 0 0 4 0v-7M9 10.5v10"/><path d="M16.5 3.5c-1.5 1.6-2 3.2-2 5.2 0 1.6.8 2.6 2 2.8v9"/>' },
  // decoração: flor
  { re: /decora|cen[aá]rio|flores/i, svg: '<path d="M12 12.5c-3.2 0-4.8-2.7-4.8-6 1.8.7 2.9 1.8 3.3 2.9.3-1.8 1-3.2 1.5-4 .5.8 1.2 2.2 1.5 4 .4-1.1 1.5-2.2 3.3-2.9 0 3.3-1.6 6-4.8 6Z"/><path d="M12 12.5V21"/>' },
  // family day: família
  { re: /family|fam[ií]lia/i, svg: '<circle cx="8" cy="7.5" r="2.2"/><circle cx="16" cy="7.5" r="2.2"/><path d="M4 16.5c0-2.4 1.8-4 4-4s4 1.6 4 4M12 16.5c0-2.4 1.8-4 4-4s4 1.6 4 4"/><path d="M12 19.5c-1.6 0-2.4-1-2.4-2.2M12 19.5c1.6 0 2.4-1 2.4-2.2"/>' },
  // prazo de convites: envelope
  { re: /convite|nomes/i, svg: '<rect x="3.5" y="5.5" width="17" height="13" rx="2"/><path d="m4 7 8 6 8-6"/>' },
  // traje: gravata-borboleta
  { re: /traje|vestido|terno/i, svg: '<path d="M10.5 9.5 4 6.5v11l6.5-3Z"/><path d="M13.5 9.5 20 6.5v11l-6.5-3Z"/><rect x="10.3" y="9.3" width="3.4" height="5.4" rx="1"/>' },
  // ensaio fotográfico: câmera
  { re: /ensaio|foto|book/i, svg: '<rect x="3" y="7" width="18" height="12.5" rx="2.5"/><path d="M8.5 7 10 4.5h4L15.5 7"/><circle cx="12" cy="13.2" r="3.3"/>' },
  // parcela: nota
  { re: /parcela|pagamento|financeiro/i, svg: '<rect x="2.5" y="6" width="19" height="12" rx="2.5"/><circle cx="12" cy="12" r="2.6"/><path d="M6 12h.01M18 12h.01"/>' },
  // culto: vela acesa
  { re: /culto|ecum[eê]nico|missa/i, svg: '<path d="M12 2.8c1.6 1.6 2.4 2.8 2.4 4a2.4 2.4 0 0 1-4.8 0c0-1.2.8-2.4 2.4-4Z"/><path d="M8.5 10.5h7v10h-7Z"/><path d="M12 10.5v10"/>' },
  // colação de grau: capelo
  { re: /cola[cç][aã]o|grau|diploma/i, svg: '<path d="M12 3.5 22 8l-10 4.5L2 8l10-4.5Z"/><path d="M6.5 10.2V15c0 1.5 2.5 2.7 5.5 2.7s5.5-1.2 5.5-2.7v-4.8"/><path d="M22 8v5.5"/>' },
  // baile: taças de brinde
  { re: /baile|gala|festa|brinde/i, svg: '<path d="M5 3.5h5l-1 6a1.6 1.6 0 0 1-3 0Z"/><path d="M7.5 9.5V20M5.5 20.5h4"/><path d="M14 3.5h5l-1 6a1.6 1.6 0 0 1-3 0Z"/><path d="M16.5 9.5V20M14.5 20.5h4"/>' },
];

const SIMBOLO_POR_TIPO = {
  reuniao: '<circle cx="9" cy="8.5" r="2.4"/><circle cx="16" cy="9.5" r="2"/><path d="M4.5 17c0-2.5 2-4.2 4.5-4.2s4.5 1.7 4.5 4.2"/><path d="M15 12.9c2.2.1 3.8 1.7 3.8 4.1"/>',
  prazo: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7v5.3l3.4 2"/>',
  evento: '<rect x="3.5" y="5" width="17" height="15.5" rx="2.5"/><path d="M3.5 10h17M8 3v4M16 3v4"/>',
  marco: '<path d="M6 3.5v17"/><path d="M6 4.5h11l-2 3.5 2 3.5H6Z"/>',
  baile: '<path d="M5 3.5h5l-1 6a1.6 1.6 0 0 1-3 0Z"/><path d="M7.5 9.5V20M5.5 20.5h4"/><path d="M14 3.5h5l-1 6a1.6 1.6 0 0 1-3 0Z"/><path d="M16.5 9.5V20M14.5 20.5h4"/>',
};

const simboloDaEtapa = (e) =>
  (SIMBOLOS_ETAPA.find((s) => s.re.test(e.etapa || '')) || {}).svg
  || SIMBOLO_POR_TIPO[e.tipo]
  || SIMBOLO_POR_TIPO.marco;

function abaCronograma() {
  const t = estado.turma;
  const etapas = [...t.cronograma].sort((a, b) => a.data.localeCompare(b.data));
  const proxima = etapas.find((e) => e.data >= hoje());
  const feitas = etapas.filter((e) => e.data < hoje()).length;

  // Agrupa por ano, para a lista longa não virar um paredão.
  const anos = [...new Set(etapas.map((e) => e.data.slice(0, 4)))];

  const quando = (iso) => {
    const d = diasAte(iso);
    if (d < 0) return `há ${Math.abs(d)} dia${Math.abs(d) === 1 ? '' : 's'}`;
    if (d === 0) return 'hoje';
    if (d === 1) return 'amanhã';
    if (d < 60) return `em ${d} dias`;
    const meses = Math.round(d / 30);
    return `em ${meses} meses`;
  };

  // Turma nova não tem data nenhuma marcada ainda. Dizer "0 etapas até a
  // formatura" soa como erro do sistema; dizer que as datas vêm depois é o que
  // está acontecendo de verdade.
  if (!etapas.length) {
    return moldura(`
      <div class="cartao">
        <div class="kicker traco">Da adesão ao baile</div>
        <h2 class="serif" style="margin:8px 0 4px;font-size:30px">As datas ainda estão sendo <em>fechadas</em></h2>
        <p style="margin:0;color:var(--texto-suave);font-size:13.5px">
          A equipe confirma cada etapa junto com a comissão da turma. Assim que uma data fecha, ela
          aparece aqui — e você recebe o aviso.
        </p>
        <div class="contagem" style="margin-top:16px">
          <div><b>${diasAte(t.dataEvento)}</b><span>dias para o baile</span></div>
        </div>
      </div>
      ${notaRodape()}
    `, 'as datas vêm da comissão');
  }

  moldura(`
    <div class="cartao">
      <div class="kicker traco">Da adesão ao baile</div>
      <h2 class="serif" style="margin:8px 0 4px;font-size:30px">${etapas.length} etapas até a <em>formatura</em></h2>
      <p style="margin:0;color:var(--texto-suave);font-size:13.5px">
        ${feitas} já ${feitas === 1 ? 'aconteceu' : 'aconteceram'} · ${etapas.length - feitas} pela frente
        ${proxima ? ` · a próxima é <b>${escapar(proxima.etapa)}</b>, ${quando(proxima.data)}` : ''}
      </p>
      <div class="contagem">
        <div><b>${diasAte(t.dataEvento)}</b><span>dias para o baile</span></div>
        <div><b>${feitas}/${etapas.length}</b><span>etapas cumpridas</span></div>
        <div><b>${anos.length}</b><span>anos de jornada</span></div>
      </div>
    </div>

    ${anos.map((ano) => `
      <div class="crono-ano"><span>${ano}</span><i></i></div>
      <div class="crono-lista">
      ${etapas.filter((e) => e.data.startsWith(ano)).map((e) => {
        const passou = e.data < hoje();
        const eh = e === proxima;
        const d = new Date(`${e.data}T12:00:00`);
        return `
          <div class="crono-item ${passou ? 'passado' : ''} ${eh ? 'proximo' : ''}">
            <div class="crono-data">
              <b>${String(d.getDate()).padStart(2, '0')}</b>
              <span>${d.toLocaleDateString('pt-BR', { month: 'short' }).replace('.', '')}</span>
              <span class="crono-simbolo" aria-hidden="true">
                <svg viewBox="0 0 24 24">${simboloDaEtapa(e)}</svg>
              </span>
            </div>
            <div class="crono-corpo">
              <h3>${escapar(e.etapa)}</h3>
              <p>${escapar(e.local || '')}${e.observacao ? `${e.local ? ' — ' : ''}${escapar(e.observacao)}` : ''}</p>
              <div class="crono-tags">
                <span class="crono-tag t-${e.tipo || 'marco'}">${TIPO_ETAPA[e.tipo] || 'Etapa'}</span>
                <span class="crono-quando">${passou ? 'já aconteceu' : quando(e.data)}${e.hora ? ` · ${escapar(e.hora)}` : ''}</span>
                ${eh ? '<span class="crono-tag t-baile">Próxima</span>' : ''}
              </div>
              ${passou ? '' : acoesDaEtapa(e)}
            </div>
          </div>`;
      }).join('')}
      </div>
    `).join('')}

    <p class="rodape-nota">As datas são confirmadas pela equipe e pela comissão da turma. Quando algo mudar, o aviso aparece aqui e em Minha turma.</p>
    ${notaRodape()}
  `, `${feitas} de ${etapas.length} etapas cumpridas`);

  ligarEtapas(etapas);
}

// Cada etapa que ainda vai acontecer leva o que a pessoa precisa fazer com ela:
// salvar no calendário, achar o endereço e dizer se vai.
function acoesDaEtapa(e) {
  const mapa = e.endereco ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(e.endereco)}` : null;
  return `
    <div class="crono-acoes">
      <button data-ics="${escapar(e.chave || e.data)}">${ICONES.calendario}<span>Salvar no calendário</span></button>
      ${mapa ? `<a href="${mapa}" target="_blank" rel="noopener">${ICONES.mapa}<span>Como chegar</span></a>` : ''}
      ${e.confirmar ? `
        <button data-presenca="sim" data-etapa="${escapar(e.chave)}" class="${e.presenca === 'sim' ? 'ativo' : ''}">${ICONES.check}<span>${e.presenca === 'sim' ? 'Você confirmou' : 'Vou'}</span></button>
        <button data-presenca="nao" data-etapa="${escapar(e.chave)}" class="${e.presenca === 'nao' ? 'ativo' : ''}"><span>${e.presenca === 'nao' ? 'Você não vai' : 'Não vou'}</span></button>` : ''}
    </div>`;
}

// Arquivo .ics: o calendário do celular e o Google Agenda abrem direto.
function baixarIcs(etapa, turma) {
  const limpo = (s) => String(s || '').replace(/[\r\n]+/g, ' ').replace(/([,;\\])/g, '\\$1');
  const semTraco = etapa.data.replace(/-/g, '');
  const diaSeguinte = new Date(`${etapa.data}T12:00:00`);
  diaSeguinte.setDate(diaSeguinte.getDate() + 1);
  const fim = diaSeguinte.toISOString().slice(0, 10).replace(/-/g, '');
  const carimbo = `${new Date().toISOString().replace(/[-:]/g, '').slice(0, 15)}Z`;

  const quandoInicio = etapa.hora
    ? `DTSTART:${semTraco}T${etapa.hora.replace(':', '')}00`
    : `DTSTART;VALUE=DATE:${semTraco}`;
  const quandoFim = etapa.hora
    ? `DTEND:${semTraco}T${String(Number(etapa.hora.slice(0, 2)) + 3).padStart(2, '0')}${etapa.hora.slice(3, 5)}00`
    : `DTEND;VALUE=DATE:${fim}`;

  const linhas = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Indaia Eventos//Area do Formando//PT-BR',
    'BEGIN:VEVENT',
    `UID:${semTraco}-${Math.random().toString(36).slice(2)}@areadoformando`,
    `DTSTAMP:${carimbo}`, quandoInicio, quandoFim,
    `SUMMARY:${limpo(etapa.etapa)} · ${limpo(turma)}`,
    etapa.endereco ? `LOCATION:${limpo(etapa.endereco)}` : (etapa.local ? `LOCATION:${limpo(etapa.local)}` : ''),
    `DESCRIPTION:${limpo(etapa.observacao || 'Etapa da sua formatura')}`,
    'END:VEVENT', 'END:VCALENDAR',
  ].filter(Boolean);

  const blob = new Blob([linhas.join('\r\n')], { type: 'text/calendar;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${etapa.etapa.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\w]+/g, '-').toLowerCase()}.ics`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 20000);
  avisar('Evento salvo — abra o arquivo para adicionar ao calendário');
}

function ligarEtapas(etapas) {
  const achar = (chave) => etapas.find((e) => (e.chave || e.data) === chave);
  app.querySelectorAll('[data-ics]').forEach((b) => b.addEventListener('click', () => {
    const e = achar(b.dataset.ics);
    if (e) baixarIcs(e, estado.turma?.rotulo || '');
  }));
  app.querySelectorAll('[data-presenca]').forEach((b) => b.addEventListener('click', async () => {
    b.disabled = true;
    try {
      await chamar('/turma/presenca', {
        method: 'POST',
        body: JSON.stringify({ chave: b.dataset.etapa, resposta: b.dataset.presenca }),
      });
      estado.turma = await chamar('/turma');
      abaCronograma();
      avisar(b.dataset.presenca === 'sim' ? 'Presença confirmada' : 'Anotado: você não vai');
    } catch { b.disabled = false; avisar('Não foi possível registrar agora'); }
  }));
}

// ---------- aba: contrato e convites ----------------------------------------
function abaContrato() {
  const c = estado.contrato;
  moldura(`
    <div class="secao-titulo">Meus documentos</div>
    <div class="lista">
      <button class="item" data-doc="termo">
        <div class="quando">
          <strong>Termo de adesão</strong>
          <span>Assinado em ${dataCurta(c.termo.assinadoEm)} · ${c.termo.origem === 'docuseal' ? 'assinatura digital' : 'documento anexado'}</span>
        </div>
        <div class="seta">›</div>
      </button>
      <button class="item" data-doc="coletivo">
        <div class="quando">
          <strong>Contrato coletivo da turma</strong>
          <span>${escapar(c.contratoColetivo.turma)}</span>
        </div>
        <div class="seta">›</div>
      </button>
    </div>

    <div class="secao-titulo">O que você contratou</div>
    <div class="cartao">
      <div class="dado"><span>Valor total</span><b>${brl(c.contratado.total)}</b></div>
      <div class="dado"><span>Parcelas</span><b>${c.contratado.parcelas}× de ${brl(c.contratado.mensalidade)}</b></div>
      <div class="dado"><span>Primeira parcela</span><b>${dataCurta(c.contratado.primeiraParcela)}</b></div>
      ${c.taxaBoleto ? `<div class="dado"><span>Taxa administrativa de gestão de conta <small>(em cada boleto)</small></span><b>${brl(c.taxaBoleto)}</b></div>` : ''}
      <div class="dado"><span>Se a parcela atrasar ${clausula("4.3")}</span><b>juros de 1% ao mês</b></div>
    </div>

    <div class="secao-titulo">Seus convites</div>
    ${blocoDasCompras(c.compras)}
    <div class="cartao">
      ${c.convites.map((cv) => {
        const pct = cv.quantidade ? Math.min(100, (cv.nomeados || 0) / cv.quantidade * 100) : 0;
        return `
          <div class="convite-linha">
            <div class="convite-topo">
              <span>${escapar(cv.tipo)}${cv.quantidade > cv.incluso ? ` <small>(${cv.incluso} no pacote + ${cv.quantidade - cv.incluso} extra)</small>` : ''}</span>
              <b>${cv.quantidade}${cv.valorUnitario ? ` · ${brl(cv.valorUnitario)}` : ' · incluso'}</b>
            </div>
            ${/* A barra é de convidados NOMEADOS, que só existe onde há lista
                  de nomes. No CRM não há onde cadastrar isso, e aí a linha vem
                  com `nomeados: null` — mostrar "0 de 3 nomeados" seria inventar
                  uma pendência que o formando não tem como resolver. */ ''}
            ${cv.nomeados == null ? '' : `
              <div class="convite-barra"><i style="width:${pct.toFixed(0)}%"></i></div>
              <small>${cv.nomeados} de ${cv.quantidade} com nome na lista${cv.nomeados < cv.quantidade ? ' — faltam nomear' : ' ✓'}</small>`}
          </div>`;
      }).join('')}
      <div class="acoes">
        <button class="botao secundario" id="nomear">Dizer quem vai usar</button>
        <button class="botao secundario" id="pedir">Comprar convites extras</button>
      </div>
    </div>

    ${/* Festa que já passou do prazo de compra: fica aqui, fora da hora de
          escolher, só para ele entender por que ela não aparece lá. */ ''}
    ${(c.festasEncerradas || []).length ? `
      <p class="rodape-nota">
        Sem venda de convite agora: ${c.festasEncerradas.map((f) => `<b>${escapar(f.rotulo)}</b> (${escapar(f.motivo || 'indisponível')})`).join(' · ')}
      </p>` : ''}

    ${(() => {
      // Aqui só cabem os pedidos que mexem no contrato; o resto mora em Meus pedidos.
      const doContrato = (c.solicitacoes || []).filter((s) => ['convites_extras', 'antecipacao', 'quitacao'].includes(s.tipo));
      if (!doContrato.length) return '';
      return `
        <div class="secao-titulo">Seus pedidos de convite</div>
        <div class="lista">
          ${doContrato.map((s) => `
            <div class="item inerte">
              <div class="quando">
                <strong>${escapar(s.rotulo || 'Pedido para a equipe')}</strong>
                <span>${escapar(s.payload.mensagem || '')}</span>
                <br><span class="protocolo">${escapar(s.protocolo || '')}</span>
                <span class="marca-status s-em_aberto">${STATUS_PEDIDO[s.status] || escapar(s.status)}</span>
              </div>
            </div>`).join('')}
        </div>
        <p class="rodape-nota">Pedidos de convite não viram cobrança sozinhos: a equipe confere e faz o aditivo com você.</p>`;
    })()}

    ${notaRodape()}

    <div class="pe-discreto">
      <button class="link-discreto" id="pedir-cancelamento">Solicitar cancelamento da adesão</button>
    </div>
  `);

  app.querySelector('#pedir-cancelamento')?.addEventListener('click', telaCancelamentoAviso);
  app.querySelectorAll('[data-doc]').forEach((b) => b.addEventListener('click', () => {
    if (b.dataset.doc !== 'termo') return avisar('No ambiente real, abre o PDF por link assinado de curta duração');
    if (estado.config?.demo) return avisar('No app de verdade, abre o termo assinado em PDF');
    baixarArquivo('/contrato/termo/pdf', 'termo-de-adesao.pdf');
  }));
  app.querySelector('#pedir')?.addEventListener('click', telaConvites);
  app.querySelector('#nomear')?.addEventListener('click', telaNomearConvidados);
}

/**
 * QUEM VAI USAR CADA CONVITE (15/10/2026).
 *
 * A portaria precisa da lista pronta antes do dia, e a operação imprime com
 * antecedência: por isso a lista FECHA 15 DIAS ANTES de cada festa. Depois
 * disso ele não mexe mais — não é punição, é que a lista já saiu da mão dele.
 *
 * Um campo por convite, não um botão de "adicionar": ele sabe quantos tem, e
 * ver os campos vazios é o que lembra de preencher. Dá para salvar pela
 * metade e voltar depois — linha em branco simplesmente não entra.
 */
async function telaNomearConvidados() {
  abrirFolha('<div class="vazio">Carregando…</div>');
  let festas;
  try { festas = await chamar('/convites/nomes'); }
  catch { return abrirFolha('<div class="vazio">Não foi possível abrir seus convites agora.</div>'); }

  if (!Array.isArray(festas) || !festas.length) {
    return abrirFolha(`
      <h2>Quem vai <em>usar</em></h2>
      <div class="vazio">Você ainda não tem convites. Quando tiver, é aqui que você diz quem entra com cada um.</div>`);
  }

  // Rascunho por festa: o que está na tela, antes de salvar.
  const rascunho = {};
  for (const f of festas) {
    rascunho[f.festa] = Array.from({ length: f.convites }, (_, i) => ({
      nome: f.nomes[i]?.nome || '',
      documento: f.nomes[i]?.documento || '',
      telefone: f.nomes[i]?.telefone || '',
      observacao: f.nomes[i]?.observacao || '',
    }));
  }

  const desenhar = () => {
    abrirFolha(`
      <h2>Quem vai <em>usar</em></h2>
      <div class="sub">Diga o nome de quem entra com cada convite seu. A portaria confere por essa lista.</div>

      ${festas.map((f) => {
        const linhas = rascunho[f.festa];
        const preenchidos = linhas.filter((l) => l.nome.trim()).length;
        return `
        <div class="convite-item" data-festa="${f.festa}">
          <div class="convite-cab">
            <div>
              <b>${escapar(f.rotulo)}</b>
              <span class="convite-sub">
                ${f.data ? `festa em ${dataCurta(f.data)}` : 'data a definir'} ·
                ${preenchidos} de ${f.convites} ${f.convites === 1 ? 'convite' : 'convites'} com nome
              </span>
            </div>
          </div>

          ${!f.janela.aberta ? `
            <div class="faixa alerta"><div>${escapar(f.janela.motivo || 'A lista desta festa já fechou.')}</div></div>
            ${linhas.filter((l) => l.nome.trim()).map((l) => `
              <div class="dado"><span>${escapar(l.nome)}</span><b>${escapar(l.documento || '')}</b></div>`).join('')
              || '<p class="rodape-nota">Nenhum nome foi informado nesta festa.</p>'}`
          : `
            ${f.janela.fechaEm ? `
              <p class="rodape-nota" style="margin:0 0 10px">
                Você pode mudar esta lista até <b>${dataCurta(f.janela.fechaEm)}</b>${f.janela.diasParaFechar != null && f.janela.diasParaFechar <= 7 ? ` — faltam ${f.janela.diasParaFechar} ${f.janela.diasParaFechar === 1 ? 'dia' : 'dias'}` : ''}.
              </p>` : ''}
            ${linhas.map((l, i) => `
              <div class="nome-convidado">
                <span class="nome-n">${i + 1}</span>
                <input type="text" placeholder="Nome completo do convidado" value="${escapar(l.nome)}"
                       data-festa="${f.festa}" data-i="${i}" data-campo="nome" maxlength="160">
                <input type="text" placeholder="Documento (opcional)" value="${escapar(l.documento)}"
                       data-festa="${f.festa}" data-i="${i}" data-campo="documento" maxlength="40">
                <input type="text" placeholder="Telefone (opcional)" value="${escapar(l.telefone)}"
                       data-festa="${f.festa}" data-i="${i}" data-campo="telefone" maxlength="30">
              </div>`).join('')}
            <div class="acoes"><button class="botao" data-salvar="${f.festa}">Salvar esta lista</button></div>`}
        </div>`;
      }).join('')}

      <p class="rodape-nota">
        Pode preencher aos poucos: salve o que já souber e volte até a data limite para nomear o que falta ou alterar.
      </p>
    `);

    const el = document.querySelector('.folha');

    el.querySelectorAll('input[data-campo]').forEach((input) => {
      input.addEventListener('input', (e) => {
        const { festa, i, campo } = e.target.dataset;
        rascunho[festa][Number(i)][campo] = e.target.value;
      });
    });

    el.querySelectorAll('[data-salvar]').forEach((botao) => {
      botao.addEventListener('click', async (e) => {
        const festa = e.target.getAttribute('data-salvar');
        e.target.disabled = true;
        e.target.textContent = 'Salvando…';
        try {
          const atualizadas = await chamar(`/convites/nomes/${festa}`, {
            method: 'PUT',
            body: JSON.stringify({ nomes: rascunho[festa] }),
          });
          if (Array.isArray(atualizadas)) festas = atualizadas;
          avisar('Lista salva');
          // O contrato mostra "N de M com nome": precisa reler.
          estado.contrato = null;
          desenhar();
        } catch (err) {
          e.target.disabled = false;
          e.target.textContent = 'Salvar esta lista';
          avisar((err && err.corpo && (err.corpo.message || err.corpo.erro)) || 'Não foi possível salvar agora');
        }
      });
    });
  };

  desenhar();
}

/**
 * COMPRAR CONVITES EXTRAS (14/10/2026).
 *
 * Antes isto era um PEDIDO: o formando dizia quantos queria e a equipe fazia o
 * resto à mão. Agora é compra de verdade — ele escolhe as festas, a quantidade,
 * vê quanto fica e assina o aditivo.
 *
 * A TELA EM DOIS TEMPOS (pedido do Dani, 14/10): primeiro ele MARCA de quais
 * festas quer convite; só então aparece o seletor de quantidade daquela festa.
 * Mostrar quatro campos de quantidade de uma vez enchia a tela de caixas que
 * quase sempre ficavam em zero.
 *
 * O QUE A TELA PRECISA DIZER ANTES DE ELE ESCOLHER, porque tudo isso muda o
 * preço ou impede a compra: quantos convites já tem, quantos cabem na festa,
 * até quando dá para comprar, e que a taxa do cartão é DO BANCO, não da casa.
 */

/** Explicação de cada forma de pagamento, no balão do "?". */
const AJUDA_PAGAMENTO = {
  pix: {
    titulo: 'Pix',
    texto:
      'Você paga na hora, sem taxa nenhuma: o valor é o dos convites. '
      + 'Assim que o pagamento cair, abrimos o aditivo para você assinar. '
      + 'O código vale por alguns minutos — se expirar, é só gerar outro.',
  },
  cartao: {
    titulo: 'Cartão de crédito',
    texto:
      'À vista ou em até 10 vezes. A taxa de utilização e os juros do parcelamento são cobrados '
      + 'pela operadora do cartão (o banco), não pelo Indaiá — por isso o total fica maior que o '
      + 'preço dos convites. O valor exato aparece antes de você confirmar. '
      + 'Se um dia houver devolução, volta o valor dos convites: a taxa e os juros ficam com a '
      + 'operadora e não são devolvidos pelo Indaiá.',
  },
};

/** Um "?" com balão, para explicar um detalhe sem encher a tela de texto. */
function balaoAjuda(titulo, texto) {
  return '<span class="cita"><button class="ajuda" type="button" aria-label="' + escapar(titulo)
    + '">?</button><span class="balao" role="tooltip"><b>' + escapar(titulo) + '</b>'
    + escapar(texto) + '</span></span>';
}

function balaoPagamento(forma) {
  const a = AJUDA_PAGAMENTO[forma];
  if (!a) return '';
  return `<span class="cita cita-pag"><button class="ajuda" type="button" aria-label="Como funciona: ${escapar(a.titulo)}">?</button><span class="balao" role="tooltip"><b>${escapar(a.titulo)}</b>${escapar(a.texto)}</span></span>`;
}

/**
 * COMO CADA ESTADO DE COMPRA SE CHAMA PARA O FORMANDO.
 *
 * Isto mora na tela de CONTRATO, não na de comprar (pedido do Dani, 14/10): a
 * hora de escolher convite deve falar só da compra que ele está fazendo. O que
 * ele já tem, o que falta assinar e o que já passou ficam no Contrato, junto
 * com os documentos.
 *
 * Não existe desistir: depois de pedir, ele segue com o aditivo. Por isso a
 * tela de compra precisa dizer com todas as letras o que ele está levando e
 * quanto vai pagar ANTES de confirmar.
 */
const ESTADO_COMPRA = {
  aguardando_assinatura: { rotulo: 'Falta a sua assinatura', classe: 'alerta' },
  assinado: { rotulo: 'Assinado — estamos atualizando suas parcelas', classe: '' },
  aplicado: { rotulo: 'Concluída', classe: '' },
  falhou: { rotulo: 'Deu problema — a equipe já está vendo', classe: 'alerta' },
};

/** O que o formando já tem e o que ficou pendente — desenhado na aba Contrato. */
function blocoDasCompras(historico) {
  const vivas = (historico || []).filter((c) => c.status !== 'cancelado');
  if (!vivas.length) return '';

  const pendente = vivas.find((c) => c.status === 'aguardando_assinatura' || (c.retomarTipo === 'pagamento' && c.retomarUrl));
  const concluidas = vivas.filter((c) => c !== pendente);

  const linhaItens = (c) =>
    (c.itens || []).map((i) => `${i.quantidade}× ${escapar(i.rotulo || i.festa || '')}`).join(', ');

  return `
    ${pendente ? `
      <div class="faixa ${(ESTADO_COMPRA[pendente.status] || {}).classe || ''}"><div>
        <b>${escapar((ESTADO_COMPRA[pendente.status] || {}).rotulo || 'Compra em andamento')}</b>
        <br>${escapar(linhaItens(pendente))} · ${brl(Number(pendente.valor_total || 0))}
        ${pendente.retomarUrl ? `
          <br><a class="link-inline" href="${escapar(pendente.retomarUrl)}" target="_blank" rel="noopener">
            ${pendente.retomarTipo === 'pagamento' ? 'Pagar agora' : 'Assinar o aditivo'}
          </a>` : ''}
      </div></div>` : ''}

    ${concluidas.length ? `
      <div class="lista">
        ${concluidas.map((c) => `
          <div class="item inerte">
            <div class="quando">
              <strong>${escapar(linhaItens(c))}</strong>
              <span>${escapar((ESTADO_COMPRA[c.status] || {}).rotulo || c.status)}${c.pagamento === 'cartao' ? ` · cartão ${c.parcelas_cartao || 1}×` : ' · somado nas parcelas'} · ${brl(Number(c.valor_total || 0))}</span>
            </div>
          </div>`).join('')}
      </div>` : ''}
  `;
}

/**
 * O PIX DO CONVITE (16/10/2026).
 *
 * O código fica na frente dele até o pagamento cair. A tela pergunta sozinha,
 * de poucos em poucos segundos — perguntar é barato e a alternativa é o
 * formando ficar recarregando a página para saber se deu certo.
 *
 * Quem confirma o pagamento é o banco, não esta tela: aqui só se mostra o que
 * já aconteceu. Quando cair, o aditivo é aberto automaticamente e ele vai
 * assinar.
 */
function telaPixDoConvite(compra) {
  let parar = false;
  const copiaECola = compra.pixCopiaECola || '';

  const desenhar = (situacao) => {
    const pago = situacao && situacao.pago;
    abrirFolha(`
      <h2>Pague com <em>Pix</em></h2>
      <div class="sub">${brl(Number(compra.valor || 0))} em convites. Assim que o pagamento cair, abrimos o aditivo para você assinar.</div>

      ${pago ? `
        <div class="faixa"><div>
          <b>Pagamento confirmado.</b><br>
          Estamos preparando seu aditivo — ele aparece em <b>Contrato</b>, em "Seus convites", para você assinar.
        </div></div>
        <div class="acoes"><button class="botao" id="ir-contrato">Ver em Contrato</button></div>`
      : `
        ${copiaECola ? `
          <div class="pix-codigo" id="pix-codigo">${escapar(copiaECola)}</div>
          <div class="acoes"><button class="botao" id="copiar-pix">Copiar o código</button></div>
          <p class="rodape-nota">
            Abra o aplicativo do seu banco, escolha <b>Pix copia e cola</b> e cole este código.
            ${compra.pixExpiraEm ? `O código vale até ${horaCurta(compra.pixExpiraEm)}.` : ''}
          </p>`
        : `
          <div class="faixa alerta"><div>
            O código ainda está sendo gerado pelo banco. Aguarde alguns instantes e atualize.
          </div></div>`}
        <p class="rodape-nota" id="pix-estado">Aguardando o pagamento…</p>
        <div class="acoes"><button class="botao secundario" id="pix-fechar">Pago depois</button></div>`}
    `);

    const el = document.querySelector('.folha');

    el.querySelector('#copiar-pix')?.addEventListener('click', async (e) => {
      try {
        await navigator.clipboard.writeText(copiaECola);
        e.target.textContent = 'Código copiado';
        setTimeout(() => { e.target.textContent = 'Copiar o código'; }, 2500);
      } catch {
        // Sem permissão para a área de transferência: o código está na tela.
        avisar('Selecione o código acima e copie');
      }
    });

    el.querySelector('#pix-fechar')?.addEventListener('click', () => {
      parar = true;
      fecharFolha();
      estado.contrato = null;
      irPara('contrato');
    });

    el.querySelector('#ir-contrato')?.addEventListener('click', () => {
      parar = true;
      fecharFolha();
      estado.contrato = null;
      irPara('contrato');
    });
  };

  const perguntar = async () => {
    if (parar) return;
    try {
      const s = await chamar(`/convites/${compra.compraId}/pix`);
      if (s && s.pago) { parar = true; return desenhar(s); }
    } catch { /* uma falha de rede não tira o código da tela */ }
    if (!parar) setTimeout(perguntar, 5000);
  };

  desenhar(null);
  setTimeout(perguntar, 5000);
}

async function telaConvites() {
  abrirFolha('<div class="vazio">Carregando…</div>');
  let oferta;
  try { oferta = await chamar('/convites'); }
  catch { return abrirFolha('<div class="vazio">Não foi possível abrir os convites agora.</div>'); }

  const escolhido = {};   // chave da festa -> quantidade (só as marcadas entram)
  // Nasce no Pix: é a forma sem taxa para ele. O cartão fica ao lado, para
  // quem quiser parcelar sabendo que a operadora cobra por isso.
  let forma = 'pix';
  let parcelasCartao = 1;
  let previa = null;

  const brlx = (v) => brl(Number(v || 0));
  const marcada = (c) => Object.prototype.hasOwnProperty.call(escolhido, c);

  const desenhar = () => {
    // Festa sem preço cadastrado não é oferecida: vender a R$ 0 seria dar de graça.
    const disponiveis = oferta.festas.filter((f) => f.unitario !== null);
    const aVenda = disponiveis.filter((f) => f.podeComprar);

    abrirFolha(`
      <h2>Convites <em>extras</em></h2>
      <div class="sub">Escolha as festas, a quantidade e como pagar. O aditivo é assinado por e-mail.</div>

      ${/* A LIBERAÇÃO PRECISA APARECER. Ele chegou aqui por um link que a
            equipe mandou para ele, depois de o prazo ter fechado — dizer isso
            é o que explica por que a festa está à venda de novo, e o que o faz
            não deixar para amanhã um link que expira. */ ''}
      ${oferta.liberadaPelaEquipe
        ? `<div class="faixa"><div>
             A equipe liberou a sua compra de <b>${escapar(oferta.liberadaPelaEquipe.rotulo)}</b>, mesmo depois do prazo.
             Vale enquanto o link que você recebeu estiver válido.
           </div></div>` : ''}

      ${oferta.bloqueio && !(oferta.pendenciasDeCadastro || []).length
        ? `<div class="faixa alerta"><div>${escapar(oferta.bloqueio)}</div></div>` : ''}

      ${(oferta.pendenciasDeCadastro || []).length ? `
        <div class="faixa alerta" style="margin-bottom:12px"><div>
          <b>Complete seus dados antes de comprar.</b>
          ${oferta.pendenciasDeCadastro.map((p) => `<br>· <b>${escapar(p.rotulo)}</b>: ${escapar(p.detalhe)}`).join('')}
          <br><button class="link-inline" id="ir-dados">Atualizar meus dados</button>
        </div></div>` : ''}

      ${aVenda.length ? `
        <div class="secao-titulo">Para quais festas</div>
        <div class="festas-escolha">
          ${aVenda.map((f) => `
            <button type="button" class="festa-chip ${marcada(f.chave) ? 'ativo' : ''}" data-marcar="${f.chave}">
              <span class="nome">${escapar(f.rotulo)}</span>
              <span class="preco">${brlx(f.unitario)}</span>
            </button>`).join('')}
        </div>

        ${aVenda.filter((f) => marcada(f.chave)).map((f) => `
          <div class="convite-item">
            <div class="convite-cab">
              <div>
                <b>${escapar(f.rotulo)}</b>
                ${/* O nome que a equipe deu ao evento: numa festa que reúne
                     várias turmas, é o que diz de qual festa se trata. */ ''}
                ${f.evento && f.evento.nome ? `<span class="convite-sub">${escapar(f.evento.nome)}</span>` : ''}
                <span class="convite-sub">${f.data ? `festa em ${dataCurta(f.data)}` : 'data a definir'}${f.lotacao && f.lotacao.vagas != null ? ` · ${f.lotacao.vagas} lugares` : ''}${f.inclusos != null ? ` · ${f.inclusos} no pacote` : ''}</span>
              </div>
              <div class="passo">
                <button type="button" class="passo-btn" data-menos="${f.chave}" aria-label="Menos um">−</button>
                <span class="passo-qtd">${escolhido[f.chave] || 0}</span>
                <button type="button" class="passo-btn" data-mais="${f.chave}" aria-label="Mais um">+</button>
                <button type="button" class="passo-lixo" data-remover="${f.chave}" aria-label="Remover ${escapar(f.rotulo)}">${ICONES.lixeira || '×'}</button>
              </div>
            </div>
            <div class="convite-linha-valor">
              <span>${escolhido[f.chave] || 0} × ${brlx(f.unitario)}</span>
              <b>${brlx((escolhido[f.chave] || 0) * f.unitario)}</b>
            </div>
            ${!f.formas.boleto && f.motivo ? `<p class="rodape-nota" style="margin:6px 0 0">${escapar(f.motivo)}</p>` : ''}
          </div>`).join('')}
        ` : ''}

      ${/* DUAS AUSÊNCIAS DIFERENTES, e confundi-las manda o formando falar com
            quem não pode resolver. Sem festa nenhuma na lista, a turma ainda
            não tem evento cadastrado: não há o que vender e nem data para
            esperar. Com festa e sem preço, a festa existe e o que falta é o
            preço do convite — aí vale pedir para a equipe. */ ''}
      ${!oferta.festas.length
        ? `<div class="vazio">As festas da sua turma ainda não foram cadastradas.<br>
             Quando a equipe marcar onde e quando cada festa acontece, os convites extras aparecem aqui.</div>`
        : !disponiveis.length
          ? '<div class="vazio">Esta turma ainda não tem convites extras à venda.</div>'
          : ''}

      ${previa ? `
        <div class="secao-titulo">Como fica</div>
        <div class="cartao resumo-compra">
          ${previa.linhas.map((l) => `<div class="dado"><span>${l.quantidade}× ${escapar(l.rotulo)}</span><b>${brlx(l.total)}</b></div>`).join('')}
          <div class="dado total"><span>Convites</span><b class="destaque-valor">${brlx(previa.valorConvites)}</b></div>

          ${/* O QUE MOSTRAR SEGUE A ESCOLHA DELE, não o que a conta devolveu:
               para o backend, Pix e cartão à vista são o mesmo cálculo. */ ''}
          ${forma === 'pix' ? `
            <p class="rodape-nota" style="margin:12px 0 8px">
              No Pix você paga <b>o valor dos convites</b>, sem taxa nenhuma. O código aparece na próxima tela.
            </p>
            <div class="dado"><span>Total no Pix</span><b class="destaque-valor">${brlx(previa.valorConvites)}</b></div>`
          : previa.forma === 'boleto' ? `
            <p class="rodape-nota" style="margin:12px 0 8px">
              Somado às suas próximas parcelas, <b>sem taxa</b>.
              ${previa.parcelas.length === 1
                ? 'Entra toda na parcela abaixo, porque é a única que vence antes da festa.'
                : `Dividido em ${previa.parcelas.length} parcelas — as que vencem antes da festa.`}
              ${balaoAjuda(
                'Como ler esta lista',
                'O valor menor é a sua mensalidade de hoje, a do contrato da formatura. '
                + 'O valor maior, à direita, é quanto aquela parcela passa a custar: a mensalidade '
                + 'mais a parte dos convites e a taxa por boleto. Nenhuma parcela já vencida ou paga é alterada.',
              )}
            </p>
            ${previa.parcelas.map((p) => `
              <div class="dado parcela-muda">
                <span>${dataCurta(p.vencimento)}<small>mensalidade de hoje: ${brlx(p.valorAtual)}</small></span>
                <b>${brlx(p.valorAtual + p.acrescimo + (previa.taxaAdm || 0))}</b>
              </div>`).join('')}
            ${previa.taxaAdm ? `<p class="rodape-nota" style="margin-top:8px">Os valores já incluem a taxa de ${brlx(previa.taxaAdm)} por boleto, que você já paga hoje.</p>` : ''}`
          : `
            <p class="rodape-nota" style="margin:12px 0 8px">
              No cartão, a <b>operadora do cartão</b> cobra taxa de utilização e juros do parcelamento.
              Esse acréscimo não é do Indaiá.
            </p>
            <div class="dado"><span>${previa.cartao.escolhida.parcelas}× no cartão</span><b class="destaque-valor">${brlx(previa.cartao.escolhida.valorTotal)}</b></div>
            <div class="dado"><span>Taxas e juros do banco</span><b>${brlx(previa.cartao.escolhida.acrescimo)}</b></div>`}
        </div>` : ''}

      ${/* SÓ CARTÃO desde 15/10/2026: o convite comprado depois da adesão se
           paga na hora. Quem quer parcelar junto com o pacote compra na
           adesão. A caixa de escolha some — uma opção só não se escolhe. */ ''}
      ${aVenda.length ? `
        <div class="secao-titulo">Como pagar</div>
        <div class="formas-pag" id="formas">
          <div class="forma-opcao ${forma === 'pix' ? 'ativo' : ''}">
            <button type="button" data-forma="pix" class="${forma === 'pix' ? 'ativo' : ''}">Pix</button>
            ${balaoPagamento('pix')}
          </div>
          <div class="forma-opcao ${forma === 'cartao' ? 'ativo' : ''}">
            <button type="button" data-forma="cartao" class="${forma === 'cartao' ? 'ativo' : ''}">Cartão de crédito</button>
            ${balaoPagamento('cartao')}
          </div>
        </div>
        ${forma === 'cartao' && previa && previa.forma === 'cartao' ? `
          <div class="campo">
            <label for="parcelas">Em quantas vezes</label>
            <select id="parcelas">
              ${previa.cartao.opcoes.map((o) => `<option value="${o.parcelas}" ${o.parcelas === parcelasCartao ? 'selected' : ''}>${o.parcelas}× de ${brlx(o.valorParcela)} — total ${brlx(o.valorTotal)}</option>`).join('')}
            </select>
          </div>` : ''}
        ${/* NÃO HÁ DESISTIR depois daqui (decisão do Dani, 14/10): ele segue
              com o aditivo. Então o compromisso precisa estar escrito antes do
              botão, junto do valor — não escondido numa cláusula. */ ''}
        ${previa && forma ? `
          <p class="rodape-nota" style="margin:12px 0 0">
            Ao confirmar, você ${forma === 'pix' ? 'paga por Pix e assina' : 'paga no cartão e assina'} o aditivo
            de <b>${brlx(previa.valorConvites)}</b> em convites${forma === 'cartao' ? ` (<b>${brlx(previa.cartao.escolhida.valorTotal)}</b> com as taxas do banco)` : ''}.
            A compra passa a fazer parte do seu contrato e não é desfeita pelo portal.
          </p>` : ''}
        <div class="acoes dupla">
          <button class="botao" id="comprar" ${previa && forma ? '' : 'disabled'}>${forma === 'pix' ? 'Pagar com Pix' : 'Ir para o pagamento'}</button>
          <button class="botao secundario" data-fechar-folha>Cancelar</button>
        </div>` : '<div class="acoes"><button class="botao secundario" data-fechar-folha>Fechar</button></div>'}
    `, ligar);
  };

  const itensEscolhidos = () =>
    Object.entries(escolhido)
      .filter(([, q]) => Number(q) > 0)
      .map(([festa, quantidade]) => ({ festa, quantidade: Number(quantidade) }));

  const recalcular = async () => {
    const itens = itensEscolhidos();
    if (!itens.length || !forma) { previa = null; return desenhar(); }
    try {
      previa = await chamar('/convites/simular', { method: 'POST', body: JSON.stringify({ itens, forma, parcelasCartao }) });
    } catch (e) {
      previa = null;
      avisar((e && e.corpo && (e.corpo.message || e.corpo.erro)) || 'Não foi possível calcular agora');
    }
    desenhar();
  };

  /** Quantos ainda cabem desta festa, para o "+" não passar da lotação. */
  const teto = (chave) => {
    const f = oferta.festas.find((x) => x.chave === chave);
    return f && f.disponivel != null ? f.disponivel : 20;
  };

  function ligar(el) {
    el.querySelector('#ir-dados')?.addEventListener('click', () => { fecharFolha(); telaMeusDados(); });

    // marcar/desmarcar a festa: só a marcada ganha seletor de quantidade
    el.querySelectorAll('[data-marcar]').forEach((b) => b.addEventListener('click', () => {
      const c = b.dataset.marcar;
      if (marcada(c)) delete escolhido[c];
      else escolhido[c] = 1;
      recalcular();
    }));

    el.querySelectorAll('[data-mais]').forEach((b) => b.addEventListener('click', () => {
      const c = b.dataset.mais;
      escolhido[c] = Math.min(teto(c), (escolhido[c] || 0) + 1);
      recalcular();
    }));

    el.querySelectorAll('[data-menos]').forEach((b) => b.addEventListener('click', () => {
      const c = b.dataset.menos;
      const novo = (escolhido[c] || 0) - 1;
      // chegou a zero: a festa sai da lista, como se tivesse sido removida
      if (novo <= 0) delete escolhido[c];
      else escolhido[c] = novo;
      recalcular();
    }));

    el.querySelectorAll('[data-remover]').forEach((b) => b.addEventListener('click', () => {
      delete escolhido[b.dataset.remover];
      recalcular();
    }));

    el.querySelectorAll('#formas [data-forma]').forEach((b) => b.addEventListener('click', (ev) => {
      // o "?" dentro do botão abre o balão, não troca a forma
      if (ev.target.closest('.cita')) return;
      forma = b.dataset.forma;
      parcelasCartao = 1;
      recalcular();
    }));

    el.querySelector('#parcelas')?.addEventListener('change', (e) => {
      parcelasCartao = Number(e.target.value) || 1;
      recalcular();
    });

    el.querySelector('#comprar')?.addEventListener('click', async (e) => {
      const itens = itensEscolhidos();
      if (!itens.length || !forma) return;
      e.target.disabled = true;
      e.target.textContent = 'Abrindo…';
      try {
        const r = await chamar('/convites/comprar', { method: 'POST', body: JSON.stringify({ itens, forma, parcelasCartao }) });

        // NO PIX A TELA NÃO SAI DAQUI: o código tem de ficar na frente dele
        // para copiar. Mandá-lo para outra tela com um QR Code vivo seria
        // pedir que ele voltasse atrás para pagar.
        if (r.forma === 'pix') return telaPixDoConvite(r);

        // No cartão o link é do PAGAMENTO: ele paga primeiro e assina depois.
        if (r.url) window.open(r.url, '_blank', 'noopener');
        avisar(r.forma === 'cartao' ? 'Abrimos o pagamento no cartão' : 'Abrimos o aditivo para você assinar');
        // Volta para o Contrato, que é onde a compra aparece com o link para
        // assinar — inclusive se o bloqueador de pop-up engolir a aba nova.
        fecharFolha();
        estado.contrato = null;   // força reler, para a compra nova já aparecer
        irPara('contrato');
      } catch (err) {
        e.target.disabled = false;
        e.target.textContent = forma === 'pix' ? 'Pagar com Pix' : 'Ir para o pagamento';
        avisar((err && err.corpo && (err.corpo.message || err.corpo.erro)) || 'Não foi possível concluir agora');
      }
    });
  }

  desenhar();
}

// ---------- aba: minha turma -------------------------------------------------
function abaTurma() {
  const t = estado.turma;
  const proxima = t.cronograma.find((e) => e.data >= hoje());

  moldura(`
    <div class="colunas duas">
      <div class="cartao">
        <div class="kicker traco">Baile de gala</div>
        <h2 class="serif" style="margin:6px 0 2px;font-size:30px">${dataLonga(t.dataEvento)}</h2>
        ${t.espaco || t.cidade ? `<p style="margin:0 0 16px;color:var(--texto-suave)">${escapar([t.espaco, t.cidade].filter(Boolean).join(' · '))}</p>` : ''}
        <div class="dado"><span>Faltam</span><b>${diasAte(t.dataEvento)} dias</b></div>
        ${(t.cronograma.find((e) => e.tipo === 'baile') || {}).hora ? `<div class="dado"><span>Recepção</span><b>${escapar(t.cronograma.find((e) => e.tipo === 'baile').hora)}</b></div>` : ''}
      </div>
      <div class="cartao">
        <div class="dado"><span>Turma</span><b>${escapar(t.rotulo)}</b></div>
        ${t.cursos?.length ? `<div class="dado"><span>Curso</span><b>${escapar(t.cursos.join(' · '))}</b></div>` : ''}
        <div class="dado"><span>Formandos</span><b>${t.formandos}</b></div>
        ${t.consultora ? `<div class="dado"><span>Consultora</span><b>${escapar(t.consultora)}</b></div>` : ''}
      </div>
    </div>


    ${t.colegas?.length ? `
      <div class="secao-titulo">Quem está na turma</div>
      <div class="pessoas colegas">
        ${t.colegas.map((c) => `
          <div class="pessoa${c.souEu ? ' eu' : ''}">
            <span class="inicial">${escapar(semMarca(c.nome).trim()[0] || '?')}</span>
            <div>
              <strong>${escapar(semMarca(c.nome))}</strong>
              ${c.souEu ? '<span>você</span>' : ''}
            </div>
          </div>`).join('')}
      </div>
      <p class="rodape-nota" style="margin-top:10px">Quem aparece aqui assinou a adesão desta turma.
      Nada do financeiro de ninguém é mostrado — nem o seu para os outros.</p>
      ${temRecurso('listaDaTurmaPdf') ? '<div class="acoes"><button class="botao secundario" data-lista-pdf>Baixar a lista em PDF</button></div>' : ''}` : ''}
    ${t.pacote ? `<div class="cartao">
      <div class="kicker traco">Pacote contratado</div>
      <p style="margin:6px 0 0">${escapar(t.pacote)}</p>
    </div>` : ''}

    ${t.comissao?.length ? `
      <div class="secao-titulo">Comissão da turma</div>
      <div class="pessoas">
        ${t.comissao.map((p) => `
          <div class="pessoa">
            <span class="inicial">${escapar(p.nome.trim()[0] || '?')}</span>
            <div>
              <strong>${escapar(p.nome)}</strong>
              <span>${escapar(p.papel)}</span>
            </div>
          </div>`).join('')}
      </div>
      <p class="rodape-nota" style="margin-top:10px">A comissão fala pela turma com a equipe: datas, cardápio, decoração e lista de convites passam por ela.</p>` : ''}

    ${t.avisos?.length ? `
      <div class="secao-titulo">Avisos da equipe</div>
      <div class="cartao">
        ${t.avisos.map((a) => `
          <div class="aviso-turma">
            <div class="data">${dataCurta(a.publicadoEm)}</div>
            <h3>${escapar(a.titulo)}</h3>
            <p>${escapar(a.texto)}</p>
          </div>`).join('')}
      </div>` : ''}

    ${proxima ? `
      <div class="secao-titulo">Próximo passo</div>
      <div class="cartao">
        <div class="kicker">${dataLonga(proxima.data)}</div>
        <h3 class="serif" style="margin:4px 0 2px;font-size:22px">${escapar(proxima.etapa)}</h3>
        <p style="margin:0 0 16px;color:var(--texto-suave);font-size:13.5px">${escapar(proxima.local || '')}${proxima.observacao ? ` — ${escapar(proxima.observacao)}` : ''}</p>
        <button class="botao secundario" data-ir="cronograma">Ver o cronograma inteiro</button>
      </div>` : ''}
    ${notaRodape()}
  `, escapar(t.rotulo));

  app.querySelectorAll('[data-ir]').forEach((b) => b.addEventListener('click', () => irPara(b.dataset.ir)));
  // A lista em PDF sai do CRM (é lá que o navegador do servidor imprime a
  // folha). No protótipo e na demonstração o botão continua aparecendo, dizendo
  // o que faz no app de verdade — esconder faria o teste local parecer que a
  // função não existe.
  app.querySelectorAll('[data-lista-pdf]').forEach((b) => b.addEventListener('click', () => {
    if (!window.API_CRM) return avisar('No app de verdade, este botão baixa a lista da turma em PDF');
    const turma = (t.rotulo || 'formatura').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\w]+/g, '-');
    baixarArquivo('/turma/formandos/pdf', `formandos-turma-${turma}.pdf`);
  }));
}

// ---------- central de avisos (o sino) ---------------------------------------
// Só o que depende do formando: parcela vencida ou perto de vencer, resposta de
// um pedido dele e etapa chegando. O mural da turma fica em Minha turma.
const ICONE_AVISO = {
  atraso: ICONES.financeiro, vencimento: ICONES.relogio,
  pedido: ICONES.pedidos, etapa: ICONES.calendario,
};

async function telaAvisos() {
  abrirFolha('<div class="vazio">Carregando…</div>');
  let r;
  try { r = await chamar('/notificacoes'); }
  catch { return abrirFolha('<div class="vazio">Não foi possível abrir seus avisos agora.</div>'); }
  estado.avisos = r;

  abrirFolha(`
    <h2>Seus <em>avisos</em></h2>
    <div class="sub">${r.naoLidas ? `${r.naoLidas} aviso${r.naoLidas > 1 ? 's' : ''} que você ainda não viu.` : 'Você está em dia com os avisos.'}</div>

    ${r.itens.length ? r.itens.map((n) => `
      <button class="notificacao t-${escapar(n.tipo)} ${n.lida ? 'lida' : ''}" data-aviso="${escapar(n.id)}" data-ir-aviso="${escapar(n.ir)}" ${n.billId ? `data-aviso-boleto="${escapar(n.billId)}"` : ''}>
        <span class="ponto-novo"></span>
        <span class="texto">
          <strong>${escapar(n.titulo)}</strong>
          <span>${escapar(n.texto)}</span>
        </span>
      </button>`).join('')
      : '<div class="vazio">Nada por aqui ainda.</div>'}

    <div class="acoes dupla">
      ${r.naoLidas ? '<button class="botao secundario" id="marcar-lidos">Marcar tudo como lido</button>' : ''}
      <button class="botao fantasma" data-fechar-folha>Fechar</button>
    </div>
  `, (el) => {
    el.querySelector('#marcar-lidos')?.addEventListener('click', async () => {
      try {
        estado.avisos = await chamar('/notificacoes/lidas', { method: 'POST', body: JSON.stringify({ ids: r.itens.map((i) => i.id) }) });
      } catch { /* sem drama: o sino continua como está */ }
      estado.avisos = await chamar('/notificacoes').catch(() => estado.avisos);
      fecharFolha();
      irPara(estado.aba);
    });

    el.querySelectorAll('[data-aviso]').forEach((b) => b.addEventListener('click', async () => {
      await chamar('/notificacoes/lidas', { method: 'POST', body: JSON.stringify({ ids: [b.dataset.aviso] }) }).catch(() => {});
      estado.avisos = await chamar('/notificacoes').catch(() => estado.avisos);
      const destino = b.dataset.irAviso;
      fecharFolha();
      if (destino === 'pedidos') return telaMeusPedidos();
      await irPara(destino);
      if (b.dataset.avisoBoleto) abrirBoleto(b.dataset.avisoBoleto);
    }));
  });
}

// ---------- dúvidas frequentes -----------------------------------------------
// As perguntas que hoje chegam por WhatsApp. As respostas seguem o termo de
// adesão — por isso citam a cláusula.
const PERGUNTAS = [
  { p: 'Como eu pago a parcela?', r: 'Pelo boleto: abra a parcela e use o botão para ver o boleto. Lá estão o código de barras e a opção de salvar em PDF — pague pelo aplicativo do seu banco. Não trabalhamos com Pix.' },
  { p: 'Perdi o boleto, e agora?', r: 'Nada se perde por aqui: a parcela sempre mostra a linha digitável e o PDF. Se já venceu, o botão de 2ª via gera um boleto novo com data nova.' },
  { p: 'Paguei e a parcela continua em aberto', r: 'A baixa do banco pode levar até 3 dias úteis. Se passou disso, anexe o comprovante na própria parcela — a equipe confere e dá a baixa.' },
  { p: 'Por que a parcela em atraso tem valor diferente?', r: 'O valor da parcela é fixo. Depois do vencimento entram juros de mora de 1% ao mês, calculados por dia de atraso, mais a taxa de boleto — por isso a 2ª via sai um pouco maior que a parcela.', c: '4.3' },
  { p: 'Posso adiantar ou quitar tudo?', r: 'Pode. Em Financeiro, a opção "Antecipar" mostra a soma das próximas parcelas e do contrato inteiro. As parcelas entram pelo valor delas, e a taxa de boleto é cobrada uma vez só em vez de uma por parcela. Escolhida a opção, o boleto único sai na hora.' },
  { p: 'Posso mudar a data de vencimento?', r: 'A reprogramação da forma de pagamento é combinada com a equipe e tem taxa fixa de R$ 75,00 prevista no termo.', c: '17.3' },
  { p: 'O que acontece se eu atrasar?', r: 'Enquanto houver parcela em aberto, a participação em eventos, ensaios e a retirada de convites ficam suspensas até regularizar.', c: '8.1' },
  { p: 'Como peço convites extras?', r: 'Na aba Contrato, em "Seus convites". O pedido vai para a equipe, que confere disponibilidade e faz o aditivo. Nada é cobrado automaticamente.' },
  { p: 'Preciso do comprovante para o imposto de renda', r: 'Em Financeiro, "Informe de pagamentos" soma o que você pagou em cada ano e gera o documento.' },
  { p: 'As datas do cronograma podem mudar?', r: 'Podem: elas são confirmadas pela equipe junto com a comissão da turma. Toda mudança aparece no cronograma e nos avisos.' },
];

function telaPerguntas() {
  abrirFolha(`
    <h2>Dúvidas <em>frequentes</em></h2>
    <div class="sub">As perguntas que mais chegam para a equipe. Se a sua não estiver aqui, fale com a gente.</div>
    ${PERGUNTAS.map((q) => `
      <details class="faq-item">
        <summary>${escapar(q.p)}</summary>
        <p>${escapar(q.r)}${q.c ? ` ${clausula(q.c)}` : ''}</p>
      </details>`).join('')}
    <div class="acoes dupla">
      ${temRecurso('falarComEquipe') ? '<button class="botao secundario" id="faq-zap">Falar com a gente</button>' : ''}
      <button class="botao fantasma" data-fechar-folha>Fechar</button>
    </div>
  `, (el) => el.querySelector('#faq-zap')?.addEventListener('click', abrirWhatsapp));
}

// ---------- informe anual de pagamentos --------------------------------------
async function telaInformeIr() {
  abrirFolha('<div class="vazio">Carregando…</div>');
  let r;
  try { r = await chamar('/informe-ir'); }
  catch { return abrirFolha('<div class="vazio">Não foi possível montar o informe agora.</div>'); }

  abrirFolha(`
    <h2>Informe de <em>pagamentos</em></h2>
    <div class="sub">O total pago em cada ano-calendário, para a declaração de imposto de renda.</div>

    ${r.anos.length ? `
      <div class="lista-antecipa">
        ${r.anos.map((a) => `
          <button class="opcao-antecipa" data-ano="${a.ano}">
            <div class="quando">
              <strong>${a.ano}</strong>
              <span>${a.parcelas} parcela${a.parcelas > 1 ? 's' : ''} paga${a.parcelas > 1 ? 's' : ''}</span>
            </div>
            <div class="quanto"><b>${brl(a.total)}</b><span class="economia">abrir o informe</span></div>
          </button>`).join('')}
      </div>` : '<div class="cartao plano"><div class="vazio">Você ainda não tem parcelas pagas.</div></div>'}

    <div class="dado"><span>Prestador</span><b>${escapar(r.prestador.razaoSocial)}</b></div>
    <div class="dado"><span>CNPJ</span><b>${escapar(r.prestador.cnpj)}</b></div>

    <p class="rodape-nota">O informe soma as parcelas com pagamento confirmado no ano. Confira com a
    equipe antes de usar na declaração.</p>
    <div class="acoes"><button class="botao fantasma" data-fechar-folha>Fechar</button></div>
  `, (el) => {
    el.querySelectorAll('[data-ano]').forEach((b) => b.addEventListener('click', () => abrirInforme(b.dataset.ano)));
  });
}

async function abrirInforme(ano) {
  if (estado.config?.demo) {
    try {
      const d = await chamar(`/informe-ir/${ano}`);
      return abrirFolha(`
        <div class="boleto-papel">
          <div class="boleto-marca">INDAIÁ EVENTOS · FORMATURAS</div>
          <div class="boleto-sub">Informe de pagamentos ${escapar(ano)}</div>
          <h2>Total pago em ${escapar(ano)}</h2>
          <div class="sub">${escapar(d.formando)} · ${escapar(d.turma)}</div>
          <div class="dado"><span>CPF</span><b>${escapar(d.cpf)}</b></div>
          <div class="dado"><span>Prestador</span><b>${escapar(d.prestador.razaoSocial)}</b></div>
          <div class="dado"><span>CNPJ</span><b>${escapar(d.prestador.cnpj)}</b></div>
          <div class="dado"><span>Parcelas pagas</span><b>${d.parcelas}</b></div>
          <div class="dado"><span>Total pago</span><b class="destaque-valor">${brl(d.total)}</b></div>
          <div class="secao-titulo">Parcelas</div>
          ${d.itens.map((i) => `<div class="dado"><span>Parcela ${i.parcela} · pago em ${dataCurta(i.pagoEm)}</span><b>${brl(i.valorPago)}</b></div>`).join('')}
        </div>
        <p class="rodape-nota">No app de verdade este botão baixa o informe em PDF.</p>
        <div class="acoes"><button class="botao fantasma" data-fechar-folha>Fechar</button></div>
      `);
    } catch { return avisar('Não foi possível abrir o informe agora'); }
  }
  baixarArquivo(`/informe-ir/${ano}/pdf`, `informe-${ano}.pdf`);
}

// Todo PDF deste protótipo passa por aqui: o endpoint exige o token, então o
// arquivo vem por fetch e abre numa aba nova.
async function baixarArquivo(caminho, nome) {
  avisar('Gerando o PDF…');
  try {
    const resposta = await fetch(urlDoArquivo(caminho), { headers: { authorization: `Bearer ${estado.token}` } });
    if (!resposta.ok) throw new Error('falha');
    const url = URL.createObjectURL(await resposta.blob());
    const a = document.createElement('a');
    a.href = url; a.target = '_blank'; a.rel = 'noopener'; a.download = nome;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  } catch { avisar('Não foi possível abrir o PDF agora'); }
}

// ---------- recibo de uma parcela paga ---------------------------------------
async function abrirRecibo(id) {
  if (!estado.config?.demo) return baixarArquivo(`/financeiro/${id}/recibo/pdf`, 'recibo.pdf');
  try {
    const r = await chamar(`/financeiro/${id}/recibo`);
    abrirFolha(`
      <div class="boleto-papel">
        <div class="boleto-marca">INDAIÁ EVENTOS · FORMATURAS</div>
        <div class="boleto-sub">Recibo de pagamento de parcela</div>
        <h2>${escapar(r.numero)}</h2>
        <div class="sub">${escapar(r.turma)}</div>
        <div class="dado"><span>Formando</span><b>${escapar(r.formando)}</b></div>
        <div class="dado"><span>CPF</span><b>${escapar(r.cpf)}</b></div>
        <div class="dado"><span>Parcela</span><b>${r.parcela} de ${r.totalParcelas}</b></div>
        <div class="dado"><span>Vencimento</span><b>${dataCurta(r.vencimento)}</b></div>
        <div class="dado"><span>Pago em</span><b>${dataCurta(r.pagoEm)}</b></div>
        <div class="dado"><span>Forma</span><b>${escapar(r.forma)}</b></div>
        <div class="dado"><span>Valor pago</span><b class="destaque-valor">${brl(r.valorPago)}</b></div>
      </div>
      <p class="rodape-nota">No app de verdade este botão baixa o recibo em PDF.</p>
      <div class="acoes"><button class="botao fantasma" data-fechar-folha>Fechar</button></div>
    `);
  } catch { avisar('Não foi possível abrir o recibo agora'); }
}

// ---------- instalar na tela de início (PWA) ---------------------------------
// O site pode virar aplicativo sem loja: o navegador instala o atalho, abre em
// tela cheia e — quando o envio estiver ligado no servidor — recebe notificação.
// No Android o próprio navegador oferece instalar; no iPhone é pelo menu de
// compartilhar, e só assim o iOS aceita notificação.
const instalado = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const ehIos = () => /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const ehAndroid = () => /android/i.test(navigator.userAgent);

// o Android avisa quando dá para instalar; guardamos para usar no botão
addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); estado.convite = e; });
addEventListener('appinstalled', () => { estado.convite = null; avisar('Pronto: a Área do Formando está na sua tela de início'); });

const PASSOS_INSTALAR = {
  ios: [
    'Abra este site no <b>Safari</b> (no iPhone só funciona por ele).',
    'Toque no botão <b>Compartilhar</b>, o quadradinho com a seta para cima, na barra de baixo.',
    'Role a lista e toque em <b>Adicionar à Tela de Início</b>.',
    'Confirme em <b>Adicionar</b>, no canto de cima.',
  ],
  android: [
    'Toque nos <b>três pontinhos</b> do canto do navegador.',
    'Escolha <b>Instalar aplicativo</b> (ou "Adicionar à tela inicial").',
    'Confirme em <b>Instalar</b>.',
  ],
  computador: [
    'Na barra de endereço, clique no ícone de <b>instalar</b> (um monitor com uma seta).',
    'Confirme em <b>Instalar</b>.',
  ],
};

function telaInstalar() {
  const plataforma = ehIos() ? 'ios' : ehAndroid() ? 'android' : 'computador';
  const nomes = { ios: 'iPhone e iPad', android: 'Android', computador: 'computador' };
  const outra = plataforma === 'ios' ? 'android' : 'ios';

  abrirFolha(`
    <h2>Deixar na <em>tela de início</em></h2>
    <div class="sub">A Área do Formando vira um atalho com o ícone da Indaiá, abre em tela cheia e
    funciona mesmo com internet ruim.</div>

    ${instalado() ? '<div class="faixa info"><div>Já está instalada neste aparelho.</div></div>' : `
      ${estado.convite ? '<div class="acoes"><button class="botao" id="instalar-agora">Instalar agora</button></div>' : ''}
      <div class="secao-titulo">No ${nomes[plataforma]}</div>
      <ol class="passos">${PASSOS_INSTALAR[plataforma].map((t) => `<li>${t}</li>`).join('')}</ol>
      <details class="faq-item">
        <summary>No ${nomes[outra]}</summary>
        <ol class="passos" style="padding:0 16px 14px 34px">${PASSOS_INSTALAR[outra].map((t) => `<li>${t}</li>`).join('')}</ol>
      </details>`}

    <p class="rodape-nota">Depois de instalada, ela também pode avisar você quando um boleto ficar
    disponível ou um pedido for respondido — no iPhone, os avisos só funcionam com o atalho instalado.</p>
    <div class="acoes"><button class="botao fantasma" data-fechar-folha>Fechar</button></div>
  `, (el) => {
    el.querySelector('#instalar-agora')?.addEventListener('click', async () => {
      const convite = estado.convite;
      if (!convite) return;
      estado.convite = null;
      convite.prompt();
      const { outcome } = await convite.userChoice;
      if (outcome !== 'accepted') avisar('Sem problema: dá para instalar depois por aqui');
      fecharFolha();
    });
  });
}

function abrirWhatsapp(mensagem) {
  const numero = estado.config?.whatsappAtendimento;
  if (!numero) return avisar('WhatsApp do atendimento não configurado');
  const padrao = `Oi! Sou ${estado.eu?.nome || ''}, da turma ${estado.eu?.turma?.codigo || ''}.`;
  window.open(`https://wa.me/${numero}?text=${encodeURIComponent(mensagem || padrao)}`, '_blank', 'noopener');
}

/**
 * O pedido foi registrado — e acabou.
 *
 * Até 28/09 esta folha pedia para o formando "enviar a mensagem no WhatsApp":
 * o pedido só existia de verdade quando ELE mandava. Agora o pedido vira
 * DEMANDA no CRM na hora, com protocolo e responsável (decisão do usuário), e
 * pedir que ele ainda faça algo seria pedir duas vezes a mesma coisa.
 *
 * `texto` continua no parâmetro porque quem chama monta a mensagem para outros
 * usos; aqui ele não é mais oferecido.
 */
function folhaPedidoEnviado({ titulo, sub, protocolo, nota }) {
  abrirFolha(`
    <h2>${titulo}</h2>
    <div class="sub">${sub}</div>
    <div class="dado"><span>Protocolo</span><b>${escapar(protocolo)}</b></div>
    <div class="faixa info" style="margin-top:14px">
      <div>Pronto: a equipe já recebeu. Guarde o protocolo — é por ele que a gente
      acha o seu pedido. A resposta aparece aqui em <b>Meus pedidos</b>.</div>
    </div>
    <div class="acoes">
      <button class="botao" data-fechar-folha>Entendi</button>
    </div>
    ${nota ? `<p class="rodape-nota">${nota}</p>` : ''}
  `);
}

// ---------- orquestração -----------------------------------------------------
/** O que cada aba precisa ter em mãos para poder ser desenhada. */
const DADOS_DA_ABA = {
  inicio: ['financeiro', 'turma'],
  financeiro: ['financeiro'],
  cronograma: ['turma'],
  contrato: ['contrato'],
  turma: ['turma'],
};
const DESENHAR = { inicio: () => abaInicio(), financeiro: () => abaFinanceiro(), cronograma: () => abaCronograma(), contrato: () => abaContrato(), turma: () => abaTurma() };

/**
 * O sino não muda por trocar de aba.
 *
 * Ele era refeito a cada clique, e montá-lo custa um `/financeiro` inteiro
 * (1,2 s medido em 07/10). Agora é lido uma vez e revalidado no máximo a cada
 * minuto — e sempre em segundo plano, sem segurar a tela. Depois de uma ação
 * que mexe no estado (2ª via, pedido, comprovante), quem chama passa
 * `{ agora: true }`.
 */
let avisosLidosEm = 0;
async function atualizarAvisos({ agora = false } = {}) {
  if (!agora && Date.now() - avisosLidosEm < 60000) return;
  avisosLidosEm = Date.now();
  try {
    const novos = await chamar('/notificacoes');
    const mudou = JSON.stringify(novos) !== JSON.stringify(estado.avisos);
    estado.avisos = novos;
    // só redesenha se o contador mudou de verdade: redesenhar à toa pisca a
    // tela e perde a rolagem de quem está lendo
    if (mudou && DESENHAR[estado.aba]) DESENHAR[estado.aba]();
  } catch { avisosLidosEm = 0; }
}

/**
 * Troca de aba.
 *
 * Desenha PRIMEIRO, com o que já está na memória, e busca o que falta depois —
 * era isso que fazia a troca parecer travada: a tela só aparecia quando a
 * última resposta chegava. Quem volta a uma aba já visitada não espera nada.
 */
async function irPara(aba) {
  estado.aba = aba;
  const precisa = DADOS_DA_ABA[aba] || [];
  const faltando = precisa.filter((k) => !estado[k]);

  if (!faltando.length) DESENHAR[aba]();           // já tenho tudo: pinta agora
  else abrirCarregando();                        // primeira visita: diz que está vindo

  atualizarAvisos();                                // em segundo plano, nunca segura

  if (!precisa.length) return;
  try {
    const frescos = await Promise.all(precisa.map((k) => chamar(`/${k}`)));
    precisa.forEach((k, i) => { estado[k] = frescos[i]; });
    if (estado.aba === aba) DESENHAR[aba]();        // a pessoa pode ter trocado de novo
  } catch (err) {
    if (err.status === 401) return sair();
    if (err.message === 'adesao_cancelada') return telaCancelada();
    if (faltando.length) return moldura('<div class="vazio">Não foi possível carregar agora.</div>', '');
    avisar('Não foi possível atualizar agora');     // o que estava na tela continua valendo
  }
}

/**
 * Enquanto a primeira carga não chega: a moldura da aba, sem conteúdo falso.
 * O título vem de `estado.aba`, que já foi trocado — a pessoa vê onde está.
 */
function abrirCarregando() {
  moldura('<div class="vazio">Carregando…</div>', '');
}

async function entrar() {
  // O /config do CRM pede token, e a tentativa do boot acontece antes do login:
  // voltava 401 e `estado.config` ficava vazio pelo resto da sessão — o botão de
  // "Falar com a gente" sumia e os prazos do contrato caíam nos valores
  // embutidos aqui no JS, em vez dos que o CRM manda. Com a sessão em mãos,
  // pede de novo. Falha calada: a tela já sabe viver sem config.
  const [eu] = await Promise.all([
    chamar('/me'),
    chamar('/config').then((c) => { estado.config = c; }).catch(() => {}),
  ]);
  estado.eu = eu;
  if (estado.eu.situacao === 'cancelada') return telaCancelada();
  await irPara('inicio');
}

function sair() {
  esquecer();
  estado.token = null; estado.eu = null; estado.financeiro = null;
  estado.contrato = null; estado.turma = null;
  estado.aba = 'inicio'; estado.filtro = 'aberto'; estado.menuAberto = false;
  telaEntrar();
}

// O service worker deixa o site abrir sem internet e recebe a notificação quando
// o envio for ligado. Falha calada: navegador antigo ou sem https segue normal.
if ('serviceWorker' in navigator) {
  addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
}

/**
 * O TOKEN DA PÁGINA DO EVENTO (19/10/2026).
 *
 * `?c=<token>` abre a página pública da festa — a que a equipe manda quando a
 * compra já fechou, ou quando a pessoa não está conseguindo entrar no portal.
 * `?convite=` é o nome antigo do mesmo parâmetro, e segue aceito porque há
 * links dele circulando.
 */
function tokenDoEventoNaUrl() {
  try {
    const q = new URLSearchParams(location.search);
    return q.get('c') || q.get('convite') || null;
  } catch { return null; }
}

(async function iniciar() {
  aplicarTema(temaAtual());
  estado.visao = visaoGuardada();

  // A PÁGINA DO EVENTO VEM ANTES DA SESSÃO. Quem chega pelo link da equipe
  // precisa ver a festa mesmo sem conseguir entrar no portal — é justamente
  // para isso que o link existe.
  const tokenEvento = tokenDoEventoNaUrl();
  if (tokenEvento) return telaEventoPublico(tokenEvento);

  const guardado = recuperar();
  // Na demonstração e no local o /config responde sem sessão, e a tela de
  // entrada usa o que vem dele (CPF de exemplo, aviso de ambiente). No CRM ele
  // pede token, então pedir aqui só renderia um 401 no console: quem já tem
  // sessão recebe o config dentro de entrar().
  if (!window.API_URL) {
    try { estado.config = await chamar('/config'); } catch { /* segue sem config */ }
  }
  if (guardado) {
    estado.token = guardado;
    try { return await entrar(); } catch { esquecer(); estado.token = null; }
  }
  telaEntrar();
})();

/* ───────────────────────────────────────────────────────────────────────────
   A PÁGINA PÚBLICA DO EVENTO (19/10/2026)

   Quem chega aqui recebeu um link da equipe: ou a compra já fechou (7 dias
   antes da festa) e ele foi aprovado caso a caso, ou não está conseguindo
   entrar no portal — login travado, telefone trocado, sistema fora do ar.

   Por isso a página mostra a festa ANTES de pedir qualquer coisa: data, lugar
   com endereço, como chegar e o que levar. Só para comprar é que ela pede CPF
   e código, porque o convite entra no contrato de alguém e esse alguém precisa
   ser quem diz que é.
   ────────────────────────────────────────────────────────────────────────── */

/** O endereço da API pública: a mesma base do CRM, outro caminho. */
function baseEventoPublico() {
  if (!window.API_URL) return null;
  return String(window.API_URL).replace(/\/area-formando\/?$/, '/evento-publico');
}

async function pedirEventoPublico(caminho, opcoes = {}) {
  const base = baseEventoPublico();
  if (!base) throw new Error('Esta página só funciona no site publicado.');
  const r = await fetch(`${base}${caminho}`, {
    method: opcoes.method || 'GET',
    headers: { 'content-type': 'application/json' },
    ...(opcoes.body ? { body: opcoes.body } : {}),
  });
  const envelope = await r.json().catch(() => ({}));
  if (!r.ok) {
    const erro = new Error(envelope.message || 'Não foi possível agora.');
    erro.status = r.status;
    throw erro;
  }
  return envelope.data ?? envelope;
}

function horasLegiveis(h) {
  if (h == null) return '';
  if (h < 1) return `${Math.max(1, Math.round(h * 60))} minutos`;
  if (h < 48) return `${Math.round(h)} horas`;
  return `${Math.round(h / 24)} dias`;
}

async function telaEventoPublico(token) {
  app.className = 'entrar';
  app.innerHTML = `<div class="entrar-caixa">${marca()}<div class="cartao"><div class="vazio">Carregando a festa…</div></div></div>`;

  let evento;
  try {
    evento = await pedirEventoPublico(`/${encodeURIComponent(token)}`);
  } catch (e) {
    const expirou = e.status === 410;
    app.innerHTML = `
      <div class="entrar-caixa">
        ${marca()}
        <div class="cartao">
          <div class="kicker">Convite</div>
          <h1>${expirou ? 'Este link <span class="grifo">expirou</span>' : 'Link <span class="grifo">inválido</span>'}</h1>
          <p class="sub">
            ${expirou
              ? 'Links de compra valem por pouco tempo, de propósito. Peça um novo para a equipe da sua formatura.'
              : 'Confira se o endereço veio inteiro na mensagem. Se continuar, fale com a equipe.'}
          </p>
          <button class="botao" id="ir-portal">Ir para a Área do Formando</button>
        </div>
        ${notaRodape()}
      </div>`;
    app.querySelector('#ir-portal').addEventListener('click', () => {
      history.replaceState(null, '', location.pathname);
      location.reload();
    });
    return;
  }

  // O token fica guardado: é ele que reabre a compra depois do prazo, e o
  // adaptador o manda em toda a conversa da compra.
  try { sessionStorage.setItem('area-formando:liberacao', token); } catch { /* segue sem guardar */ }

  const l = evento.local || {};
  const quando = evento.data ? dataLonga(evento.data) : 'data a confirmar';
  const preco = evento.preco
    ? (evento.preco.de === evento.preco.ate ? brl(evento.preco.de) : `${brl(evento.preco.de)} a ${brl(evento.preco.ate)}`)
    : null;

  app.innerHTML = `
    <div class="entrar-caixa">
      ${marca()}
      <div class="cartao">
        <div class="kicker">${escapar(evento.rotulo || 'Convite')}</div>
        <h1>${escapar(evento.nome)}</h1>
        <p class="sub">
          ${escapar(quando)}${evento.hora ? ` · ${escapar(String(evento.hora).slice(0, 5))}` : ''}
          ${evento.turmas && evento.turmas.length ? ` · ${escapar(evento.turmas.join(' + '))}` : ''}
        </p>

        <div class="dado"><span>Onde</span><b>${escapar(l.nome || 'a confirmar')}</b></div>
        ${l.endereco ? `<div class="dado"><span>Endereço</span><b>${escapar(l.endereco)}</b></div>` : ''}
        ${l.mapaUrl ? `<div class="dado"><span>Como chegar</span><a class="link-inline" href="${escapar(l.mapaUrl)}" target="_blank" rel="noopener">abrir no mapa</a></div>` : ''}
        ${preco ? `<div class="dado"><span>Convite</span><b class="destaque-valor">${escapar(preco)}</b></div>` : ''}

        ${evento.regrasEntrada ? `
          <div class="faixa" style="margin-top:12px"><div>
            <b>Para entrar:</b> ${escapar(evento.regrasEntrada)}
          </div></div>` : ''}

        <button class="botao" id="comprar" style="margin-top:14px">Comprar meu convite</button>

        <p class="rodape-nota" style="margin-top:10px">
          Este link vale por mais ${escapar(horasLegiveis(evento.horasRestantes))} e foi liberado para você pela
          equipe. Para comprar, confirmamos o seu CPF com um código — o convite entra no seu contrato.
        </p>
      </div>
      ${notaRodape()}
    </div>`;

  app.querySelector('#comprar').addEventListener('click', () => telaEventoCpf(token, evento));
}

/** O CPF, com a festa à vista para a pessoa saber onde está. */
function telaEventoCpf(token, evento, erro) {
  app.className = 'entrar';
  app.innerHTML = `
    <div class="entrar-caixa">
      ${marca()}
      <div class="cartao">
        <div class="kicker">${escapar(evento.nome)}</div>
        <h1>Confirme seu <span class="grifo">CPF</span></h1>
        <p class="sub">Vamos mandar um código por WhatsApp ou e-mail. O convite entra no seu contrato, por isso precisamos ter certeza de que é você.</p>
        <form id="form-cpf" novalidate>
          <div class="campo">
            <label for="cpf">CPF</label>
            <input id="cpf" inputmode="numeric" autocomplete="off" placeholder="000.000.000-00" value="${escapar(mascaraCpf(estado.cpf || ''))}" />
          </div>
          ${erro ? `<p class="erro">${escapar(erro)}</p>` : ''}
          <button class="botao" type="submit">Receber código</button>
        </form>
        <button class="link-inline" id="voltar" style="margin-top:10px">voltar para a festa</button>
      </div>
      ${notaRodape()}
    </div>`;

  const campo = app.querySelector('#cpf');
  campo.addEventListener('input', () => { campo.value = mascaraCpf(campo.value); });
  app.querySelector('#voltar').addEventListener('click', () => telaEventoPublico(token));

  app.querySelector('#form-cpf').addEventListener('submit', async (e) => {
    e.preventDefault();
    const cpf = campo.value.replace(/\D/g, '');
    if (cpf.length !== 11) return telaEventoCpf(token, evento, 'Digite os 11 números do CPF.');
    estado.cpf = cpf;
    const botao = app.querySelector('button[type=submit]');
    botao.disabled = true;
    botao.textContent = 'Enviando…';
    try {
      const r = await pedirEventoPublico(`/${encodeURIComponent(token)}/auth/codigo`, {
        method: 'POST',
        body: JSON.stringify({ cpf }),
      });
      telaEventoCodigo(token, evento, r);
    } catch (err) {
      telaEventoCpf(token, evento, err.message);
    }
  });
}

/** O código, e a entrada direta na compra. */
function telaEventoCodigo(token, evento, envio, erro) {
  app.className = 'entrar';
  const destinos = [envio && envio.destinos && envio.destinos.whatsapp, envio && envio.destinos && envio.destinos.email].filter(Boolean);
  app.innerHTML = `
    <div class="entrar-caixa">
      ${marca()}
      <div class="cartao">
        <div class="kicker">${escapar(evento.nome)}</div>
        <h1>Digite o <span class="grifo">código</span></h1>
        <p class="sub">${destinos.length ? `Enviado para ${escapar(destinos.join(' e '))}.` : 'Enviado para o seu contato cadastrado.'}</p>
        ${envio && envio.codigoDev ? `<div class="dev">Ambiente de teste — o código é <strong class="cpf">${escapar(envio.codigoDev)}</strong></div>` : ''}
        <form id="form-codigo" novalidate>
          <div class="campo">
            <label for="codigo">Código de 6 dígitos</label>
            <input id="codigo" inputmode="numeric" maxlength="6" autocomplete="one-time-code" placeholder="000000" />
          </div>
          ${erro ? `<p class="erro">${escapar(erro)}</p>` : ''}
          <button class="botao" type="submit">Entrar e comprar</button>
        </form>
        <button class="link-inline" id="voltar" style="margin-top:10px">usar outro CPF</button>
      </div>
      ${notaRodape()}
    </div>`;

  app.querySelector('#voltar').addEventListener('click', () => telaEventoCpf(token, evento));
  app.querySelector('#form-codigo').addEventListener('submit', async (e) => {
    e.preventDefault();
    const codigo = app.querySelector('#codigo').value.replace(/\D/g, '');
    if (codigo.length !== 6) return telaEventoCodigo(token, evento, envio, 'O código tem 6 números.');
    const botao = app.querySelector('button[type=submit]');
    botao.disabled = true;
    botao.textContent = 'Entrando…';
    try {
      const r = await pedirEventoPublico(`/${encodeURIComponent(token)}/auth/verificar`, {
        method: 'POST',
        body: JSON.stringify({ cpf: estado.cpf, codigo }),
      });
      // Duas turmas do mesmo CPF nesta festa: ele escolhe qual.
      if (r.etapa === 'escolha') return telaEventoEscolha(token, evento, r.adesoes || []);
      await entrarComToken(r.token, token, evento);
    } catch (err) {
      telaEventoCodigo(token, evento, envio, err.message);
    }
  });
}

function telaEventoEscolha(token, evento, adesoes) {
  app.className = 'entrar';
  app.innerHTML = `
    <div class="entrar-caixa">
      ${marca()}
      <div class="cartao">
        <div class="kicker">${escapar(evento.nome)}</div>
        <h1>Qual <span class="grifo">turma</span>?</h1>
        <p class="sub">Seu CPF aparece em mais de uma turma desta festa.</p>
        ${adesoes.map((a) => `
          <button class="botao secundario" data-adesao="${escapar(a.adesaoId)}" style="margin-bottom:8px">
            ${escapar(a.turma)} — ${escapar(a.nome)}
          </button>`).join('')}
      </div>
      ${notaRodape()}
    </div>`;

  app.querySelectorAll('[data-adesao]').forEach((b) => b.addEventListener('click', async () => {
    try {
      const r = await pedirEventoPublico(`/${encodeURIComponent(token)}/auth/escolher`, {
        method: 'POST',
        body: JSON.stringify({ cpf: estado.cpf, adesaoId: b.dataset.adesao }),
      });
      await entrarComToken(r.token, token, evento);
    } catch (err) {
      avisar(err.message);
    }
  }));
}

/**
 * Entra e segue COMPRANDO NESTA PÁGINA — sem abrir o portal.
 *
 * O portal ainda não foi liberado para os alunos (decisão do Dani, 19/10), e o
 * link precisa funcionar antes disso. Então o acesso obtido aqui serve só para
 * as rotas da compra: nada de sessão guardada, nada de tela do portal. Quem
 * fechar a aba volta do começo, com o link, que é o comportamento certo para
 * uma página de ingresso.
 */
async function entrarComToken(acesso, tokenDoEvento, evento) {
  compraEvento.token = tokenDoEvento;
  compraEvento.acesso = acesso;
  compraEvento.evento = evento;

  // A festa e o preço já vieram na página: é a mesma conta do contrato.
  compraEvento.festa = evento.festaChave;
  compraEvento.unitario = evento.preco ? evento.preco.de : 0;
  compraEvento.quantidade = 1;
  compraEvento.nomes = [];
  telaComprarIngresso();
}

/* ───────────────────────────────────────────────────────────────────────────
   A COMPRA NA PRÓPRIA PÁGINA DO EVENTO (19/10/2026)

   O formando NÃO entra no portal aqui (pedido do Dani): o portal ainda não foi
   liberado para os alunos, e o link precisa funcionar antes disso. Então a
   compra inteira acontece nesta página — quantidade, nomes, pagamento,
   aditivo e ingresso —, usando as mesmas rotas e o mesmo contrato de sempre.

   A ORDEM É A DE UM SITE DE INGRESSO: escolher quantos, dizer quem usa cada
   um, pagar, assinar, receber o ingresso. Os nomes vêm ANTES do pagamento de
   propósito: o link é mandado perto da festa, quando a operação já precisa
   saber quem entra, e pedir depois de cobrar seria deixar a equipe correndo
   atrás de nome com o dinheiro já na conta.
   ────────────────────────────────────────────────────────────────────────── */

/** O estado da compra nesta página. Vive só aqui; sair da página o descarta. */
const compraEvento = {
  token: null,
  acesso: null,
  evento: null,
  festa: null,
  unitario: 0,
  quantidade: 1,
  forma: 'pix',
  parcelas: 1,
  nomes: [],
};

async function pedirComAcesso(caminho, opcoes = {}) {
  const base = baseEventoPublico();
  const r = await fetch(`${base}${caminho}`, {
    method: opcoes.method || 'GET',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${compraEvento.acesso}`,
    },
    ...(opcoes.body ? { body: opcoes.body } : {}),
  });
  const envelope = await r.json().catch(() => ({}));
  if (!r.ok) {
    const erro = new Error(envelope.message || 'Não foi possível agora.');
    erro.status = r.status;
    throw erro;
  }
  return envelope.data ?? envelope;
}

/** Depois do login: escolher quantos convites e como pagar. */
function telaComprarIngresso(erro) {
  const e = compraEvento.evento;
  const total = compraEvento.unitario * compraEvento.quantidade;
  app.className = 'entrar';
  app.innerHTML = `
    <div class="entrar-caixa">
      ${marca()}
      <div class="cartao">
        <div class="kicker">${escapar(e.nome)}</div>
        <h1>Quantos <span class="grifo">convites</span>?</h1>
        <p class="sub">
          ${escapar(e.data ? dataLonga(e.data) : 'data a confirmar')}${e.hora ? ` · ${escapar(String(e.hora).slice(0, 5))}` : ''}
          ${e.local?.nome ? ` · ${escapar(e.local.nome)}` : ''}
        </p>

        <div class="convite-item">
          <div class="convite-cab">
            <div>
              <b>Convite avulso</b>
              <span class="convite-sub">${escapar(brl(compraEvento.unitario))} cada</span>
            </div>
            <div class="passo">
              <button type="button" class="passo-btn" id="menos" aria-label="Menos um">−</button>
              <span class="passo-qtd">${compraEvento.quantidade}</span>
              <button type="button" class="passo-btn" id="mais" aria-label="Mais um">+</button>
            </div>
          </div>
          <div class="convite-linha-valor">
            <span>${compraEvento.quantidade} × ${escapar(brl(compraEvento.unitario))}</span>
            <b class="destaque-valor">${escapar(brl(total))}</b>
          </div>
        </div>

        <div class="secao-titulo">Como pagar</div>
        <div class="festas-escolha">
          <button type="button" class="festa-chip ${compraEvento.forma === 'pix' ? 'ativo' : ''}" data-forma="pix">
            <span class="nome">Pix</span><span class="preco">sem taxa</span>
          </button>
          <button type="button" class="festa-chip ${compraEvento.forma === 'cartao' ? 'ativo' : ''}" data-forma="cartao">
            <span class="nome">Cartão</span><span class="preco">até 10x</span>
          </button>
        </div>

        ${erro ? `<p class="erro">${escapar(erro)}</p>` : ''}
        <button class="botao" id="seguir" style="margin-top:14px">Continuar</button>
        <p class="rodape-nota" style="margin-top:10px">
          No Pix você paga o valor dos convites, sem acréscimo. No cartão, a operadora cobra taxa e juros, que
          aparecem antes de você confirmar.
        </p>
      </div>
      ${notaRodape()}
    </div>`;

  app.querySelector('#menos').addEventListener('click', () => {
    if (compraEvento.quantidade > 1) compraEvento.quantidade--;
    telaComprarIngresso();
  });
  app.querySelector('#mais').addEventListener('click', () => {
    if (compraEvento.quantidade < 20) compraEvento.quantidade++;
    telaComprarIngresso();
  });
  app.querySelectorAll('[data-forma]').forEach((b) =>
    b.addEventListener('click', () => {
      compraEvento.forma = b.dataset.forma;
      telaComprarIngresso();
    }),
  );
  app.querySelector('#seguir').addEventListener('click', () => telaNomesDosIngressos());
}

/**
 * Os nomes, um por ingresso — obrigatórios.
 *
 * Quem recebeu este link está comprando perto da festa, e a portaria precisa
 * da lista fechada. Pedir aqui, e não depois, é o que impede a compra paga sem
 * nome — que vira trabalho manual para a equipe na véspera.
 */
function telaNomesDosIngressos(erro) {
  const n = compraEvento.quantidade;
  while (compraEvento.nomes.length < n) compraEvento.nomes.push({ nome: '', documento: '', telefone: '' });
  compraEvento.nomes = compraEvento.nomes.slice(0, n);

  app.className = 'entrar';
  app.innerHTML = `
    <div class="entrar-caixa">
      ${marca()}
      <div class="cartao">
        <div class="kicker">${escapar(compraEvento.evento.nome)}</div>
        <h1>Quem vai <span class="grifo">usar</span>?</h1>
        <p class="sub">Um nome por convite. A portaria confere pelo nome e pelo documento, então escreva como está no documento.</p>

        ${compraEvento.nomes.map((c, i) => `
          <div class="convite-item">
            <div class="secao-titulo" style="margin-top:0">Convite ${i + 1}</div>
            <div class="campo">
              <label for="nome-${i}">Nome completo</label>
              <input id="nome-${i}" data-campo="nome" data-i="${i}" value="${escapar(c.nome)}" autocomplete="off" />
            </div>
            <div class="campo">
              <label for="doc-${i}">Documento (opcional)</label>
              <input id="doc-${i}" data-campo="documento" data-i="${i}" value="${escapar(c.documento)}" autocomplete="off" />
            </div>
            <div class="campo">
              <label for="tel-${i}">Telefone (opcional)</label>
              <input id="tel-${i}" data-campo="telefone" data-i="${i}" value="${escapar(c.telefone)}" inputmode="numeric" autocomplete="off" />
            </div>
          </div>`).join('')}

        ${erro ? `<p class="erro">${escapar(erro)}</p>` : ''}
        <button class="botao" id="pagar">Ir para o pagamento</button>
        <button class="link-inline" id="voltar" style="margin-top:10px">voltar</button>
      </div>
      ${notaRodape()}
    </div>`;

  app.querySelectorAll('[data-campo]').forEach((campo) =>
    campo.addEventListener('input', () => {
      compraEvento.nomes[Number(campo.dataset.i)][campo.dataset.campo] = campo.value;
    }),
  );
  app.querySelector('#voltar').addEventListener('click', () => telaComprarIngresso());
  app.querySelector('#pagar').addEventListener('click', async () => {
    const faltando = compraEvento.nomes.filter((c) => c.nome.trim().length < 3).length;
    if (faltando) return telaNomesDosIngressos(`Falta o nome de ${faltando} convidado(s).`);
    await confirmarCompraDoEvento();
  });
}

/** Mostra a conta e cobra. */
async function confirmarCompraDoEvento() {
  app.innerHTML = `<div class="entrar-caixa">${marca()}<div class="cartao"><div class="vazio">Preparando o pagamento…</div></div></div>`;
  const itens = [{ festa: compraEvento.festa, quantidade: compraEvento.quantidade }];

  try {
    const previa = await pedirComAcesso(`/${encodeURIComponent(compraEvento.token)}/simular`, {
      method: 'POST',
      body: JSON.stringify({ itens, forma: compraEvento.forma, parcelasCartao: compraEvento.parcelas }),
    });

    const compra = await pedirComAcesso(`/${encodeURIComponent(compraEvento.token)}/comprar`, {
      method: 'POST',
      body: JSON.stringify({
        itens,
        forma: compraEvento.forma,
        parcelasCartao: compraEvento.parcelas,
        nomes: compraEvento.nomes.map((c) => ({
          nome: c.nome.trim(),
          documento: c.documento.trim() || null,
          telefone: c.telefone.trim() || null,
        })),
      }),
    });

    telaPagamentoDoEvento(compra, previa);
  } catch (e) {
    telaNomesDosIngressos(e.message);
  }
}

/** O Pix ou o cartão, e o caminho para o ingresso depois de pago. */
function telaPagamentoDoEvento(compra, previa) {
  const pix = compra.forma === 'pix';
  app.className = 'entrar';
  app.innerHTML = `
    <div class="entrar-caixa">
      ${marca()}
      <div class="cartao">
        <div class="kicker">${escapar(compraEvento.evento.nome)}</div>
        <h1>${pix ? 'Pague com <span class="grifo">Pix</span>' : 'Pague no <span class="grifo">cartão</span>'}</h1>
        <p class="sub">${compraEvento.quantidade} convite(s) · <b>${escapar(brl(compra.valor))}</b></p>

        ${pix && compra.pixCopiaECola ? `
          <div class="campo">
            <label for="pix">Copie o código e pague no seu banco</label>
            <textarea id="pix" class="pix-codigo" readonly rows="4">${escapar(compra.pixCopiaECola)}</textarea>
          </div>
          <button class="botao" id="copiar">Copiar código Pix</button>
          ${compra.pixExpiraEm ? `<p class="rodape-nota">O código vale até ${escapar(dataCurta(compra.pixExpiraEm))}.</p>` : ''}
        ` : `
          <a class="botao" href="${escapar(compra.url)}" target="_blank" rel="noopener">Abrir o pagamento</a>
        `}

        <p class="rodape-nota" style="margin-top:12px">
          Assim que o pagamento cair, você assina o aditivo por e-mail e o ingresso fica disponível aqui.
          Protocolo da compra guardado — toque em “Já paguei” para conferir.
        </p>
        <button class="botao secundario" id="conferir" style="margin-top:10px">Já paguei, ver meu ingresso</button>
      </div>
      ${notaRodape()}
    </div>`;

  app.querySelector('#copiar')?.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(compra.pixCopiaECola);
      avisar('Código copiado');
    } catch {
      avisar('Copie o código da caixa acima');
    }
  });
  app.querySelector('#conferir').addEventListener('click', () => telaIngressoDoEvento(compra.compraId));
}

/** O ingresso: protocolo, códigos e o PDF. */
async function telaIngressoDoEvento(compraId) {
  app.innerHTML = `<div class="entrar-caixa">${marca()}<div class="cartao"><div class="vazio">Buscando seu ingresso…</div></div></div>`;

  let c;
  try {
    c = await pedirComAcesso(`/${encodeURIComponent(compraEvento.token)}/compra/${encodeURIComponent(compraId)}`);
  } catch (e) {
    app.innerHTML = `<div class="entrar-caixa">${marca()}<div class="cartao">
      <h1>Ainda <span class="grifo">não</span></h1>
      <p class="sub">${escapar(e.message)}</p>
      <button class="botao" id="tentar">Tentar de novo</button></div>${notaRodape()}</div>`;
    app.querySelector('#tentar').addEventListener('click', () => telaIngressoDoEvento(compraId));
    return;
  }

  const pago = !!c.pagoEm;
  app.className = 'entrar';
  app.innerHTML = `
    <div class="entrar-caixa">
      ${marca()}
      <div class="cartao">
        <div class="kicker">Protocolo ${escapar(c.protocolo)}</div>
        <h1>${pago ? 'Ingresso <span class="grifo">confirmado</span>' : 'Pagamento <span class="grifo">pendente</span>'}</h1>
        <p class="sub">${escapar(c.festa.nome)} · ${escapar(c.festa.data ? dataLonga(c.festa.data) : 'data a confirmar')}</p>

        ${!pago ? `
          <div class="faixa alerta"><div>
            Ainda não recebemos a confirmação do pagamento. Se você acabou de pagar, aguarde alguns minutos e
            atualize esta página.
          </div></div>` : ''}

        ${c.assinaturaUrl && !c.assinadoEm ? `
          <div class="faixa"><div>
            Falta <b>assinar o aditivo</b> — ele formaliza a compra no seu contrato.
            <br><a class="link-inline" href="${escapar(c.assinaturaUrl)}" target="_blank" rel="noopener">assinar agora</a>
          </div></div>` : ''}

        ${c.ingressos.map((i) => `
          <div class="convite-item">
            <div class="convite-cab">
              <div>
                <b>${escapar(i.convidado)}</b>
                ${i.documento ? `<span class="convite-sub">${escapar(i.documento)}</span>` : ''}
              </div>
              <code class="pix-codigo" style="font-size:1.05rem">${escapar(i.codigo)}</code>
            </div>
          </div>`).join('')}

        <button class="botao" id="baixar" style="margin-top:12px">Baixar ingresso em PDF</button>
        <button class="link-inline" id="atualizar" style="margin-top:10px">atualizar</button>

        <p class="rodape-nota" style="margin-top:10px">
          Apresente o ingresso na entrada, impresso ou na tela do celular.
          ${c.festa.regrasEntrada ? escapar(c.festa.regrasEntrada) : ''}
        </p>
      </div>
      ${notaRodape()}
    </div>`;

  app.querySelector('#atualizar').addEventListener('click', () => telaIngressoDoEvento(compraId));
  app.querySelector('#baixar').addEventListener('click', async () => {
    try {
      const base = baseEventoPublico();
      const r = await fetch(`${base}/${encodeURIComponent(compraEvento.token)}/compra/${encodeURIComponent(compraId)}/pdf`, {
        headers: { authorization: `Bearer ${compraEvento.acesso}` },
      });
      if (!r.ok) throw new Error('falha');
      const blob = await r.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `ingresso-${c.protocolo}.pdf`;
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      avisar('Não foi possível gerar o PDF agora');
    }
  });
}
