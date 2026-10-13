// ---------------------------------------------------------------------------
// LIGAÇÃO COM A API REAL DO CRM — /api/area-formando/* (25/09/2026)
//
// O portal nasceu sobre dados de exemplo e fala o dialeto do protótipo
// (`/auth/otp/solicitar`, resposta crua). O CRM responde no padrão dele
// (`/auth/codigo`, envelope `{ success, data }`). A tradução vive AQUI, num
// arquivo só, para o resto do app não saber de qual lado veio o dado — e para
// sumir sem deixar rastro quando o protótipo deixar de existir.
//
// LIGA/DESLIGA: `window.API_URL`. Sem ela, nada muda — o portal segue na
// demonstração. Com ela, passa a ler dados reais.
//
// O QUE A API AINDA NÃO TEM (e por isso a tela mostra menos): boleto único,
// 2ª via e os encargos de atraso. Cada um entra no CRM com a sua trava; até lá
// o adaptador devolve vazio em vez de inventar.
// ---------------------------------------------------------------------------

(function () {
  const BASE = window.API_URL;
  if (!BASE) return;

  const url = (caminho) => `${String(BASE).replace(/\/$/, '')}${caminho}`;

  /** O CRM responde { success, data } — o app espera o conteúdo direto. */
  async function pedir(metodo, caminho, corpo, token) {
    const r = await fetch(url(caminho), {
      method: metodo,
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      ...(corpo ? { body: JSON.stringify(corpo) } : {}),
    });
    const envelope = await r.json().catch(() => ({}));
    if (!r.ok) {
      const erro = new Error(envelope.message || 'falha');
      erro.status = r.status;
      // O CRM já responde em português e explicando ("a 2ª via vence em até 5
      // dias"). Guardar a frase deixa a tela mostrar ISSO em vez de um "não foi
      // possível" genérico — o protótipo devolvia códigos, e o app traduzia.
      if (envelope.message) erro.detalhe = envelope.message;
      // Alguns erros não são "deu errado", são "falta um dado seu": o CRM manda
      // um código em `data` e a tela reage a ele (pedir o endereço, por
      // exemplo) em vez de só mostrar a frase. O código não muda quando alguém
      // melhora o texto — por isso não dá para decidir pela mensagem.
      if (envelope.data && envelope.data.codigo) {
        erro.codigo = envelope.data.codigo;
        erro.falta = envelope.data.falta || [];
      }
      throw erro;
    }
    return envelope.data ?? {};
  }

  /**
   * Envio de arquivo. O portal lê o comprovante como data URL (era o que o
   * protótipo guardava); o CRM quer `multipart`, como todo upload dele. A
   * conversão mora aqui — o app continua sem saber do outro lado.
   */
  async function enviarArquivo(caminho, corpo, token) {
    const blob = await (await fetch(corpo.conteudo)).blob();
    const forma = new FormData();
    forma.append('comprovante', blob, corpo.arquivo || 'comprovante');
    // O que o formando escreveu junto ("paguei no caixa"): fica guardado com o
    // arquivo, porque é o contexto que o atendimento lê depois.
    if (corpo.observacao) forma.append('observacao', corpo.observacao);
    // Sem `content-type` de propósito: quem monta o limite do multipart é o
    // navegador, e escrever o cabeçalho na mão quebra o parse no servidor.
    const r = await fetch(url(caminho), {
      method: 'POST',
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: forma,
    });
    const envelope = await r.json().catch(() => ({}));
    if (!r.ok) {
      const erro = new Error(envelope.message || 'falha');
      erro.status = r.status;
      throw erro;
    }
    return envelope.data ?? {};
  }

  /** Destinos vêm mascarados numa lista; a tela mostra por canal. */
  function porCanal(destinos) {
    const lista = Array.isArray(destinos) ? destinos : [];
    return {
      whatsapp: lista.find((d) => !String(d).includes('@')) || null,
      email: lista.find((d) => String(d).includes('@')) || null,
    };
  }

  const dataBR = (iso) => (iso ? String(iso).slice(0, 10) : null);

  /**
   * O comprovante no CRM não tem status: a equipe só consulta, não aprova
   * (decisão de 25/09). Para o FORMANDO, porém, um comprovante anexado está
   * esperando a baixa — que é o que a tela dele chama de "em análise". Traduzir
   * aqui evita espalhar `status || 'em_analise'` por toda a interface.
   */
  const comoOPortalLe = (c) => ({ ...c, status: 'em_analise', analisadoEm: null });

  // ── avisos do sino ─────────────────────────────────────────────────────────
  // NÃO há tabela de notificação: o aviso é derivado do estado atual. Parcela
  // paga some da lista sozinha, pedido respondido idem — e nada fica para trás
  // esperando alguém marcar como resolvido.
  //
  // O "já li" fica no NAVEGADOR (localStorage), não no servidor. É preferência
  // de leitura, não dado do contrato: guardar no banco pediria tabela e rota
  // para algo que só serve a quem está olhando a tela. O preço é que, em outro
  // aparelho, o aviso volta a aparecer como novo.
  const CHAVE_LIDOS = 'area-formando:avisos-lidos';

  function lidos() {
    try { return new Set(JSON.parse(localStorage.getItem(CHAVE_LIDOS) || '[]')); }
    catch { return new Set(); }
  }

  function marcarLidos(ids) {
    try {
      const todos = lidos();
      for (const id of ids) todos.add(String(id));
      // Teto para a lista não crescer para sempre num aparelho só.
      localStorage.setItem(CHAVE_LIDOS, JSON.stringify([...todos].slice(-200)));
    } catch { /* navegador sem storage: os avisos só não ficam marcados */ }
  }

  const diasAteData = (iso) => {
    if (!iso) return null;
    const hoje = new Date();
    hoje.setHours(12, 0, 0, 0);
    return Math.round((new Date(`${iso}T12:00:00`) - hoje) / 86400000);
  };

  const dinheiro = (v) => `R$ ${Number(v || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}`;

  /** Quantos dias antes do vencimento o portal começa a lembrar. */
  const AVISAR_ANTES = 7;

  async function montarAvisos(token) {
    const [fin, ped] = await Promise.all([
      pedir('GET', '/financeiro', null, token).catch(() => ({ boletos: [] })),
      pedir('GET', '/solicitacoes', null, token).catch(() => ({ solicitacoes: [] })),
    ]);

    const itens = [];

    for (const b of fin.boletos || []) {
      if (b.unico) continue;
      const dias = diasAteData(b.vencimento);
      if (b.status === 'em_atraso') {
        itens.push({
          // O id carrega a situação: quando a parcela muda de estado, o aviso
          // vira outro e volta a aparecer como novo — que é o certo.
          id: `atraso:${b.id}`,
          tipo: 'atraso',
          titulo: `Parcela ${b.parcela ?? ''} vencida`.trim(),
          texto: `${dinheiro(b.totalBoleto)} · venceu há ${Math.abs(dias ?? 0)} dia${Math.abs(dias ?? 0) === 1 ? '' : 's'}. Já pagou? Anexe o comprovante.`,
          ir: 'financeiro',
          billId: b.id,
        });
      } else if (b.status === 'em_aberto' && dias !== null && dias >= 0 && dias <= AVISAR_ANTES) {
        itens.push({
          id: `vence:${b.id}:${b.vencimento}`,
          tipo: 'vencimento',
          titulo: dias === 0 ? `Parcela ${b.parcela ?? ''} vence hoje`.trim() : `Parcela ${b.parcela ?? ''} vence em ${dias} dia${dias === 1 ? '' : 's'}`.trim(),
          texto: `${dinheiro(b.totalBoleto)} · o boleto já está disponível.`,
          ir: 'financeiro',
          billId: b.id,
        });
      }
    }

    for (const s of ped.solicitacoes || []) {
      // Só o que MUDOU desde que ele pediu: pedido ainda pendente não é aviso,
      // é o estado normal de quem acabou de pedir.
      if (ABERTOS.includes(s.status)) continue;
      const comoFicou = { concluida: 'foi resolvido', recusada: 'foi recusado', cancelada: 'foi cancelado' }[s.status];
      if (!comoFicou) continue;
      itens.push({
        id: `pedido:${s.id}:${s.status}`,
        tipo: 'pedido',
        titulo: `${s.rotulo || 'Seu pedido'} ${comoFicou}`,
        texto: s.observacao ? `${s.protocolo} · ${s.observacao}` : `${s.protocolo} · abra para ver os detalhes.`,
        ir: 'pedidos',
      });
    }

    const jaLidos = lidos();
    const comLeitura = itens.map((n) => ({ ...n, lida: jaLidos.has(n.id) }));
    // Vencida antes de a vencer, e pedido respondido no topo do que sobra.
    const ordem = { atraso: 0, pedido: 1, vencimento: 2 };
    comLeitura.sort((a, b) => (ordem[a.tipo] ?? 9) - (ordem[b.tipo] ?? 9));

    return { itens: comLeitura, naoLidas: comLeitura.filter((n) => !n.lida).length };
  }

  /** Pedido que ainda dá trabalho para a equipe — os mesmos nomes do CRM. */
  const ABERTOS = ['pendente', 'em_atendimento'];

  /**
   * A composição do boleto único no vocabulário do protótipo.
   *
   * A tela lê `unico.parcelas` e `unico.diasParaVencer`; o CRM devolve a mesma
   * coisa em `itens` e a data pronta.
   */
  const comoOPortalLeOUnico = (r) => ({
    valor: r.subtotal,
    vencimento: r.vencimento,
    taxaBoleto: r.taxaBoleto,
    totalBoleto: r.total,
    economiaTaxa: r.economiaTaxa,
    unico: {
      diasParaVencer: 3,
      parcelas: (r.itens || []).map((i) => ({
        id: i.billId,
        parcela: i.parcela,
        vencimento: i.vencimento,
        vencida: i.vencida,
        valorDaParcela: i.valorDaParcela,
        valor: i.valor,
        encargos: i.encargos,
      })),
    },
  });

  /**
   * Uma cobrança, no vocabulário do portal.
   *
   * `valorDevido` é o que se paga SEM a taxa administrativa — o protótipo
   * separa as duas coisas para a tela poder dizer "inclui R$ 2,90 de taxa". Na
   * vencida esse valor já vem com o juro de mora, e é por isso que ele não pode
   * ser a parcela limpa: o boleto antigo ficou desatualizado, e pagar por ele
   * deixa a dívida de pé.
   */
  /**
   * Os encargos no formato que a tela conhece.
   *
   * Até a API nova subir, o CRM responde com os campos da regra antiga. Sem
   * esta tradução a composição do atraso mostraria a parcela como R$ 0,00.
   */
  const comoOsEncargosSaoHoje = (e) => (e ? { ...e, valorParcela: e.valorParcela ?? e.valorComPontualidade ?? 0 } : e);

  const doBoleto = (b) => ({
    ...b,
    encargosHoje: comoOsEncargosSaoHoje(b.encargosHoje),
    encargos: comoOsEncargosSaoHoje(b.encargos),
    valorDevido: Math.round(((b.totalBoleto || 0) - (b.taxaBoleto || 0)) * 100) / 100,
    // `url` é a fatura na operadora: é POR ELA que o formando paga (código de
    // barras e PDF — a casa não trabalha com Pix). Sem este mapeamento a tela
    // mostrava a parcela e não oferecia nenhuma forma de pagar.
    urlPagamento: b.url || null,
    // `unico`/`unicoAtivo` vêm da API desde 28/09 (mig 947): um diz que a
    // cobrança É o boleto único, o outro que a parcela está dentro de um.
    // `qtdComprovantes` vem da API desde 25/09 — é o que acende o selo
    // "Comprovante enviado" e o que faz a vencida virar "em análise".
    qtdComprovantes: b.qtdComprovantes || 0,
    contestacao: null,
  });

  /**
   * Tradução de uma chamada do protótipo para a API do CRM.
   * Devolve `undefined` quando a rota ainda não existe lá — quem chama decide
   * o que fazer (as telas dessas partes ficam escondidas).
   */
  async function traduzir(metodo, caminho, corpo, token) {
    // ── login ────────────────────────────────────────────────────────────────
    if (caminho === '/auth/otp/solicitar') {
      const r = await pedir('POST', '/auth/codigo', { cpf: corpo?.cpf }, null);
      // `codigoDev` só vem de ambiente que não é produção, onde nada é enviado —
      // é o que deixa testar o login sem mandar mensagem para o formando.
      if (r.enviado) return { cadastrado: true, destinos: porCanal(r.destinos), codigoDev: r.codigoDev };
      // Em produção a resposta é a mesma exista o CPF ou não: quem não tem
      // cadastro simplesmente não recebe código. Só o que a pessoa pode
      // corrigir volta como motivo.
      if (r.motivo === 'cpf_invalido') throw new Error('cpf_invalido');
      if (r.motivo === 'aguarde') throw new Error('aguarde');
      if (r.motivo === 'muitas_tentativas') throw new Error('muitas_tentativas');
      return { cadastrado: true, destinos: porCanal([]) };
    }

    if (caminho === '/auth/otp/verificar') {
      try {
        const r = await pedir('POST', '/auth/verificar', { cpf: corpo?.cpf, codigo: corpo?.codigo }, null);
        if (r.etapa === 'escolha') {
          return {
            precisaEscolherTurma: true,
            tokenEscolha: r.token,
            turmas: (r.adesoes || []).map((a) => ({
              adesaoId: a.adesaoId,
              turma: a.turma?.codigo || '',
              curso: a.turma?.curso || '',
              cidade: '',
              dataEvento: null,
            })),
          };
        }
        return { token: r.token };
      } catch (err) {
        // A tela sabe falar de código inválido; o resto vira falha genérica.
        throw new Error(err.status === 401 ? 'codigo_invalido' : 'falha');
      }
    }

    if (caminho === '/auth/escolher-turma') {
      const r = await pedir('POST', '/auth/escolher', { adesaoId: corpo?.adesaoId }, token);
      return { token: r.token };
    }

    // ── sessão ───────────────────────────────────────────────────────────────
    if (caminho === '/me') {
      const r = await pedir('GET', '/me', null, token);
      return {
        nome: r.nome,
        primeiroNome: r.primeiroNome,
        curso: r.curso,
        situacao: r.situacao,
        canceladaEm: null,
        turma: {
          codigo: r.turma?.codigo || '',
          rotulo: r.turma?.rotulo || r.turma?.codigo || '',
          instituicao: r.turma?.instituicao || null,
          dataEvento: dataBR(r.turma?.dataEvento),
          cidade: '',
        },
      };
    }

    if (caminho === '/financeiro') {
      // As contestações abertas entram junto: é o selo "Contestada" na lista.
      // Buscar só no detalhe deixava a lista sem o aviso, e o formando abria
      // uma parcela já contestada sem saber.
      const [r, pedidos] = await Promise.all([
        pedir('GET', '/financeiro', null, token),
        pedir('GET', '/solicitacoes', null, token).catch(() => ({ solicitacoes: [] })),
      ]);
      const contestadas = new Map(
        (pedidos.solicitacoes || [])
          .filter((s) => s.tipo === 'contestacao' && s.billId && ABERTOS.includes(s.status))
          .map((s) => [s.billId, { protocolo: s.protocolo, criadoEm: s.criadoEm, motivo: s.mensagem }]),
      );
      const boletos = (r.boletos || []).map((b) => ({ ...doBoleto(b), contestacao: contestadas.get(b.id) || null }));
      const resumo = r.resumo || {};
      return {
        resumo: {
          ...resumo,
          mensalidade: resumo.parcelas ? Math.round((resumo.contratado / resumo.parcelas) * 100) / 100 : 0,
          emAnalise: resumo.emAnalise || 0,
        },
        boletos,
      };
    }

    const umBoleto = caminho.match(/^\/financeiro\/([\w-]+)$/);
    if (umBoleto && metodo === 'GET') {
      // A tela do boleto mostra os comprovantes e a contestação DAQUELA parcela;
      // a API lista os do formando inteiro, então o filtro é aqui.
      const [b, todos, pedidos] = await Promise.all([
        pedir('GET', `/financeiro/${umBoleto[1]}`, null, token),
        pedir('GET', '/comprovantes', null, token).catch(() => ({ comprovantes: [] })),
        pedir('GET', '/solicitacoes', null, token).catch(() => ({ solicitacoes: [] })),
      ]);
      const contestacao = (pedidos.solicitacoes || []).find(
        (s) => s.tipo === 'contestacao' && s.billId === umBoleto[1] && ABERTOS.includes(s.status),
      );
      return {
        ...doBoleto(b),
        comprovantes: (todos.comprovantes || []).filter((c) => c.billId === umBoleto[1]).map(comoOPortalLe),
        historico: [],
        contestacao: contestacao
          ? { protocolo: contestacao.protocolo, criadoEm: contestacao.criadoEm, motivo: contestacao.mensagem }
          : null,
      };
    }

    // ── 2ª via ───────────────────────────────────────────────────────────────
    const simular2via = caminho.match(/^\/financeiro\/([\w-]+)\/segunda-via\/simular$/);
    if (simular2via && metodo === 'POST') {
      // A tela lê a composição direto (valorParcela, juros, total); no CRM ela
      // vem dentro de `encargos`, junto do total já com a taxa.
      const r = await pedir('POST', `/financeiro/${simular2via[1]}/segunda-via/simular`, corpo || {}, token);
      return comoOsEncargosSaoHoje(r.encargos) || {};
    }

    const emitir2via = caminho.match(/^\/financeiro\/([\w-]+)\/segunda-via$/);
    if (emitir2via && metodo === 'POST') {
      const r = await pedir('POST', `/financeiro/${emitir2via[1]}/segunda-via`, corpo || {}, token);
      // No protótipo a parcela mantém o id; aqui a 2ª via é uma cobrança NOVA,
      // e a antiga sai da lista. Quem chama precisa saber qual abrir depois.
      return { ...r, novoBillId: r.novoBillId || null };
    }

    // ── boleto único ─────────────────────────────────────────────────────────
    if (caminho === '/financeiro/antecipar/simular' && metodo === 'POST') {
      return comoOPortalLeOUnico(await pedir('POST', '/financeiro/antecipar/simular', corpo || {}, token));
    }
    if (caminho === '/financeiro/antecipar' && metodo === 'POST') {
      const r = await pedir('POST', '/financeiro/antecipar', corpo || {}, token);
      // A tela abre o boleto recém-criado pelo `id`.
      return { ...comoOPortalLeOUnico(r), id: r.billId, url: r.url };
    }

    // ── comprovante ──────────────────────────────────────────────────────────
    const anexar = caminho.match(/^\/financeiro\/([\w-]+)\/comprovante$/);
    if (anexar && metodo === 'POST') {
      return enviarArquivo(`/financeiro/${anexar[1]}/comprovante`, corpo || {}, token);
    }

    // ── o que ainda não existe no CRM ────────────────────────────────────────
    // Silêncio explícito: melhor a tela não mostrar a seção do que mostrar um
    // dado inventado. Quando a rota nascer, some daqui.
    //
    // ⚠️ Toda rota que o app chama no início PRECISA estar aqui, mesmo vazia: o
    // Início pede /financeiro e /turma juntos, e uma promessa rejeitada trava a
    // entrada inteira — foi o que aconteceu no primeiro teste.
    // A turma vem do CRM desde 29/09, com o cronograma que a equipe preencheu
    // na tela da turma. Antes era montada de /me e o cronograma vinha vazio, o
    // que deixava a aba inteira sem conteúdo.
    if (caminho === '/turma') {
      const t = await pedir('GET', '/turma', null, token);
      // Os campos que só o protótipo tem precisam existir, nem que vazios: a
      // tela faz `cursos.join(...)` sem perguntar, e um undefined aqui derrubava
      // a aba inteira antes de desenhar a primeira linha.
      return {
        ...t,
        dataEvento: dataBR(t.dataEvento),
        rotulo: t.rotulo || t.codigo || '',
        cronograma: t.cronograma || [],
        convites: t.convites || [],
        comissao: t.comissao || [],
        // Quem está na turma (07/10). A API manda só o nome de cada um.
        colegas: t.colegas || [],
        // A lista de cursos só existe quando a turma junta mais de um; repetir
        // aqui o rótulo (que JÁ é o curso) punha "Turma" e "Curso" com o mesmo
        // texto, um embaixo do outro.
        cursos: t.cursos || [],
        // sem cadastro no CRM: a tela esconde o que vier vazio em vez de
        // mostrar "undefined" para o formando
        espaco: t.espaco || '',
        cidade: t.cidade || '',
        consultora: t.consultora || '',
        pacote: t.pacote || '',
        avisos: t.avisos || [],
      };
    }
    // ── pedidos (viram demanda no CRM) ───────────────────────────────────────
    // Multas do contrato e a faixa de hoje, antes do pedido de cancelamento.
    if (caminho === '/cancelamento/condicoes') return pedir('GET', caminho, null, token);

    if (caminho === '/solicitacoes' && metodo === 'POST') {
      try {
        // O corpo do protótipo já é o que a API quer; o resto (motivo,
        // quantidade, tipo de convite) vai inteiro como memória do pedido.
        return await pedir('POST', '/solicitacoes', corpo || {}, token);
      } catch (err) {
        // 409 é a contestação já aberta — a tela sabe falar disso.
        // 409 da contestação tem tela própria; os outros (cancelamento já pedido)
        // chegam com a frase do CRM em `detalhe`.
        if (err.status === 409 && (corpo || {}).tipo === 'contestacao') throw new Error('contestacao_ja_aberta');
        throw err;
      }
    }
    if (caminho === '/solicitacoes') {
      const r = await pedir('GET', '/solicitacoes', null, token);
      return { solicitacoes: r.solicitacoes || [] };
    }

    // ── config ───────────────────────────────────────────────────────────────
    // Sem isto, `estado.config` ficava indefinido e três coisas quebravam sem
    // parecer relacionadas: "Falar com a gente" avisava que o WhatsApp não
    // estava configurado, o recibo tentava baixar um PDF inexistente, e os
    // prazos do contrato citados na tela caíam nos valores embutidos no JS.
    if (caminho === '/config') {
      const r = await pedir('GET', '/config', null, token);
      // O número pode vir nulo enquanto não estiver no ambiente do CRM: a tela
      // esconde o botão em vez de oferecer uma conversa que não abre.
      window.API_RECURSOS.falarComEquipe = Boolean(r.whatsappAtendimento);
      return r;
    }

    // ── contrato ─────────────────────────────────────────────────────────────
    // O CRM não tem rota de contrato para o formando. O que a tela precisa
    // (quanto, em quantas vezes, e o link do termo) sai de /me e /financeiro.
    // Sem isto a aba inteira morria em "não foi possível carregar".
    if (caminho === '/contrato') {
      const [eu, fin] = await Promise.all([
        pedir('GET', '/me', null, token),
        pedir('GET', '/financeiro', null, token),
      ]);
      const resumo = fin.resumo || {};
      return {
        termo: { assinadoEm: null, origem: null, url: null },
        contratoColetivo: { turma: eu.turma?.rotulo || eu.turma?.codigo || '', url: null },
        contratado: {
          total: resumo.contratado || 0,
          parcelas: resumo.parcelas || 0,
          mensalidade: resumo.parcelas ? Math.round((resumo.contratado / resumo.parcelas) * 100) / 100 : 0,
          taxaBoleto: resumo.taxaBoleto || 0,
        },
        convites: [],
        clausulas: [],
      };
    }

    // ── meus dados ───────────────────────────────────────────────────────────
    // O CRM devolve tudo o que a tela precisa, inclusive `lembreteDias`: com
    // quanta antecedência ele é avisado do vencimento hoje (mig 1053). Quem
    // nunca escolheu recebe o padrão da casa, e o CRM já responde com ele.
    if (caminho === '/perfil') {
      return pedir('GET', '/perfil', null, token);
    }

    // A escolha de quando ser lembrado: 1, 3, 5 ou 7 dias antes, ou `null`,
    // que o CRM grava como "não quero".
    if (caminho === '/perfil/lembrete' && metodo === 'POST') {
      return pedir('POST', '/perfil/lembrete', corpo || {}, token);
    }

    if (caminho === '/perfil/contato' && (metodo === 'POST' || metodo === 'PATCH')) {
      return pedir('PATCH', '/perfil/contato', corpo || {}, token);
    }

    // O endereço é o que faz a operadora mostrar o boleto. Quem assinou antes de
    // o link exigir os campos separados informa aqui, e a resposta já diz se a
    // operadora foi atualizada.
    if (caminho === '/perfil/endereco' && (metodo === 'POST' || metodo === 'PATCH')) {
      return pedir('PATCH', '/perfil/endereco', corpo || {}, token);
    }

    // Informe de pagamentos do ano: a lista de anos. O PDF de cada ano não passa
    // por aqui — download vai direto, por `urlDoArquivo`.
    if (caminho === '/informe-ir') return pedir('GET', '/informe-ir', null, token);

    // ── extrato ──────────────────────────────────────────────────────────────
    // O CRM não tem rota de extrato: ele é um recorte do que /financeiro já
    // devolve. Montar aqui evita uma rota que só existiria para reempacotar
    // dado — e sem isto a tela "Extrato e comprovantes" morria em 501.
    if (caminho === '/extrato') {
      const r = await pedir('GET', '/financeiro', null, token);
      const resumo = r.resumo || {};
      const boletos = (r.boletos || []).filter((b) => !b.unico);
      const pagos = boletos.filter((b) => b.status === 'pago');
      return {
        emitidoEm: new Date().toISOString(),
        contrato: {
          total: resumo.contratado || 0,
          parcelas: resumo.parcelas || boletos.length,
          mensalidade: resumo.parcelas ? Math.round((resumo.contratado / resumo.parcelas) * 100) / 100 : 0,
          // O CRM guarda a data da assinatura na adesão, não no financeiro.
          assinadoEm: null,
        },
        totais: {
          parcelasPagas: resumo.parcelasPagas || pagos.length,
          pago: resumo.pago || 0,
          emAberto: Math.round(((resumo.emAberto || 0) + (resumo.emAtraso || 0) + (resumo.emAnalise || 0) + (resumo.aEmitir || 0)) * 100) / 100,
        },
        pagamentos: pagos.map((b) => ({
          parcela: b.parcela,
          vencimento: b.vencimento,
          pagoEm: b.pagoEm,
          valor: b.totalBoleto,
        })),
      };
    }

    // ── avisos (o sino) ──────────────────────────────────────────────────────
    // Decisão da equipe (29/09): o sino avisa duas coisas — fatura em aberto e
    // resposta a um pedido feito à equipe. Os dois saem do que a API já
    // devolve, então não há rota nova nem tabela: o aviso é DERIVADO do estado.
    // Parcela paga some sozinha da lista; pedido respondido idem.
    if (caminho === '/notificacoes') return montarAvisos(token);

    if (caminho === '/notificacoes/lidas' && metodo === 'POST') {
      marcarLidos(corpo?.ids || []);
      return montarAvisos(token);
    }
    if (caminho === '/comprovantes') {
      const r = await pedir('GET', '/comprovantes', null, token);
      return { comprovantes: (r.comprovantes || []).map(comoOPortalLe) };
    }
    if (caminho === '/solicitacoes') return { solicitacoes: [] };

    const naoImplementada = new Error('indisponivel_no_crm');
    naoImplementada.status = 501;
    throw naoImplementada;
  }

  /**
   * O que a API do CRM ainda NÃO faz. A tela esconde essas ações em vez de
   * oferecer um botão que dá erro — foi o que acontecia com "Gerar 2ª via",
   * que chamava uma rota inexistente e morria na cara do formando.
   *
   * Cada uma some daqui quando a rota nascer, e a tela volta sozinha.
   */
  window.API_RECURSOS = {
    // O CRM não tem rota de PDF do boleto: a cobrança real abre pelo link da
    // operadora, e a da turma de simulação não tem documento — só a linha.
    pdfDoBoleto: false,
    segundaVia: true,
    boletoUnico: true,
    encargos: true,
    editarContato: true,
    // O endereço o formando informa sozinho, e ele sobe para a operadora na
    // hora — é o que destrava o boleto de quem assinou sem endereço completo.
    editarEndereco: true,
    // Recibo da parcela paga em PDF (05/10/2026): o CRM gera com a data que a
    // operadora confirmou. Sai como comprovante, sem CNPJ, enquanto a equipe não
    // define qual empresa do grupo emite a cobrança da formatura.
    recibo: true,
    // A lista de formandos da turma em PDF (09/10/2026): os nomes da tela
    // separados por curso, com o telefone ao lado — este o CRM só põe no papel,
    // a tela continua sem contato de colega.
    listaDaTurmaPdf: true,
    // Ligado pela resposta de /config, que diz se há número de atendimento.
    falarComEquipe: false,
    // Informe de pagamentos do ano (05/10/2026). O CNPJ que faltava foi
    // decidido: o da CONTRATADA, a mesma empresa do contrato de adesão. A soma
    // é pelo regime de caixa, com o que a operadora confirmou.
    informeIr: true,
    // O sino avisa fatura em aberto e resposta a pedido (decisão de 29/09).
    notificacoes: true,
    // Lembrete de vencimento: o job já existe e a preferência de cada um tem
    // onde morar (mig 1053, aplicada em 09/10), mas a ROTA que grava a escolha
    // está só na dev. Ligar isto antes de ela chegar em produção põe no ar um
    // botão que morre em erro. Vira `true` no dia do deploy do dev→master.
    //
    // No protótipo e na demonstração a seção continua aparecendo: lá não existe
    // `API_RECURSOS`, e é assim que dá para testar a tela antes do deploy.
    lembrete: false,
    // Confirmar presença e convites nomeados: sem lugar no CRM para cadastrar.
    presenca: false,
    convites: false,
  };

  window.API_CRM = traduzir;
})();
