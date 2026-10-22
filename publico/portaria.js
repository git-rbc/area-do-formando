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
   ─────────────────────────────────────────────────────────────────────────── */

const PORTARIA = {
  /** A chave de quem está marcado, no aparelho. */
  entradas: new Map(),
  /** O que ainda não subiu: clienteId → {chave, entrouEm} ou {extra}. */
  fila: new Map(),
  lista: null,
  token: null,
  busca: '',
  subindo: false,
};

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
          entradas: checks.map(([clienteId, v]) => ({ clienteId, chave: v.chave, entrouEm: v.entrouEm })),
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
}

function desenharPortaria() {
  const l = PORTARIA.lista;
  const termo = PORTARIA.busca.trim().toLowerCase();
  const todas = l.pessoas ?? [];
  const pessoas = termo
    ? todas.filter(
        (p) =>
          p.nome.toLowerCase().includes(termo) ||
          (p.de ?? '').toLowerCase().includes(termo) ||
          (p.documento ?? '').includes(termo) ||
          (p.codigo ?? '').toLowerCase().includes(termo),
      )
    : todas;

  const dentro = todas.filter((p) => PORTARIA.entradas.has(p.chave)).length;
  const extras = (l.extras ?? []).length + [...PORTARIA.fila.values()].filter((v) => v.extra).length;

  app.className = 'portaria';
  app.innerHTML = `
    <div class="portaria-topo">
      <div>
        <div class="portaria-festa">${escapar(l.evento.nome)}</div>
        <div class="portaria-sub">
          ${escapar(l.evento.data ? dataLonga(l.evento.data) : '')}
          ${l.evento.local ? ` · ${escapar(l.evento.local)}` : ''}
        </div>
      </div>
      <div class="portaria-placar">
        <b>${dentro + extras}</b> de ${todas.length}
        <span id="portaria-estado" class="portaria-ok">tudo sincronizado</span>
      </div>
    </div>

    <div class="portaria-busca">
      <input id="busca" inputmode="search" placeholder="Procurar por nome, documento ou ingresso"
             value="${escapar(PORTARIA.busca)}" autocomplete="off" />
      <button type="button" class="botao secundario" id="fora-da-lista">Não está na lista</button>
    </div>

    ${(l.semNome ?? []).length ? `
      <div class="portaria-aviso">
        Há convite comprado e ainda sem nome:
        ${(l.semNome ?? []).map((s) => `${escapar(s.formando)} (${s.quantos})`).join(' · ')}.
        Quem chegar dizendo ser convidado de um deles não vai estar na lista.
      </div>` : ''}

    <div class="portaria-lista">
      ${pessoas.length ? pessoas.map((p) => {
        const dentroAgora = PORTARIA.entradas.has(p.chave);
        return `
        <button type="button" class="portaria-pessoa ${dentroAgora ? 'dentro' : ''}" data-chave="${escapar(p.chave)}">
          <span class="marca-check">${dentroAgora ? '✓' : ''}</span>
          <span class="quem">
            <b>${escapar(p.nome)}</b>
            <small>
              ${p.tipo === 'formando' ? `formando · ${escapar(p.turma ?? '')}`
                : p.tipo === 'avulso' ? `convite avulso${p.turma ? ` · ${escapar(p.turma)}` : ''}`
                : `convidado de ${escapar(p.de ?? '')}`}
              ${p.documento ? ` · ${escapar(p.documento)}` : ''}
              ${p.codigo ? ` · ${escapar(p.codigo)}` : ''}
            </small>
          </span>
          ${dentroAgora ? '<span class="hora">entrou</span>' : ''}
        </button>`;
      }).join('') : `<p class="portaria-vazio">${termo ? 'Ninguém com esse nome na lista.' : 'Ninguém nesta festa ainda.'}</p>`}
    </div>

    ${(l.extras ?? []).length ? `
      <div class="portaria-extras">
        <div class="portaria-extras-titulo">Entraram sem estar na lista</div>
        ${(l.extras ?? []).map((e) => `
          <div class="portaria-extra">
            <b>${escapar(e.nome)}</b>
            ${e.documento ? `<small>${escapar(e.documento)}</small>` : ''}
            ${e.observacao ? `<small>${escapar(e.observacao)}</small>` : ''}
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

  app.querySelector('#fora-da-lista').addEventListener('click', () => telaForaDaLista());
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
      await fetch(`${base}/${encodeURIComponent(PORTARIA.token)}/portaria/entradas/${encodeURIComponent(chave)}`, {
        method: 'DELETE',
      });
    } catch {
      // Sem sinal: a próxima atualização da lista traz a verdade do servidor.
    }
    return;
  }

  PORTARIA.entradas.set(chave, new Date().toISOString());
  PORTARIA.fila.set(novoId(), { chave, entrouEm: new Date().toISOString() });
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

// A conexão voltou: sobe o que está esperando.
window.addEventListener('online', () => escoarFila());
// E de tempos em tempos, porque "online" mente em wi-fi de salão: o aparelho
// diz que está conectado antes de a rede realmente responder.
setInterval(() => escoarFila(), 20000);
