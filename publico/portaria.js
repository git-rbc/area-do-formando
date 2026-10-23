/* ───────────────────────────────────────────────────────────────────────────
   A PORTARIA DA FESTA (22/10/2026)

   A equipe de produção abre o link dela no celular, na porta, e confere quem
   entra. Antes disto o que existia era o PDF impresso, riscado à caneta: no
   fim da noite ninguém sabia quantos tinham entrado sem contar risco por
   risco, e o papel de uma porta não via o da outra.

   A INTERNET DO SALÃO NÃO É CONFIÁVEL (dito pelo Dani), e isso manda no
   desenho inteiro:

     · marcar é LOCAL e imediato. O check aparece na hora, sem esperar o
       servidor — na porta, um segundo de espera com fila é um segundo de
       fila;
     · o que foi marcado vai para uma fila no aparelho e sobe quando dá. Se
       o aplicativo for fechado, a fila continua lá;
     · reenviar é o caso NORMAL, não o excepcional: o aparelho não sabe o que
       chegou. Cada marcação leva um id gerado aqui, e o servidor usa esse id
       para não duplicar;
     · a lista carregada fica guardada também. Chegando sem sinal nenhum, a
       portaria abre a última lista que viu em vez de uma tela vazia.

   O que esta tela NÃO faz: vender, alterar cadastro, mostrar contrato. O link
   da portaria abre isto e só isto.

   TUDO DENTRO DE UMA FUNÇÃO (22/10/2026). Este arquivo e o app.js viram
   scripts comuns no mesmo HTML, então dividem o escopo global — e `guardar` e
   `recuperar`, que aqui são da portaria, já existiam lá como atalhos do
   sessionStorage. Redeclarar derrubava o arquivo inteiro na hora de carregar:
   a página ficava em "Carregando a festa…" para sempre, e o app.js chamava
   uma `telaPortaria` que nunca tinha sido definida.

   Lá fora só aparece `telaPortaria`, que é o que o app.js chama.
   ─────────────────────────────────────────────────────────────────────────── */

(function () {
const PORTARIA = {
  /** A chave de quem está marcado, no aparelho. */
  entradas: new Map(),
  /** O que ainda não subiu: clienteId → {chave, entrouEm} ou {extra}. */
  fila: new Map(),
  lista: null,
  token: null,
  busca: '',
  subindo: false,
  /** O aviso dos convites sem nome está aberto? Nasce fechado. */
  verSemNome: false,
  /**
   * Quem da equipe está com este aparelho (22/10/2026).
   *
   * Vai gravado em cada entrada. Com duas ou três portas, a dúvida do dia
   * seguinte — "quem deixou essa pessoa entrar?" — não tinha resposta. Fica
   * no aparelho, não no link: o link é da festa, a pessoa é de quem está
   * segurando o celular.
   */
  operador: null,
  /** `todos` | `falta` | `entrou`. Na porta, quase sempre `falta`. */
  filtro: 'todos',
  /** O laço que busca a lista de novo sozinho. */
  relogio: null,
};

/** O nome de quem está na porta vale para qualquer festa deste aparelho. */
const CHAVE_OPERADOR = 'portaria:operador';

const chaveGuardada = (token) => `portaria:${token}`;

function guardar() {
  try {
    localStorage.setItem(
      chaveGuardada(PORTARIA.token),
      JSON.stringify({
        lista: PORTARIA.lista,
        entradas: [...PORTARIA.entradas.entries()],
        fila: [...PORTARIA.fila.entries()],
        em: new Date().toISOString(),
      }),
    );
  } catch {
    // Aparelho sem espaço ou em aba anônima: a noite continua, só sem a
    // rede de segurança. Não vale travar a porta por isso.
  }
}

function recuperar(token) {
  try {
    const cru = localStorage.getItem(chaveGuardada(token));
    if (!cru) return false;
    const d = JSON.parse(cru);
    PORTARIA.lista = d.lista ?? null;
    PORTARIA.entradas = new Map(d.entradas ?? []);
    PORTARIA.fila = new Map(d.fila ?? []);
    return !!PORTARIA.lista;
  } catch {
    return false;
  }
}

function novoId() {
  if (crypto?.randomUUID) return crypto.randomUUID();
  // Aparelho antigo sem randomUUID: o id só precisa ser único entre os
  // aparelhos da mesma noite.
  return `${Date.now().toString(16)}-${Math.random().toString(16).slice(2, 10)}-4000-8000-${Math.random().toString(16).slice(2, 14)}`;
}

/** Sobe o que está na fila. Falhar é normal; a fila espera a próxima. */
async function escoarFila() {
  if (PORTARIA.subindo || !PORTARIA.fila.size || !navigator.onLine) return;
  PORTARIA.subindo = true;
  const base = baseEventoPublico();
  const t = encodeURIComponent(PORTARIA.token);

  try {
    const checks = [...PORTARIA.fila.entries()].filter(([, v]) => !v.extra);
    if (checks.length) {
      const r = await fetch(`${base}/${t}/portaria/entradas`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          entradas: checks.map(([clienteId, v]) => ({
            clienteId,
            chave: v.chave,
            entrouEm: v.entrouEm,
            marcadoPor: v.marcadoPor ?? null,
          })),
        }),
      });
      if (r.ok) {
        const { data } = await r.json();
        for (const id of data?.aceitos ?? []) PORTARIA.fila.delete(id);
        // Recusado por motivo definitivo sai da fila: insistir não resolve e
        // a fila cresceria para sempre.
        for (const rec of data?.recusados ?? []) PORTARIA.fila.delete(rec.clienteId);
      }
    }

    for (const [clienteId, v] of [...PORTARIA.fila.entries()].filter(([, x]) => x.extra)) {
      const r = await fetch(`${base}/${t}/portaria/extra`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ clienteId, ...v.extra }),
      });
      if (r.ok) PORTARIA.fila.delete(clienteId);
    }
  } catch {
    // Sem sinal: fica para a próxima.
  } finally {
    PORTARIA.subindo = false;
    guardar();
    pintarEstado();
  }
}

/** O aviso de quantos checks ainda não subiram. */
function pintarEstado() {
  const el = document.querySelector('#portaria-estado');
  if (!el) return;
  const n = PORTARIA.fila.size;
  el.textContent = n ? `${n} marcação(ões) esperando internet` : 'tudo sincronizado';
  el.className = n ? 'portaria-pendente' : 'portaria-ok';
}

async function telaPortaria(token, evento) {
  PORTARIA.token = token;
  app.className = 'entrar';

  // QUEM ESTÁ NA PORTA, antes de qualquer coisa. É uma pergunta só, uma vez
  // por aparelho — e sem ela as entradas da noite ficam sem autor.
  try {
    PORTARIA.operador = PORTARIA.operador || localStorage.getItem(CHAVE_OPERADOR) || null;
  } catch {
    // Aba anônima: segue sem guardar, perguntando a cada abertura.
  }
  if (!PORTARIA.operador) return telaQuemEstaNaPorta(token, evento);

  const tinha = recuperar(token);
  app.innerHTML = `<div class="entrar-caixa">${marca()}<div class="cartao"><div class="vazio">${
    tinha ? 'Atualizando a lista…' : 'Carregando a lista…'
  }</div></div></div>`;

  try {
    const nova = await pedirEventoPublico(`/${encodeURIComponent(token)}/portaria`);
    PORTARIA.lista = nova;
    // Quem o servidor já tem como dentro entra no mapa local: dois aparelhos
    // na mesma porta enxergam o mesmo depois de atualizar.
    for (const p of nova.pessoas ?? []) if (p.entrouEm) PORTARIA.entradas.set(p.chave, p.entrouEm);
    guardar();
  } catch (e) {
    if (!PORTARIA.lista) {
      app.innerHTML = `<div class="entrar-caixa">${marca()}<div class="cartao">
        <h1>Não <span class="grifo">carregou</span></h1>
        <p class="sub">${escapar(e.message)}</p>
        <button class="botao" id="tentar">Tentar de novo</button>
      </div>${notaRodape()}</div>`;
      app.querySelector('#tentar').addEventListener('click', () => telaPortaria(token, evento));
      return;
    }
    // Sem sinal, mas com a lista de antes: a porta abre assim mesmo.
  }

  escoarFila();
  desenharPortaria();
  ligarRelogio(token, evento);
}

/**
 * QUEM ESTÁ NA PORTA (22/10/2026).
 *
 * Uma pergunta, uma vez por aparelho. Não é login — na porta não há login, e
 * o que prova que a pessoa é da equipe é ter o endereço do link. É para a
 * entrada ter autor: com três pessoas conferindo, "quem marcou esta?" não
 * tinha resposta no dia seguinte.
 */
function telaQuemEstaNaPorta(token, evento) {
  app.className = 'entrar';
  app.innerHTML = `
    <div class="entrar-caixa">
      ${marca()}
      <div class="cartao">
        <div class="kicker">Portaria</div>
        <h1>Quem está na <span class="grifo">porta</span>?</h1>
        <p class="sub">
          Seu nome fica gravado em cada entrada que você marcar. Perguntamos uma vez só neste aparelho.
        </p>
        <form id="form-quem" novalidate>
          <div class="campo">
            <label for="quem">Seu nome</label>
            <input id="quem" autocomplete="name" placeholder="Camyla" value="${escapar(PORTARIA.operador ?? '')}" />
          </div>
          <p class="erro" id="erro" hidden></p>
          <button class="botao" type="submit">Abrir a lista</button>
        </form>
      </div>
      ${notaRodape()}
    </div>`;

  const campo = app.querySelector('#quem');
  campo.focus();
  app.querySelector('#form-quem').addEventListener('submit', (e) => {
    e.preventDefault();
    const nome = campo.value.trim();
    if (nome.length < 2) {
      const erro = app.querySelector('#erro');
      erro.hidden = false;
      erro.textContent = 'Escreva seu nome para a lista ter autor.';
      return;
    }
    PORTARIA.operador = nome.slice(0, 80);
    try { localStorage.setItem(CHAVE_OPERADOR, PORTARIA.operador); } catch { /* segue sem guardar */ }
    telaPortaria(token, evento);
  });
}

/**
 * A LISTA SE ATUALIZA SOZINHA (22/10/2026).
 *
 * Duas portas com dois celulares só se enxergavam quando alguém recarregava.
 * O banco já recusa a entrada duplicada da mesma pessoa, mas a equipe não
 * via isso na tela — e marcava de novo quem já tinha entrado pela outra
 * porta, achando que a primeira marcação não havia pegado.
 *
 * MEIO MINUTO é o intervalo: a fila da porta anda nesse ritmo, e mais
 * frequente só gastaria a bateria de um aparelho que vai passar a noite
 * ligado.
 *
 * NÃO REDESENHA NO MEIO DE UM TOQUE. Se alguém está digitando na busca ou
 * numa outra tela (fora da lista, relatório), o estado é atualizado e o
 * desenho espera — redesenhar por baixo da mão perderia o que foi digitado.
 */
function ligarRelogio(token, evento) {
  if (PORTARIA.relogio) clearInterval(PORTARIA.relogio);
  PORTARIA.relogio = setInterval(async () => {
    if (!navigator.onLine) return;
    try {
      const nova = await pedirEventoPublico(`/${encodeURIComponent(token)}/portaria`);
      PORTARIA.lista = nova;
      for (const p of nova.pessoas ?? []) if (p.entrouEm) PORTARIA.entradas.set(p.chave, p.entrouEm);
      guardar();
      const digitando = document.activeElement && document.activeElement.id === 'busca';
      if (app.className === 'portaria' && !digitando) desenharPortaria();
    } catch {
      // Sem sinal: a lista de antes continua servindo.
    }
  }, 30000);
}

/**
 * Em que grupo esta pessoa entra.
 *
 * Por TURMA, pedido do Dani: são quatro turmas na mesma porta em 13/11, e a
 * produção fecha o número com cada uma. Os avulsos — convite vendido fora do
 * CRM a quem não é formando — não são de turma nenhuma e ganham o próprio
 * grupo, no fim.
 */
function grupoDe(p) {
  if (p.tipo === 'avulso') return 'Convites avulsos';
  return p.turma || 'Sem turma';
}

/**
 * A lista separada por turma, em ordem alfabética dentro de cada uma.
 *
 * A ordem de dentro vem do servidor e é preservada aqui, porque agrupar não
 * reordena: por nome, com os convites sem nome no fim do bloco de quem os
 * convidou — na porta se procura pelo nome de quem está na frente, e quem
 * não tem nome é achado pelo nome do formando.
 */
function emGrupos(pessoas) {
  const mapa = new Map();
  for (const p of pessoas) {
    const g = grupoDe(p);
    if (!mapa.has(g)) mapa.set(g, []);
    mapa.get(g).push(p);
  }
  return [...mapa.entries()].sort((a, b) => {
    // Os de fora da turma por último: a lista é das turmas.
    const forA = a[0] === 'Convites avulsos' || a[0] === 'Sem turma';
    const forB = b[0] === 'Convites avulsos' || b[0] === 'Sem turma';
    if (forA !== forB) return forA ? 1 : -1;
    return a[0].localeCompare(b[0], 'pt-BR');
  });
}

/**
 * O documento com pontuação: `09991985999` vira `099.919.859-99`.
 *
 * Nem todo cadastro tem a máscara, e na porta se compara o papel com a
 * carteira de identidade, onde o número vem pontuado. Ler onze dígitos
 * corridos atrasa a conferência de quem está com a fila na frente.
 */
function documentoBR(v) {
  const d = String(v ?? '').replace(/\D/g, '');
  if (d.length === 11) return `${d.slice(0, 3)}.${d.slice(3, 6)}.${d.slice(6, 9)}-${d.slice(9)}`;
  return String(v ?? '');
}

/** A hora que a equipe lê é a de Brasília, não a do aparelho em UTC. */
function horaDaEntrada(iso) {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleTimeString('pt-BR', {
      timeZone: 'America/Sao_Paulo',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return '';
  }
}

function desenharPortaria() {
  const l = PORTARIA.lista;
  const termo = PORTARIA.busca.trim().toLowerCase();
  const todas = l.pessoas ?? [];

  const achadas = termo
    ? todas.filter(
        (p) =>
          (p.nome ?? '').toLowerCase().includes(termo) ||
          (p.de ?? '').toLowerCase().includes(termo) ||
          (p.documento ?? '').includes(termo) ||
          (p.codigo ?? '').toLowerCase().includes(termo),
      )
    : todas;

  const dentroDe = (p) => PORTARIA.entradas.has(p.chave);
  const dentro = todas.filter(dentroDe).length;
  const falta = todas.length - dentro;

  // O FILTRO É O QUE ACELERA A PORTA (22/10/2026). Com 101 nomes e fila na
  // frente, rolar a lista inteira para achar quem ainda não chegou é o gasto
  // de tempo que esta tela veio cortar.
  const pessoas =
    PORTARIA.filtro === 'falta' ? achadas.filter((p) => !dentroDe(p))
    : PORTARIA.filtro === 'entrou' ? achadas.filter(dentroDe)
    : achadas;

  const semNomeTotal = (l.semNome ?? []).reduce((soma, sn) => soma + sn.quantos, 0);
  const extras = (l.extras ?? []).length + [...PORTARIA.fila.values()].filter((v) => v.extra).length;
  const grupos = emGrupos(pessoas);

  app.className = 'portaria';
  app.innerHTML = `
    <div class="portaria-topo">
      <div>
        <div class="portaria-festa">${escapar(l.evento.nome)}</div>
        <div class="portaria-sub">
          ${escapar(l.evento.data ? dataLonga(l.evento.data) : '')}
          ${l.evento.hora ? ` · ${escapar(faixaDeHorario(l.evento.hora, l.evento.horaFim))}` : ''}
          ${l.evento.local ? ` · ${escapar(l.evento.local)}` : ''}
        </div>
        <button type="button" class="portaria-eu" id="trocar-operador">
          na porta: <b>${escapar(PORTARIA.operador ?? '')}</b>
        </button>
      </div>
      <div class="portaria-placar">
        <b>${dentro + extras}</b>
        <span class="placar-de">de ${todas.length}</span>
        <span id="portaria-estado" class="portaria-ok">tudo sincronizado</span>
      </div>
    </div>

    <div class="portaria-busca">
      <input id="busca" inputmode="search" placeholder="Procurar por nome, documento ou ingresso"
             value="${escapar(PORTARIA.busca)}" autocomplete="off" />
    </div>

    ${/*
      OS TRÊS FILTROS, com a contagem dentro (22/10/2026). Eles são também o
      placar: "faltam 34" vale mais na porta do que um total que não muda.
    */''}
    <div class="portaria-filtros">
      <button type="button" class="filtro-chip ${PORTARIA.filtro === 'todos' ? 'ativo' : ''}" data-filtro="todos">
        todos <b>${todas.length}</b>
      </button>
      <button type="button" class="filtro-chip ${PORTARIA.filtro === 'falta' ? 'ativo' : ''}" data-filtro="falta">
        falta chegar <b>${falta}</b>
      </button>
      <button type="button" class="filtro-chip ${PORTARIA.filtro === 'entrou' ? 'ativo' : ''}" data-filtro="entrou">
        já entraram <b>${dentro}</b>
      </button>
    </div>

    <div class="portaria-acoes">
      <button type="button" class="botao secundario" id="fora-da-lista">Não está na lista</button>
      <button type="button" class="botao secundario" id="imprimir">Imprimir a lista</button>
      <button type="button" class="botao secundario" id="historico">Histórico</button>
      <button type="button" class="botao secundario" id="relatorio">Fechar a noite</button>
    </div>

    ${(l.semNome ?? []).length ? `
      <div class="portaria-aviso">
        <button type="button" class="aviso-cabeca" id="abrir-sem-nome" aria-expanded="${PORTARIA.verSemNome}">
          <span>
            <b>${semNomeTotal} convite(s) sem nome</b>, de ${(l.semNome ?? []).length} formando(s).
            Quem chegar dizendo ser convidado de um deles aparece na lista como "convidado de".
          </span>
          <span class="aviso-seta">${PORTARIA.verSemNome ? 'ocultar' : 'ver quais'}</span>
        </button>
        ${PORTARIA.verSemNome ? `
          <div class="aviso-nomes">
            ${(l.semNome ?? []).map((sn) => `
              <div class="aviso-nome">
                <span>${escapar(sn.formando)}</span>
                <small>${escapar(sn.turma ?? '')}</small>
                <b>${sn.quantos}</b>
              </div>`).join('')}
          </div>` : ''}
      </div>` : ''}

    <div class="portaria-lista">
      ${grupos.length ? grupos.map(([turma, gente]) => `
        <div class="portaria-turma">
          <span>${escapar(turma)}</span>
          <small>${gente.filter(dentroDe).length} de ${gente.length}</small>
        </div>
        ${gente.map((p) => {
          const dentroAgora = dentroDe(p);
          const quando = horaDaEntrada(PORTARIA.entradas.get(p.chave));
          return `
          <button type="button" class="portaria-pessoa ${dentroAgora ? 'dentro' : ''}" data-chave="${escapar(p.chave)}">
            <span class="marca-check">${dentroAgora ? '✓' : ''}</span>
            <span class="quem">
              ${/*
                O CONVITE SEM NOME tem linha, mas não tem nome para mostrar —
                ninguém o informou. Inventar "convidado 1" encheria a lista de
                dado falso; o que identifica na porta é de quem ele é.
              */''}
              ${p.tipo === 'semnome'
                ? `<b class="sem-nome">Convidado de ${escapar(p.de ?? '')}</b>`
                : `<b>${escapar(p.nome)}</b>`}
              <small>
                ${p.tipo === 'formando' ? 'formando'
                  : p.tipo === 'avulso' ? `convite avulso${p.turma ? ` · ${escapar(p.turma)}` : ''}`
                  : p.tipo === 'semnome' ? 'convite sem nome'
                  : `convidado de ${escapar(p.de ?? '')}`}
                ${p.documento ? ` · ${escapar(p.documento)}` : ''}
                ${p.codigo ? ` · ${escapar(p.codigo)}` : ''}
              </small>
            </span>
            ${dentroAgora ? `
              <span class="hora">
                ${escapar(quando || 'entrou')}
                ${p.marcadoPor ? `<small>${escapar(p.marcadoPor)}</small>` : ''}
              </span>` : ''}
          </button>`;
        }).join('')}
      `).join('') : `<p class="portaria-vazio">${
        termo ? 'Ninguém com esse nome na lista.'
        : PORTARIA.filtro === 'falta' ? 'Todo mundo da lista já entrou.'
        : PORTARIA.filtro === 'entrou' ? 'Ninguém entrou ainda.'
        : 'Ninguém nesta festa ainda.'
      }</p>`}
    </div>

    ${(l.extras ?? []).length ? `
      <div class="portaria-extras">
        <div class="portaria-extras-titulo">Entraram sem estar na lista</div>
        ${(l.extras ?? []).map((e) => `
          <div class="portaria-extra">
            <b>${escapar(e.nome)}</b>
            ${e.documento ? `<small>${escapar(e.documento)}</small>` : ''}
            ${e.observacao ? `<small>${escapar(e.observacao)}</small>` : ''}
            <small>${escapar(horaDaEntrada(e.entrouEm))}${e.marcadoPor ? ` · ${escapar(e.marcadoPor)}` : ''}</small>
          </div>`).join('')}
      </div>` : ''}`;

  pintarEstado();

  const busca = app.querySelector('#busca');
  busca.addEventListener('input', () => {
    PORTARIA.busca = busca.value;
    const pos = busca.selectionStart;
    desenharPortaria();
    const novo = app.querySelector('#busca');
    novo.focus();
    novo.setSelectionRange(pos, pos);
  });

  app.querySelectorAll('[data-chave]').forEach((b) => {
    b.addEventListener('click', () => marcar(b.getAttribute('data-chave')));
  });

  app.querySelectorAll('[data-filtro]').forEach((b) => {
    b.addEventListener('click', () => {
      PORTARIA.filtro = b.getAttribute('data-filtro');
      desenharPortaria();
    });
  });

  app.querySelector('#fora-da-lista').addEventListener('click', () => telaForaDaLista());
  app.querySelector('#imprimir').addEventListener('click', () => imprimirALista());
  app.querySelector('#historico').addEventListener('click', () => telaHistorico());
  app.querySelector('#relatorio').addEventListener('click', () => telaRelatorio());

  // Trocar quem está na porta acontece: a equipe se rende em turnos.
  app.querySelector('#trocar-operador').addEventListener('click', () => {
    PORTARIA.operador = null;
    try { localStorage.removeItem(CHAVE_OPERADOR); } catch { /* segue */ }
    telaQuemEstaNaPorta(PORTARIA.token, null);
  });

  // O aviso nasce fechado: é informação de apoio, e aberta ela empurrava a
  // lista — que é o que a pessoa veio ver — para baixo da dobra.
  app.querySelector('#abrir-sem-nome')?.addEventListener('click', () => {
    PORTARIA.verSemNome = !PORTARIA.verSemNome;
    desenharPortaria();
  });
}

/**
 * Marca ou desmarca alguém.
 *
 * Local e imediato: o check aparece antes de o servidor saber. Desmarcar vai
 * direto ao servidor quando há sinal — é o caso raro e, sem sinal, a
 * marcação sai da fila antes de subir, que dá no mesmo.
 */
async function marcar(chave) {
  const dentro = PORTARIA.entradas.has(chave);

  if (dentro) {
    PORTARIA.entradas.delete(chave);
    for (const [id, v] of PORTARIA.fila) if (v.chave === chave) PORTARIA.fila.delete(id);
    guardar();
    desenharPortaria();
    try {
      const base = baseEventoPublico();
      // QUEM DESMARCOU VAI JUNTO (23/10/2026). É a ação que mais gera dúvida
      // no dia seguinte — "essa pessoa entrou ou foi desmarcada por engano?"
      // —, e sem o autor o histórico responde metade da pergunta.
      //
      // Na query e não no corpo: DELETE com corpo atravessa proxy e
      // biblioteca sem garantia nenhuma.
      const quem = encodeURIComponent(PORTARIA.operador ?? '');
      await fetch(
        `${base}/${encodeURIComponent(PORTARIA.token)}/portaria/entradas/${encodeURIComponent(chave)}?por=${quem}`,
        { method: 'DELETE' },
      );
    } catch {
      // Sem sinal: a próxima atualização da lista traz a verdade do servidor.
    }
    return;
  }

  PORTARIA.entradas.set(chave, new Date().toISOString());
  PORTARIA.fila.set(novoId(), {
    chave,
    entrouEm: new Date().toISOString(),
    marcadoPor: PORTARIA.operador,
  });
  guardar();
  desenharPortaria();
  escoarFila();
}

/** Quem chegou sem estar na lista. */
function telaForaDaLista() {
  app.className = 'entrar';
  app.innerHTML = `
    <div class="entrar-caixa">
      ${marca()}
      <div class="cartao">
        <div class="kicker">${escapar(PORTARIA.lista.evento.nome)}</div>
        <h1>Não está na <span class="grifo">lista</span></h1>
        <p class="sub">
          Registre quem entrou assim mesmo. No dia seguinte alguém vai perguntar quantas pessoas entraram, e a
          resposta precisa incluir estas.
        </p>
        <form id="form-extra" novalidate>
          <div class="campo"><label for="n">Nome</label><input id="n" autocomplete="off" /></div>
          <div class="campo"><label for="d">Documento (opcional)</label><input id="d" autocomplete="off" /></div>
          <div class="campo"><label for="o">Por que entrou (opcional)</label><input id="o" autocomplete="off" placeholder="quem autorizou, de quem é convidado…" /></div>
          <p class="erro" id="erro" hidden></p>
          <button class="botao" type="submit">Registrar entrada</button>
        </form>
        <button class="botao secundario" id="voltar" style="margin-top:10px">Voltar para a lista</button>
      </div>
    </div>`;

  app.querySelector('#voltar').addEventListener('click', () => desenharPortaria());
  app.querySelector('#form-extra').addEventListener('submit', (e) => {
    e.preventDefault();
    const nome = app.querySelector('#n').value.trim();
    if (nome.length < 3) {
      const erro = app.querySelector('#erro');
      erro.hidden = false;
      erro.textContent = 'Escreva o nome de quem entrou.';
      return;
    }
    const extra = {
      nome,
      documento: app.querySelector('#d').value.trim() || null,
      observacao: app.querySelector('#o').value.trim() || null,
      entrouEm: new Date().toISOString(),
      marcadoPor: PORTARIA.operador,
    };
    PORTARIA.fila.set(novoId(), { extra });
    // Entra na lista da tela na hora, antes de subir: quem registrou precisa
    // ver que registrou.
    PORTARIA.lista.extras = [...(PORTARIA.lista.extras ?? []), { id: novoId(), ...extra, entrouEm: extra.entrouEm }];
    guardar();
    desenharPortaria();
    escoarFila();
  });
}

/* ───────────────────────────────────────────────────────────────────────────
   A LISTA IMPRESSA, DE RESERVA (22/10/2026)

   Se a internet do salão cair de vez, ou o aparelho reiniciar, a fila não
   espera. Então a portaria sai de casa com a lista no papel — gerada do
   mesmo dado da tela, na véspera, com um quadradinho para riscar à caneta.

   NÃO É O RELATÓRIO. Esta folha é o plano B da conferência; o fechamento da
   noite é outra coisa e vem do servidor.
   ────────────────────────────────────────────────────────────────────────── */

/**
 * A FOLHA, no padrão das que a casa já imprime (22/10/2026).
 *
 * A primeira versão destas folhas era uma lista corrida com fonte de tela.
 * Isto segue o desenho do PDF que o CRM gera para a portaria desde 15/10 —
 * que é papel de trabalho, não documento de contrato: alguém vai segurar
 * numa prancheta, na porta, com pouca luz e gente esperando.
 *
 * O QUE O PADRÃO MANDA:
 *
 *   · A4 com margem de verdade, para a folha caber na prancheta;
 *   · cabeçalho de tabela que se REPETE em toda página — a folha 3 circula
 *     sozinha, e sem o cabeçalho ninguém sabe o que é cada coluna;
 *   · linha que não se parte no fim da página;
 *   · fonte grande o bastante para ler em pé;
 *   · a contagem no alto, porque é a primeira pergunta de quem recebe a
 *     folha ("quanta gente é?").
 *
 * Fundo e cor saem na impressão (`print-color-adjust: exact`), mas nada
 * depende deles: cada barra do gráfico traz o número ao lado, e as faixas de
 * turma têm borda além do cinza. Impressora preto e branco imprime tudo.
 */
function folhaDeImpressao(titulo, corpo) {
  return `<!doctype html>
    <html lang="pt-BR"><head><meta charset="utf-8" />
    <title>${titulo}</title>
    <style>
      @page { size: A4; margin: 14mm 10mm 16mm; }
      * { box-sizing: border-box; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
      body { font-family: Arial, Helvetica, sans-serif; color: #111; font-size: 11.5pt; margin: 0; }

      /* O cabeçalho da tabela se repete; a linha não se parte. */
      thead { display: table-header-group; }
      tr { page-break-inside: avoid; }

      h1 { font-size: 15pt; margin: 0 0 1mm; line-height: 1.2; }
      .sub { font-size: 10.5pt; color: #333; margin: 0 0 3mm; }

      /* A contagem: primeira pergunta de quem recebe a folha. */
      .contagem {
        display: flex; flex-wrap: wrap; gap: 6mm;
        border-top: 1px solid #999; border-bottom: 1px solid #999;
        padding: 2mm 0; margin-bottom: 4mm; font-size: 9.5pt; color: #333;
      }
      .contagem div { white-space: nowrap; }
      .contagem b { display: block; font-size: 15pt; color: #111; line-height: 1.1; }
      .gerada { font-size: 8.5pt; color: #777; margin: 0 0 4mm; }

      /* A faixa da turma, com borda para sobreviver ao preto e branco. */
      .turma {
        margin: 6mm 0 1.5mm; padding: 1mm 2mm; background: #f0f0f0;
        border-left: 3px solid #111; font-size: 10pt; font-weight: bold;
        display: flex; justify-content: space-between; page-break-after: avoid;
      }
      .turma span.qtd { font-weight: normal; color: #444; }

      table { width: 100%; border-collapse: collapse; margin-bottom: 2mm; }
      th {
        text-align: left; font-size: 8.5pt; text-transform: uppercase; letter-spacing: .04em;
        border-bottom: 1.5px solid #111; padding: 1.5mm 2mm; color: #333;
      }
      td { padding: 2mm; border-bottom: 1px solid #ddd; vertical-align: top; font-size: 10.5pt; }

      /* A coluna do risco: é o que a portaria faz quando o celular não ajuda. */
      .risco { width: 7mm; }
      thead .risco::after { content: '✓'; font-size: 8.5pt; }
      tbody .risco { border: 1px solid #111; height: 5mm; padding: 0; }

      .num { width: 8mm; color: #777; font-size: 9pt; }
      .nome { font-weight: bold; }
      .nome i { font-weight: normal; font-style: normal; font-size: 9pt; color: #666; }
      .pendente { color: #888; font-style: italic; font-weight: normal; }
      .doc { width: 24mm; font-size: 10pt; white-space: nowrap; }
      .cod { width: 22mm; font-family: ui-monospace, Consolas, monospace; font-size: 9pt; color: #555; }
      .de { width: 48mm; font-size: 9.5pt; color: #333; }
      .hora { width: 16mm; font-size: 10pt; white-space: nowrap; }
      .por { width: 26mm; font-size: 9.5pt; color: #333; }
      .meio { text-align: center; }

      /* O gráfico de chegada: a barra é enfeite, o número é o dado. */
      .barra { display: flex; align-items: center; gap: 2mm; }
      .barra .trilho { width: 44mm; height: 3mm; background: #e4e4e4; border: 1px solid #bbb; }
      .barra .trilho i { display: block; height: 100%; background: #555; }

      .assinatura {
        margin-top: 8mm; padding-top: 3mm; border-top: 1px solid #999;
        display: flex; gap: 10mm; font-size: 9.5pt; color: #444;
      }
      .assinatura div { flex: 1; }
      .assinatura u { display: block; margin-top: 6mm; border-top: 1px solid #111; text-decoration: none; }

      .secao { font-size: 12pt; font-weight: bold; margin: 7mm 0 1.5mm; page-break-after: avoid; }
      .nova-pagina { page-break-before: always; }

      @media print { .nao-imprime { display: none; } }
    </style></head>
    <body>${corpo}
      <p class="nao-imprime" style="margin-top:8mm">
        <button onclick="window.print()" style="padding:8px 16px; font-size:14px">Imprimir</button>
      </p>
    </body></html>`;
}

/** Abre a folha numa aba nova. Bloqueador de pop-up é o único jeito de falhar. */
function abrirParaImprimir(html) {
  const aba = window.open('', '_blank');
  if (!aba) return avisar('Libere a janela para imprimir');
  aba.document.write(html);
  aba.document.close();
}

/** O cabeçalho que as duas folhas dividem: festa, quando, onde. */
function cabecaDaFolha(evento, titulo) {
  return `
    <h1>${escapar(evento.nome)}${titulo ? ` — ${escapar(titulo)}` : ''}</h1>
    <div class="sub">
      ${escapar(evento.data ? dataLonga(evento.data) : 'data a definir')}
      ${evento.hora ? ` · ${escapar(faixaDeHorario(evento.hora, evento.horaFim))}` : ''}
      ${evento.local ? ` · ${escapar(evento.local)}` : ''}
    </div>`;
}

/** `22/10/2026, 18:40` — quando a folha saiu, para não conferir por uma velha. */
function agoraBR() {
  try {
    return new Date().toLocaleString('pt-BR', {
      timeZone: 'America/Sao_Paulo',
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return '';
  }
}

/* ───────────────────────────────────────────────────────────────────────────
   A LISTA IMPRESSA, DE RESERVA (22/10/2026)

   Se a internet do salão cair de vez, ou o aparelho reiniciar, a fila não
   espera. Então a portaria sai de casa com a lista no papel — gerada do
   mesmo dado da tela, com um quadradinho para riscar à caneta.

   NÃO É O RELATÓRIO. Esta folha é o plano B da conferência; o fechamento da
   noite é outra coisa e vem do servidor.
   ────────────────────────────────────────────────────────────────────────── */

function imprimirALista() {
  const l = PORTARIA.lista;
  const todas = l.pessoas ?? [];
  const grupos = emGrupos(todas);
  const conta = (tipo) => todas.filter((x) => x.tipo === tipo).length;

  const corpo = `
    ${cabecaDaFolha(l.evento, 'lista da portaria')}

    <div class="contagem">
      <div><b>${todas.length}</b> na lista</div>
      <div><b>${conta('formando')}</b> formandos</div>
      <div><b>${conta('convite')}</b> convidados</div>
      <div><b>${conta('semnome')}</b> sem nome</div>
      ${conta('avulso') ? `<div><b>${conta('avulso')}</b> avulsos</div>` : ''}
    </div>
    <p class="gerada">Folha gerada em ${escapar(agoraBR())} · nomes em ordem alfabética dentro de cada turma</p>

    ${grupos.map(([turma, gente]) => `
      <div class="turma">
        <span>${escapar(turma)}</span>
        <span class="qtd">${gente.length} pessoa(s)</span>
      </div>
      <table>
        <thead>
          <tr>
            <th class="risco"></th>
            <th class="num">#</th>
            <th>Nome</th>
            <th class="doc">Documento</th>
            <th class="cod">Ingresso</th>
            <th class="de">De quem é</th>
          </tr>
        </thead>
        <tbody>
          ${gente.map((pes, i) => `
            <tr>
              <td class="risco"></td>
              <td class="num">${i + 1}</td>
              ${/*
                UMA LINHA POR PESSOA (22/10/2026).

                A primeira versão escrevia "formando" embaixo de cada nome —
                e como dois terços da lista são formandos, isso dobrava a
                altura de quase toda linha e o número de folhas na
                prancheta. A informação já está na coluna ao lado: "de quem
                é" vazio quer dizer que a pessoa é da turma.

                O rótulo fica só onde ele acrescenta: o convite avulso, que
                não é formando nem convidado de ninguém.
              */''}
              <td class="nome">
                ${pes.tipo === 'semnome'
                  ? '<span class="pendente">— sem nome —</span>'
                  : escapar(pes.nome)}
                ${pes.tipo === 'avulso' ? ' <i>convite avulso</i>' : ''}
              </td>
              <td class="doc">${escapar(documentoBR(pes.documento))}</td>
              <td class="cod">${escapar(pes.codigo ?? '')}</td>
              <td class="de">${escapar(pes.de ?? '')}</td>
            </tr>`).join('')}
        </tbody>
      </table>
    `).join('')}

    <div class="assinatura">
      <div>Conferido por<u></u></div>
      <div>Porta<u></u></div>
      <div>Total que entrou<u></u></div>
    </div>`;

  abrirParaImprimir(folhaDeImpressao('Lista da portaria', corpo));
}

/* ───────────────────────────────────────────────────────────────────────────
   O HISTÓRICO DE EDIÇÕES (23/10/2026)

   A lista diz quem ESTÁ dentro. Não dizia o que foi feito: desmarcar apaga
   a linha, e com ela o fato de que alguém chegou a ser marcado. Com três
   pessoas conferindo ao mesmo tempo, "fulano entrou ou foi desmarcado por
   engano?" não tinha resposta.

   Do mais recente para o mais antigo, que é a ordem em que a dúvida
   aparece — quase sempre se procura o que acabou de acontecer.
   ────────────────────────────────────────────────────────────────────────── */

const ROTULO_DA_ACAO = {
  entrou: 'entrou',
  desfez: 'desmarcado',
  fora_da_lista: 'fora da lista',
};

async function telaHistorico() {
  app.className = 'entrar';
  app.innerHTML = `<div class="entrar-caixa">${marca()}<div class="cartao"><div class="vazio">Buscando o histórico…</div></div></div>`;

  let atos;
  try {
    atos = await pedirEventoPublico(`/${encodeURIComponent(PORTARIA.token)}/portaria/historico`);
  } catch (e) {
    app.innerHTML = `<div class="entrar-caixa">${marca()}<div class="cartao">
      <h1>Não <span class="grifo">carregou</span></h1>
      <p class="sub">${escapar(e.message)} O histórico precisa de internet — a conferência na porta, não.</p>
      <button class="botao" id="voltar">Voltar para a lista</button>
    </div></div>`;
    app.querySelector('#voltar').addEventListener('click', () => desenharPortaria());
    return;
  }

  const lista = Array.isArray(atos) ? atos : [];
  app.innerHTML = `
    <div class="entrar-caixa">
      ${marca()}
      <div class="cartao">
        <div class="kicker">${escapar(PORTARIA.lista?.evento?.nome ?? 'Portaria')}</div>
        <h1>O que foi <span class="grifo">feito</span></h1>
        <p class="sub">
          ${lista.length
            ? `${lista.length} registro(s), do mais recente para o mais antigo.`
            : 'Nada foi marcado ainda nesta festa.'}
        </p>

        ${lista.map((a) => `
          <div class="hist-linha">
            <span class="hist-hora">${escapar(horaDaEntrada(a.em))}</span>
            <span class="hist-quem">
              <b>${escapar(a.nome || 'sem nome')}</b>
              <small>${escapar(ROTULO_DA_ACAO[a.acao] ?? a.acao)}${a.por ? ` · ${escapar(a.por)}` : ''}</small>
            </span>
          </div>`).join('')}

        <button class="botao" id="voltar" style="margin-top:14px">Voltar para a lista</button>
      </div>
      ${notaRodape()}
    </div>`;

  app.querySelector('#voltar').addEventListener('click', () => desenharPortaria());
}

/* ───────────────────────────────────────────────────────────────────────────
   O FECHAMENTO DA NOITE (22/10/2026)

   No dia seguinte alguém pergunta quantas pessoas entraram, quem não veio e
   se houve gente fora da lista. Vem do servidor, somado da mesma lista — dois
   jeitos de contar dariam dois números, e aí ninguém sabe qual acreditar.

   Dá para abrir no meio da festa: aí é o parcial, que é o que a produção
   quer saber às 23h.
   ────────────────────────────────────────────────────────────────────────── */

async function telaRelatorio() {
  app.className = 'entrar';
  app.innerHTML = `<div class="entrar-caixa">${marca()}<div class="cartao"><div class="vazio">Somando a noite…</div></div></div>`;

  let r;
  try {
    r = await pedirEventoPublico(`/${encodeURIComponent(PORTARIA.token)}/portaria/relatorio`);
  } catch (e) {
    app.innerHTML = `<div class="entrar-caixa">${marca()}<div class="cartao">
      <h1>Não <span class="grifo">carregou</span></h1>
      <p class="sub">${escapar(e.message)} O fechamento precisa de internet — a conferência na porta, não.</p>
      <button class="botao" id="voltar">Voltar para a lista</button>
    </div></div>`;
    app.querySelector('#voltar').addEventListener('click', () => desenharPortaria());
    return;
  }

  const maior = Math.max(1, ...r.pico.map((f) => f.quantos));

  app.innerHTML = `
    <div class="entrar-caixa">
      ${marca()}
      <div class="cartao">
        <div class="kicker">${escapar(r.evento.nome)}</div>
        <h1>A <span class="grifo">noite</span></h1>
        <p class="sub">
          ${escapar(r.evento.data ? dataLonga(r.evento.data) : '')} ·
          fechado às ${escapar(horaDaEntrada(r.geradoEm))}
        </p>

        <div class="rel-numeros">
          <div><b>${r.totais.entraram}</b><span>entraram</span></div>
          <div><b>${r.totais.naoVieram}</b><span>não vieram</span></div>
          <div><b>${r.totais.extras}</b><span>fora da lista</span></div>
          <div><b>${r.totais.porcentagem}%</b><span>da lista</span></div>
        </div>

        <div class="secao-titulo">Por turma</div>
        ${r.porTurma.map((x) => `
          <div class="ja-ingresso">
            <span>${escapar(x.turma)}</span>
            <code>${x.entraram} de ${x.previstos}</code>
          </div>`).join('')}

        ${r.pico.length ? `
          <div class="secao-titulo">Quando chegaram</div>
          <div class="rel-pico">
            ${r.pico.map((f) => `
              <div class="pico-barra">
                <span class="pico-hora">${escapar(f.faixa)}</span>
                <span class="pico-trilho"><i style="width:${Math.round((f.quantos / maior) * 100)}%"></i></span>
                <b>${f.quantos}</b>
              </div>`).join('')}
          </div>` : ''}

        <button class="botao" id="imprimir-rel" style="margin-top:14px">Imprimir o fechamento</button>
        <button class="botao secundario" id="voltar" style="margin-top:10px">Voltar para a lista</button>
      </div>
      ${notaRodape()}
    </div>`;

  app.querySelector('#voltar').addEventListener('click', () => desenharPortaria());
  app.querySelector('#imprimir-rel').addEventListener('click', () => imprimirRelatorio(r));
}

function imprimirRelatorio(r) {
  const maior = Math.max(1, ...r.pico.map((f) => f.quantos));

  /** Uma tabela de gente, com ou sem as colunas da entrada. */
  const tabela = (lista, comHora) => `
    <table>
      <thead>
        <tr>
          <th class="num">#</th>
          <th>Nome</th>
          <th class="de">Turma</th>
          <th class="de">O que é</th>
          ${comHora ? '<th class="hora">Entrou</th><th class="por">Marcado por</th>' : ''}
        </tr>
      </thead>
      <tbody>
        ${lista.map((x, i) => `
          <tr>
            <td class="num">${i + 1}</td>
            <td class="nome">${escapar(x.nome)}</td>
            <td class="de">${escapar(x.turma ?? '')}</td>
            <td class="de">${escapar(
              x.tipo === 'semnome' ? 'convite sem nome'
              : x.tipo === 'convite' ? `convidado de ${x.de ?? ''}`
              : x.tipo === 'avulso' ? 'convite avulso'
              : 'formando',
            )}</td>
            ${comHora ? `<td class="hora">${escapar(x.hora ?? '')}</td><td class="por">${escapar(x.marcadoPor ?? '—')}</td>` : ''}
          </tr>`).join('')}
      </tbody>
    </table>`;

  const corpo = `
    ${cabecaDaFolha(r.evento, 'fechamento da noite')}

    <div class="contagem">
      <div><b>${r.totais.entraram}</b> entraram</div>
      <div><b>${r.totais.naoVieram}</b> não vieram</div>
      <div><b>${r.totais.extras}</b> fora da lista</div>
      <div><b>${r.totais.porcentagem}%</b> da lista</div>
      <div><b>${r.totais.previstos}</b> previstos</div>
    </div>
    <p class="gerada">Fechamento gerado em ${escapar(agoraBR())}</p>

    <div class="secao">Por turma</div>
    <table>
      <thead>
        <tr><th>Turma</th><th class="meio">Entraram</th><th class="meio">Previstos</th><th class="meio">Faltaram</th></tr>
      </thead>
      <tbody>
        ${r.porTurma.map((x) => `
          <tr>
            <td class="nome">${escapar(x.turma)}</td>
            <td class="meio">${x.entraram}</td>
            <td class="meio">${x.previstos}</td>
            <td class="meio">${x.previstos - x.entraram}</td>
          </tr>`).join('')}
      </tbody>
    </table>

    ${r.pico.length ? `
      <div class="secao">Quando chegaram</div>
      <table>
        <thead><tr><th class="hora">Faixa</th><th>Entradas</th></tr></thead>
        <tbody>
          ${r.pico.map((f) => `
            <tr>
              <td class="hora">${escapar(f.faixa)}</td>
              <td>
                <span class="barra">
                  <span class="trilho"><i style="width:${Math.round((f.quantos / maior) * 100)}%"></i></span>
                  <b>${f.quantos}</b>
                </span>
              </td>
            </tr>`).join('')}
        </tbody>
      </table>` : ''}

    ${r.extras.length ? `
      <div class="secao">Entraram sem estar na lista (${r.extras.length})</div>
      <table>
        <thead>
          <tr><th class="num">#</th><th>Nome</th><th class="doc">Documento</th><th>Por que entrou</th><th class="hora">Entrou</th></tr>
        </thead>
        <tbody>
          ${r.extras.map((e, i) => `
            <tr>
              <td class="num">${i + 1}</td>
              <td class="nome">${escapar(e.nome)}</td>
              <td class="doc">${escapar(documentoBR(e.documento))}</td>
              <td class="de">${escapar(e.observacao ?? '')}</td>
              <td class="hora">${escapar(horaDaEntrada(e.entrouEm))}</td>
            </tr>`).join('')}
        </tbody>
      </table>` : ''}

    <div class="secao">Entraram (${r.entraram.length})</div>
    ${r.entraram.length ? tabela(r.entraram, true) : '<p class="gerada">Ninguém entrou ainda.</p>'}

    <div class="secao nova-pagina">Não vieram (${r.naoVieram.length})</div>
    ${r.naoVieram.length ? tabela(r.naoVieram, false) : '<p class="gerada">Todo mundo da lista entrou.</p>'}`;

  abrirParaImprimir(folhaDeImpressao('Fechamento da noite', corpo));
}

// A conexão voltou: sobe o que está esperando.
window.addEventListener('online', () => escoarFila());
// E de tempos em tempos, porque "online" mente em wi-fi de salão: o aparelho
// diz que está conectado antes de a rede realmente responder.
setInterval(() => escoarFila(), 20000);

// A única porta para fora. O app.js chama isto quando o link é de portaria.
window.telaPortaria = telaPortaria;
})();
