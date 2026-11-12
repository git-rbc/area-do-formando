// Área do Formando — servidor local de testes.
//
// Node puro, sem dependências. Sobe os endpoints da Parte 4 do plano
// (PLANO-Area-do-Formando.html) contra os dados de exemplo em dados/exemplo.json,
// e serve o front de publico/.
//
//   node servidor.mjs            -> http://localhost:4173
//   PORTA=5000 node servidor.mjs
//
// Nada aqui toca banco, Vindi, e-mail ou WhatsApp. O código de acesso é exibido
// na tela e no terminal, porque MODO_DEV está ligado.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const AQUI = path.dirname(fileURLToPath(import.meta.url));
const PORTA = Number(process.env.PORTA || 4173);
const MODO_DEV = process.env.MODO_DEV !== '0';
const SEGREDO = crypto.randomBytes(32); // novo a cada boot: reiniciar derruba as sessões
const TTL_TOKEN = 30 * 60 * 1000;

const DADOS = JSON.parse(fs.readFileSync(path.join(AQUI, 'dados', 'exemplo.json'), 'utf8'));
const HOJE = DADOS.hojeSimulado || new Date().toISOString().slice(0, 10);

// Regras da Parte 6 do plano.
// Teto por HORA (11/11/2026), o mesmo do CRM: 5 códigos em qualquer janela de 1 hora.
const OTP = { expiraMs: 10 * 60 * 1000, tentativas: 5, tetoNaHora: 5, horaMs: 60 * 60 * 1000, janelaMs: 60 * 1000 };

// Estado em memória (equivale a formatura_otp_codes, formatura_acessos,
// formatura_solicitacoes). Some quando o servidor reinicia.
const codigos = new Map();      // cpf -> { hash, expiraEm, tentativas, criadoEm, canais }
const pedidosNaHora = new Map(); // cpf -> [instantes dos pedidos da última hora]
const acessos = [];             // { adesaoId, entrouEm, tela, ip }
const solicitacoes = [];        // { id, adesaoId, tipo, payload, status, criadoEm }
const contatoPendente = new Map(); // adesaoId -> { email, telefone, pedidoEm }
const comprovantes = [];        // { id, adesaoId, billId, arquivo, tipo, tamanho, observacao, status, enviadoEm }
let sequencialUnico = 0;        // numeração dos boletos únicos de antecipação
const unicosPorId = new Map();  // id -> boleto único, para a parcela saber se o dela expirou
const historicos = new Map();   // billId -> [{ quando, o_que, detalhe }] — o que já aconteceu com a parcela
const lembretes = new Map();    // adesaoId -> dias de antecedência (0 = pediu para não receber)
const LEMBRETE_PADRAO_DIAS = 3; // o mesmo padrão do CRM, para quem nunca escolheu
const presencas = new Map();    // adesaoId -> { [chaveEtapa]: 'sim' | 'nao' }
const lidas = new Map();        // adesaoId -> Set de ids de notificação já vistas

// Cada mexida na parcela vira uma linha na ficha dela: é o que responde ao
// "por que esse valor mudou?" sem precisar ligar para a equipe.
function registrarHistorico(billId, oQue, detalhe) {
  const lista = historicos.get(billId) || [];
  lista.push({ quando: new Date().toISOString(), oQue, detalhe: detalhe || null });
  historicos.set(billId, lista);
}

// O histórico junta o que veio dos dados (emissão, pagamento) com o que
// aconteceu nesta sessão (2ª via, comprovante, emissão adiantada).
function historicoDoBoleto(adesaoId, b) {
  const fixos = [];
  if (b.pagoEm) fixos.push({ quando: `${b.pagoEm}T12:00:00.000Z`, oQue: 'Pagamento confirmado', detalhe: `Baixa de ${b.valorPago || b.valor}` });
  for (const c of comprovantes.filter((c) => c.adesaoId === adesaoId && c.billId === b.id)) {
    fixos.push({ quando: c.enviadoEm, oQue: 'Comprovante enviado', detalhe: c.arquivo });
  }
  // boleto único que venceu sem pagamento: foi cancelado, a parcela seguiu igual
  for (const u of unicosPorId.values()) {
    if (unicoExpirou(u) && u.unico.parcelas.some((p) => p.id === b.id)) {
      fixos.push({ quando: `${u.vencimento}T23:59:00.000Z`, oQue: 'Boleto único cancelado', detalhe: 'Venceu sem pagamento; a parcela seguiu com o boleto dela' });
    }
  }
  return [...fixos, ...(historicos.get(b.id) || [])].sort((a, b2) => a.quando.localeCompare(b2.quando));
}

// --- utilidades --------------------------------------------------------------
const soDigitos = (s) => String(s || '').replace(/\D/g, '');
const b64url = (b) => Buffer.from(b).toString('base64url');
const hash = (s) => crypto.createHash('sha256').update(s).digest('hex');

// --- PDF -------------------------------------------------------------------
// Monta um PDF de uma página na unha (sem dependência): o suficiente para o
// botão "abrir em PDF" entregar um arquivo de verdade, que abre e imprime.
// No ambiente real, aqui entra o PDF do boleto que vem da Vindi.
function montarPdf(linhas) {
  // O PDF é escrito em WinAnsi: travessão, aspas curvas e reticências viram o
  // equivalente simples, senão somem na hora de gravar.
  const ascii = (t) => String(t)
    .replace(/[–—]/g, '-').replace(/[“”]/g, '"').replace(/[‘’]/g, "'").replace(/…/g, '...');
  const esc = (t) => ascii(t).replace(/([\\()])/g, '\\$1');
  const texto = linhas.map(({ x, y, tam, txt, fonte }) =>
    `BT /${fonte === 'b' ? 'F2' : 'F1'} ${tam} Tf ${x} ${y} Td (${esc(txt)}) Tj ET`).join('\n');
  const conteudo = `0.6 0.55 0.5 RG 0.5 w\n40 760 m 555 760 l S\n40 92 m 555 92 l S\n${texto}`;

  const objetos = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 5 0 R /F2 6 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${Buffer.byteLength(conteudo, 'latin1')} >>\nstream\n${conteudo}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>',
  ];

  let pdf = '%PDF-1.4\n';
  const offsets = [];
  objetos.forEach((o, i) => {
    offsets.push(Buffer.byteLength(pdf, 'latin1'));
    pdf += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const inicioXref = Buffer.byteLength(pdf, 'latin1');
  pdf += `xref\n0 ${objetos.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) pdf += `${String(o).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objetos.length + 1} /Root 1 0 R >>\nstartxref\n${inicioXref}\n%%EOF`;
  return Buffer.from(pdf, 'latin1');
}

function pdfDoBoleto(adesao, turma, b) {
  const brl = (v) => `R$ ${Number(v).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}`;
  const data = (iso) => iso ? iso.split('-').reverse().join('/') : '—';
  const status = { pago: 'PAGO', em_aberto: 'EM ABERTO', em_atraso: 'EM ATRASO', agendado: 'PROGRAMADA', nao_gerado: 'PROGRAMADA' };
  const l = [];
  const p = (y, txt, tam = 11, fonte = 'n', x = 40) => l.push({ x, y, tam, txt, fonte });

  p(800, 'INDAIA EVENTOS  ·  FORMATURAS', 9, 'b');
  p(786, b.unico ? 'Boleto unico de antecipacao do termo de adesao' : 'Boleto de parcela do termo de adesao', 9);
  p(720, b.unico ? 'Boleto unico' : `Parcela ${b.parcela} de ${adesao.contrato.parcelas}`, 24, 'b');
  p(694, `${turma.rotulo}  ·  ${turma.cidade}`, 10);

  let y = 650;
  const linha = (rot, val) => { p(y, rot, 10); p(y, val, 11, 'b', 260); y -= 26; };
  linha('Formando', adesao.nome.replace(/\s*\(TESTE\)\s*/i, ''));
  linha('CPF', adesao.cpf.replace(/^(\d{3})(\d{3})(\d{3})(\d{2})$/, '$1.$2.$3-$4'));
  linha('Evento', turma.eventoCrm);
  linha('Descricao', b.descricao);
  linha('Vencimento', data(b.vencimento));
  linha('Valor', brl(b.valorAtualizado || b.valor));
  linha('Situacao', status[b.status] || b.status);
  if (b.pagoEm) linha('Pago em', data(b.pagoEm));

  if (b.linhaDigitavel) {
    y -= 10;
    p(y, 'LINHA DIGITAVEL', 9, 'b'); y -= 22;
    p(y, b.linhaDigitavel, 12, 'b'); y -= 30;
    p(y, 'Pague pelo aplicativo do seu banco, lendo o codigo ou copiando a linha acima.', 9);
  } else {
    y -= 10;
    p(y, 'Este boleto ainda nao foi emitido.', 10, 'b');
  }

  p(70, 'Documento de teste gerado pelo ambiente local da Area do Formando.', 8);
  p(58, 'Nao tem valor de cobranca.', 8);
  return montarPdf(l);
}

// Linha digitável de mentira, só para o "copiar" ter o que copiar na tela.
const linhaDigitavelFalsa = (semente) => {
  const d = crypto.createHash('sha256').update(semente).digest('hex').replace(/\D/g, '').padEnd(44, '7');
  return `34191.${d.slice(0, 5)} ${d.slice(5, 10)}.${d.slice(10, 16)} ${d.slice(16, 21)}.${d.slice(21, 27)} 9 ${d.slice(27, 37)}`;
};

const mascararEmail = (e) => {
  if (!e) return null;
  const [u, d] = e.split('@');
  return `${u.slice(0, 2)}${'*'.repeat(Math.max(1, u.length - 2))}@${d}`;
};
const mascararTelefone = (t) => {
  const d = soDigitos(t);
  return d.length < 4 ? null : `(${d.slice(2, 4)}) *****-${d.slice(-4)}`;
};

function assinarToken(payload) {
  const corpo = b64url(JSON.stringify({ ...payload, exp: Date.now() + TTL_TOKEN }));
  const assinatura = crypto.createHmac('sha256', SEGREDO).update(corpo).digest('base64url');
  return `${corpo}.${assinatura}`;
}

function lerToken(token) {
  if (!token || !token.includes('.')) return null;
  const [corpo, assinatura] = token.split('.');
  const esperada = crypto.createHmac('sha256', SEGREDO).update(corpo).digest('base64url');
  const a = Buffer.from(assinatura); const b = Buffer.from(esperada);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const dados = JSON.parse(Buffer.from(corpo, 'base64url').toString('utf8'));
    if (dados.exp < Date.now()) return null;
    // Isolamento: só passa token deste escopo. Token do casal ou interno cai fora.
    if (dados.scope !== 'area-formando' || dados.role !== 'formando') return null;
    return dados;
  } catch { return null; }
}

const acharAdesao = (id) => DADOS.adesoes.find((a) => a.adesaoId === id);
const acharTurma = (id) => DADOS.turmas.find((t) => t.id === id);
const adesoesPorCpf = (cpf) => DADOS.adesoes.filter((a) => a.cpf === soDigitos(cpf));

// --- projeções client-safe ---------------------------------------------------
// Nunca sai daqui: custo, margem, comissão, dado de outro formando, campo interno.
// Decisão da equipe (22/09/2026): o boleto único é gerado AO LADO das parcelas,
// que continuam com o boleto delas. Pago o único (e compensado), as parcelas
// dele são quitadas e os boletos delas saem; vencido sem pagamento, só o único é
// cancelado. Assim ninguém precisa apagar e refazer boleto de parcela.
const unicoExpirou = (u) => Boolean(u) && u.status !== 'pago' && u.vencimento < HOJE;
// o boleto único em que a parcela está, se ainda der para pagar
const unicoAtivoDa = (b) => {
  const u = b.noUnico && unicosPorId.get(b.noUnico);
  return u && u.status !== 'pago' && !unicoExpirou(u) ? u : null;
};

function situacaoBoleto(b) {
  if (b.unico) return b.status === 'pago' ? 'pago' : unicoExpirou(b) ? 'expirado' : 'em_aberto';
  // 2ª via com data nova tira a parcela do atraso até o novo vencimento.
  if (b.status === 'em_atraso' && b.vencimento >= HOJE) return 'em_aberto';
  return b.status;
}

// Como o formando chama a cobrança na tela, no PDF e nos avisos.
const nomeCobranca = (b) => (b.unico ? 'Boleto único' : `Parcela ${b.parcela}`);

function projetarBoleto(b) {
  const status = situacaoBoleto(b);
  const emitido = status === 'em_aberto' || status === 'em_atraso';
  return {
    id: b.id,
    parcela: b.parcela,
    nome: nomeCobranca(b),
    descricao: b.descricao,
    vencimento: b.vencimento,
    valor: b.valor,
    status,
    pagoEm: b.pagoEm,
    valorPago: b.valorPago,
    valorAtualizado: b.valorAtualizado || null,
    encargos: b.encargos || null,
    temLinhaDigitavel: emitido,
    unicoAtivo: (() => { const u = !b.unico && unicoAtivoDa(b); return u ? { id: u.id, vencimento: u.vencimento } : null; })(),
    unico: b.unico || null,
  };
}

// O que a pessoa deve HOJE por cada cobrança. Parcela vencida vale o valor dela
// mais o juro de mora corrido até hoje (cláusula 4.3).
// Comprovante anexado e ainda não conferido: a parcela vencida aparece como
// "em análise", não como atraso. O valor devido continua o mesmo, porque a baixa
// só acontece quando a equipe confirma.
const comprovantePendente = (adesaoId, billId) =>
  comprovantes.some((c) => c.adesaoId === adesaoId && c.billId === billId && c.status === 'em_analise');

// A taxa administrativa de gestão de conta vem do contrato (o plano da turma
// define o valor) e é somada em CADA boleto — inclusive no boleto único, uma
// vez só. Contrato sem taxa: nada é somado.
function taxaDoContrato(adesao) {
  return Number(adesao?.contrato?.taxaBoleto) || 0;
}

async function projetarComValor(b, adesaoId, adesao) {
  const p = projetarBoleto(b);
  p.taxaBoleto = b.status === 'pago' ? 0 : taxaDoContrato(adesao);
  if (p.status === 'pago') p.valorDevido = b.valorPago || b.valor;
  else if (p.status === 'em_atraso' && !b.unico) {
    p.encargosHoje = calcularEncargos(b, new Date(`${HOJE}T12:00:00`));
    p.valorDevido = p.encargosHoje.total;
  } else p.valorDevido = b.valorAtualizado || b.valor;
  if (p.status === 'em_atraso' && adesaoId && comprovantePendente(adesaoId, b.id)) p.status = 'em_analise';
  // o que o banco cobra: valor devido + taxa do contrato
  p.totalBoleto = arredonda(p.valorDevido + p.taxaBoleto);
  return p;
}

function resumoFinanceiro(adesao, todos) {
  const projetados = todos.filter((b) => !b.unico);
  const soma = (f) => arredonda(projetados.filter(f).reduce((a, b) => a + b.valorDevido, 0));
  const proxima = projetados
    .filter((b) => ['em_aberto', 'em_atraso', 'em_analise', 'agendado', 'nao_gerado'].includes(b.status))
    .filter((b) => b.vencimento >= HOJE)
    .sort((a, b) => a.vencimento.localeCompare(b.vencimento))[0];
  return {
    contratado: adesao.contrato.total,
    parcelas: adesao.contrato.parcelas,
    mensalidade: adesao.contrato.mensalidade,
    pago: soma((b) => b.status === 'pago'),
    emAberto: soma((b) => b.status === 'em_aberto'),
    emAtraso: soma((b) => b.status === 'em_atraso'),
    emAnalise: soma((b) => b.status === 'em_analise'),
    aEmitir: soma((b) => b.status === 'agendado' || b.status === 'nao_gerado'),
    parcelasPagas: projetados.filter((b) => b.status === 'pago' && !b.unico).length,
    proximoVencimento: proxima ? { vencimento: proxima.vencimento, valor: proxima.valorDevido, status: proxima.status } : null,
  };
}

// --- regras do termo de adesão ----------------------------------------------
// Tudo aqui vem do contrato (adesao-contrato.template.ts no crm-backend), não de
// invenção nossa. A cláusula está citada em cada regra porque a tela mostra isso
// para o formando.
const CONTRATO = {
  // 4.3 — parcela não paga até o vencimento é exigível com juros de mora de
  // 1% ao mês, pro rata die. O valor da parcela é fixo: não há desconto de
  // pontualidade a perder (decisão de 06/10/2026).
  jurosMoraMes: 0.01,
  // 8.2 — inscrição em cadastro de proteção ao crédito é precedida de
  // notificação por escrito, com 15 dias para regularizar.
  diasNotificacaoAntesNegativar: 15,
  // 8.3 — cobrança extrajudicial: honorários de 10% sobre o valor exigido.
  honorariosCobranca: 0.10,
  // 17.1 — inadimplência acima de 90 dias permite rescisão.
  diasInadimplenciaRescisao: 90,
  // 17.3 — toda reprogramação da forma de pagamento tem taxa fixa.
  taxaReprogramacao: 75,
};

const arredonda = (n) => Math.round(n * 100) / 100;

const REGRA_ENCARGOS = 'Valor da parcela acrescido de juros de mora de 1% ao mês, calculados pro rata die';

// A conta do atraso. Parcela de valor fixo + juro de mora, nada mais: o desconto
// de pontualidade saiu em 06/10/2026, e o IPCA do contrato é o reajuste
// programado dos 12 meses, que chega dentro do valor da parcela.
function calcularEncargos(boleto, ate) {
  const venceu = new Date(`${boleto.vencimentoOriginal || boleto.vencimento}T12:00:00`);
  const dias = Math.max(0, Math.round((ate - venceu) / 86400000));
  const valor = arredonda(boleto.valor);
  const juros = arredonda(valor * CONTRATO.jurosMoraMes * (dias / 30));

  return {
    diasAtraso: dias,
    valorParcela: valor,
    juros,
    total: arredonda(valor + juros),
    regra: REGRA_ENCARGOS,
  };
}

// --- 2ª via -------------------------------------------------------------------
// Regras de quem pode ter 2ª via e para quando. Valem para a prévia e para a
// emissão, para as duas nunca discordarem. Decisão da equipe (22/09/2026): a 2ª
// via vence em 5 dias.
const DIAS_SEGUNDA_VIA = 5;
function validarSegundaVia(b, novoVencimento) {
  if (b.unico) return { status: 409, corpo: { erro: 'unico_sem_segunda_via' } };
  if (situacaoBoleto(b) !== 'em_atraso') return { status: 409, corpo: { erro: 'nao_esta_vencida', status: situacaoBoleto(b) } };
  const hojeD = new Date(`${HOJE}T12:00:00`);
  const novaData = new Date(`${novoVencimento}T12:00:00`);
  if (Number.isNaN(novaData.getTime()) || novaData < hojeD) return { status: 400, corpo: { erro: 'data_invalida' } };
  if ((novaData - hojeD) / 86400000 > DIAS_SEGUNDA_VIA) return { status: 400, corpo: { erro: 'data_longe' } };
  return null;
}

// --- boleto único de antecipação ----------------------------------------------
// Decisão da equipe (22/09/2026): quem antecipa ou quita recebe na hora um boleto
// único, sem aprovação caso a caso. Parcela em dia entra pelo valor dela;
// vencida, com o juro de mora corrido até o vencimento do boleto único (4.3).
const DIAS_VENCIMENTO_UNICO = 3;   // confirmado pela equipe em 22/09/2026

async function montarUnico(adesao, billIds) {
  const ids = Array.isArray(billIds) ? [...new Set(billIds.map(String))] : [];
  if (!ids.length) return { erro: 'nenhuma_parcela' };

  const escolhidas = [];
  for (const id of ids) {
    const b = adesao.boletos.find((x) => x.id === id);
    if (!b || b.unico) return { erro: 'parcela_invalida' };
    const s = situacaoBoleto(b);
    if (s === 'pago' || unicoAtivoDa(b)) return { erro: 'parcela_indisponivel' };
    escolhidas.push({ b, s });
  }
  escolhidas.sort((x, y) => x.b.parcela - y.b.parcela);

  const venc = new Date(`${HOJE}T12:00:00`);
  venc.setDate(venc.getDate() + DIAS_VENCIMENTO_UNICO);
  const vencimento = venc.toISOString().slice(0, 10);

  const parcelas = [];
  for (const { b, s } of escolhidas) {
    if (s === 'em_atraso') {
      const e = calcularEncargos(b, venc);
      parcelas.push({
        id: b.id, parcela: b.parcela, vencimento: b.vencimentoOriginal || b.vencimento, vencida: true,
        valorDaParcela: b.valor, valor: e.total, encargos: e,
      });
    } else {
      // parcela com 2ª via já gerada entra pelo valor da 2ª via
      parcelas.push({
        id: b.id, parcela: b.parcela, vencimento: b.vencimento, vencida: false,
        valorDaParcela: b.valor, valor: b.valorAtualizado || b.valor, encargos: b.encargos || null,
      });
    }
  }
  const total = arredonda(parcelas.reduce((a, p) => a + p.valor, 0));
  const primeira = parcelas[0].parcela;
  const ultima = parcelas[parcelas.length - 1].parcela;
  const turma = acharTurma(adesao.turmaId);
  const id = `unico-${adesao.adesaoId}-${sequencialUnico + 1}`;

  return {
    unico: {
      id,
      parcela: null,
      descricao: `${turma.eventoCrm} - BOLETO UNICO (parcela${parcelas.length > 1 ? `s ${primeira} a ${ultima}` : ` ${primeira}`})`,
      vencimento,
      valor: total,
      status: 'em_aberto',
      pagoEm: null, valorPago: null,
      linhaDigitavel: linhaDigitavelFalsa(`${id}-${vencimento}`),
      pdfUrl: null, urlPagamento: null,
      unico: {
        parcelas,
        diasParaVencer: DIAS_VENCIMENTO_UNICO,
      },
    },
  };
}

// --- compensação de pagamento ------------------------------------------------
// O que acontece quando o banco confirma um pagamento. Hoje só o protótipo chama
// (pelas rotas /_dev); na integração, é aqui que entra o aviso da Vindi.
//
// Decisão da equipe (22/09/2026): se a mesma parcela for paga duas vezes — pelo
// boleto dela e pelo boleto único —, o sistema abre um chamado e a equipe
// resolve (cancelar e refazer, devolver ou creditar). Nada é decidido sozinho.
function abrirChamadoDuplicidade(adesao, parcela, comoFoiPago, valorDuplicado) {
  const s = novaSolicitacao(adesao, 'pagamento_duplicado', {
    mensagem: `Parcela ${parcela.parcela} paga duas vezes: ${comoFoiPago}. Valor pago a mais: ${Number(valorDuplicado).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })}. Aberto pelo sistema — a equipe entra em contato.`,
    billId: parcela.id,
    origem: 'sistema',
  });
  registrarHistorico(parcela.id, 'Pagamento em duplicidade', `Chamado ${s.protocolo} aberto para a equipe resolver`);
  console.log(`  [${s.protocolo}] ${adesao.nome}: parcela ${parcela.parcela} paga duas vezes`);
  return s;
}

function compensarUnico(adesao, u) {
  u.status = 'pago'; u.pagoEm = HOJE; u.valorPago = u.valor;
  for (const item of u.unico.parcelas) {
    const b = adesao.boletos.find((x) => x.id === item.id);
    if (b.status === 'pago') {
      // já tinha sido paga pelo boleto dela
      abrirChamadoDuplicidade(adesao, b, `pelo boleto dela em ${b.pagoEm.split('-').reverse().join('/')} e pelo boleto único em ${HOJE.split('-').reverse().join('/')}`, item.valor);
      continue;
    }
    b.status = 'pago'; b.pagoEm = HOJE; b.valorPago = item.valor; b.pagoPeloUnico = u.id;
    b.linhaDigitavel = null;
    registrarHistorico(b.id, 'Quitada pelo boleto único', 'O boleto desta parcela foi cancelado');
  }
}

function compensarParcela(adesao, b) {
  if (b.status === 'pago' && b.pagoPeloUnico) {
    // o boleto único já tinha quitado esta parcela
    abrirChamadoDuplicidade(adesao, b, `pelo boleto único em ${b.pagoEm.split('-').reverse().join('/')} e pelo boleto dela em ${HOJE.split('-').reverse().join('/')}`, b.valorAtualizado || b.valor);
    return;
  }
  // o "Pagamento confirmado" do histórico sai do próprio pagoEm
  b.status = 'pago'; b.pagoEm = HOJE; b.valorPago = b.valorAtualizado || b.valor;
}

// --- solicitações com protocolo ---------------------------------------------
// Toda coisa que o formando pede sai com número de protocolo. Sem prazo de
// resposta na tela (decisão da equipe, 22/09/2026): prazo prometido e não
// cumprido vira motivo de reclamação.
const TIPOS_SOLICITACAO = {
  convites_extras: 'Convites extras',
  antecipacao: 'Antecipação de parcelas',
  renegociacao: 'Negociação de débitos',
  contestacao: 'Contestação de cobrança',
  dados_contato: 'Correção de contato',
  comprovante: 'Comprovante de pagamento',
  lembrete: 'Lembrete de vencimento',
  presenca: 'Confirmação de presença',
  quitacao: 'Declaração de quitação',
  pagamento_duplicado: 'Pagamento em duplicidade',
  cancelamento: 'Pedido de cancelamento da adesão',
  // 11/11/2026 — os assuntos do "Preciso de ajuda" por tema.
  boleto: 'Boleto ou 2ª via',
  convites: 'Convites',
  convite_compra: 'Compra de convite',
  evento: 'Eventos e cronograma',
  contrato: 'Contrato',
  troca_turma: 'Troca de turma ou curso',
  dados_cadastro: 'Correção de cadastro',
  cancelamento_duvida: 'Dúvida sobre adesão cancelada',
  outro: 'Pedido para a equipe',
};

// --- pedidos: conversa, responsável e divisão por assunto (11/11/2026) --------
// Status com os MESMOS nomes do CRM (mig 945), mais "aguardando_formando": a
// equipe perguntou algo e o pedido sai da fila dela até o formando responder.
const STATUS_ABERTOS = new Set(['aberta', 'pendente', 'em_atendimento', 'aguardando_formando']);
const estaAberta = (s) => STATUS_ABERTOS.has(s.status);

// Quem atende. A mesma divisão da migration 1241 (Dani, 11/11/2026: a Ester saiu
// do financeiro; "Incluir a Daiane no financeiro e a Camylla no relacionamento").
const EQUIPE = [
  { id: 'daiane', nome: 'Daiane Bortoli', setor: 'Financeiro' },
  { id: 'wyllian', nome: 'Wyllian Moura', setor: 'Financeiro' },
  { id: 'camyla', nome: 'Camyla Cecchin', setor: 'Relacionamento formaturas' },
  { id: 'taynara', nome: 'Taynara Guesser', setor: 'Relacionamento formaturas' },
  { id: 'aline', nome: 'Aline Passos', setor: 'Gestão' },
];
const nomeDaEquipe = (id) => EQUIPE.find((p) => p.id === id)?.nome || 'Sem atendente';

// O GRUPO de cada FILA (Dani, 11/11/2026, segunda versão), o mesmo da migration 1241:
// "Daiane fica com negociação e cancelamento; Taynara e Camyla com o restante".
// Só distribui: todas veem e fazem tudo. Negociação e cancelamento saem do tipo e passam
// na frente do tema. O pedido chega para o grupo e fica com quem assumir.
const DIVISAO = [
  { tema: 'negociacao', rotulo: 'Negociação (renegociar, antecipar)', atendentes: ['daiane'] },
  { tema: 'cancelamento', rotulo: 'Cancelamento', atendentes: ['daiane'] },
  { tema: 'pagamentos', rotulo: 'Pagamentos', atendentes: ['camyla', 'taynara'] },
  { tema: 'dados', rotulo: 'Meus dados', atendentes: ['camyla', 'taynara'] },
  { tema: 'convites', rotulo: 'Convites', atendentes: ['camyla', 'taynara'] },
  { tema: 'eventos', rotulo: 'Eventos e cronograma', atendentes: ['camyla', 'taynara'] },
  { tema: 'contrato', rotulo: 'Contrato', atendentes: ['camyla', 'taynara'] },
  { tema: 'outro', rotulo: 'Outro assunto', atendentes: ['camyla', 'taynara'] },
];
const FILA_DO_TIPO = { renegociacao: 'negociacao', antecipacao: 'negociacao', cancelamento: 'cancelamento', cancelamento_duvida: 'cancelamento' };
const filaDoPedido = (tipo, tema) => FILA_DO_TIPO[tipo] || tema || 'outro';
// O tema dos tipos que nascem fora do "Preciso de ajuda" (contestação pela
// parcela, comprovante, presença, cancelamento).
const TEMA_DO_TIPO = {
  contestacao: 'pagamentos', renegociacao: 'pagamentos', antecipacao: 'pagamentos', comprovante: 'pagamentos',
  pagamento_duplicado: 'pagamentos', quitacao: 'pagamentos', boleto: 'pagamentos', lembrete: 'pagamentos',
  convites_extras: 'convites', convites: 'convites', convite_compra: 'convites',
  presenca: 'eventos', evento: 'eventos',
  contrato: 'contrato', troca_turma: 'contrato', cancelamento: 'contrato', cancelamento_duvida: 'contrato',
  dados_contato: 'dados', dados_cadastro: 'dados',
};
const grupoDoTema = (tema) => [...(DIVISAO.find((r) => r.tema === tema)?.atendentes || [])];

let sequencialMensagem = 0;
const anexosGuardados = new Map(); // anexoId -> { conteudo, tipo, arquivo }
const TIPOS_ANEXO = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'];
const MAX_ANEXOS = 5;
const MAX_ANEXO_BYTES = 8 * 1024 * 1024;

/** Valida e guarda os anexos. Devolve { anexos } ou { erro }. */
function guardarAnexos(lista) {
  if (lista == null) return { anexos: [] };
  if (!Array.isArray(lista) || lista.length > MAX_ANEXOS) return { erro: 'anexos_demais' };
  const saida = [];
  for (const a of lista) {
    if (!a || !TIPOS_ANEXO.includes(a.tipo) || typeof a.conteudo !== 'string') return { erro: 'tipo_nao_aceito' };
    if (Number(a.tamanho) > MAX_ANEXO_BYTES) return { erro: 'arquivo_grande' };
    const id = `anx-${crypto.randomBytes(5).toString('hex')}`;
    anexosGuardados.set(id, { conteudo: a.conteudo, tipo: a.tipo, arquivo: String(a.arquivo || 'arquivo').slice(0, 120) });
    saida.push({ id, arquivo: String(a.arquivo || 'arquivo').slice(0, 120), tipo: a.tipo, tamanho: Number(a.tamanho) || 0 });
  }
  return { anexos: saida };
}

function novaMensagem(s, autor, texto, anexos = [], quem = null) {
  sequencialMensagem += 1;
  const m = {
    id: `msg-${sequencialMensagem}`, autor, quem, texto: String(texto || '').slice(0, 4000),
    anexos, criadoEm: new Date().toISOString(),
  };
  s.mensagens.push(m);
  return m;
}

// Registro interno: transferência, prioridade, nota. O formando NUNCA vê.
function novoRegistro(s, tipo, texto, quem) {
  s.registros.push({ tipo, texto, quem: quem || 'Sistema', criadoEm: new Date().toISOString() });
}

/** O pedido como o FORMANDO lê: sem registros internos nem responsável. */
function pedidoParaOFormando(s, { comMensagens = false } = {}) {
  const { registros, responsavel, prioridade, adesaoId, ...resto } = s;
  const ultima = s.mensagens[s.mensagens.length - 1] || null;
  return {
    ...resto,
    aguardandoVoce: s.status === 'aguardando_formando',
    ultimaMensagem: ultima ? { autor: ultima.autor, texto: ultima.texto.slice(0, 140), criadoEm: ultima.criadoEm } : null,
    mensagens: comMensagens ? s.mensagens : undefined,
  };
}

// Escada da cláusula 6.2 do Termo — a mesma que o CRM usa quando a turma não tem outra.
const ESCADA_PENAL = { mais360: 10, de360a181: 15, de180a121: 20, de120a31: 25 };
function faixaPenal(dias) {
  if (dias == null) return { rotulo: 'Turma sem data de festa', pct: null, integral: false };
  if (dias > 360) return { rotulo: 'Mais de 360 dias antes da festa', pct: ESCADA_PENAL.mais360, integral: false };
  if (dias > 180) return { rotulo: 'De 360 a 181 dias antes da festa', pct: ESCADA_PENAL.de360a181, integral: false };
  if (dias > 120) return { rotulo: 'De 180 a 121 dias antes da festa', pct: ESCADA_PENAL.de180a121, integral: false };
  if (dias > 30) return { rotulo: 'De 120 a 31 dias antes da festa', pct: ESCADA_PENAL.de120a31, integral: false };
  return { rotulo: '30 dias ou menos antes da festa', pct: 100, integral: true };
}

let sequencialProtocolo = 0;
function novaSolicitacao(adesao, tipo, payload) {
  sequencialProtocolo += 1;
  const agora = new Date();
  const s = {
    id: `sol-${solicitacoes.length + 1}`,
    protocolo: `SOL-${agora.getFullYear()}-${String(sequencialProtocolo).padStart(4, '0')}`,
    adesaoId: adesao.adesaoId,
    tipo,
    rotulo: TIPOS_SOLICITACAO[tipo] || TIPOS_SOLICITACAO.outro,
    payload,
    status: 'pendente',
    criadoEm: agora.toISOString(),
    tema: payload?.tema || TEMA_DO_TIPO[tipo] || 'outro',
    responsavel: '',
    prioridade: 'normal',
    mensagens: [],
    registros: [],
    resolvidoEm: null,
  };
  // O grupo do tema recebe o pedido; uma pessoa só já vira a responsável.
  s.fila = filaDoPedido(s.tipo, s.tema);
  s.grupo = grupoDoTema(s.fila);
  s.responsavel = s.grupo.length === 1 ? s.grupo[0] : '';
  const rotuloDoTema = DIVISAO.find((r) => r.tema === s.fila)?.rotulo;
  novoRegistro(s, 'distribuicao', s.responsavel
    ? `Distribuído para ${nomeDaEquipe(s.responsavel)} pela divisão de "${rotuloDoTema}".`
    : s.grupo.length
      ? `Para o grupo de "${rotuloDoTema}" (${s.grupo.map(nomeDaEquipe).join(', ')}): quem assumir fica com o pedido.`
      : 'Ninguém na divisão deste assunto: está em "Sem atendente".');
  // Todo pedido abre a conversa com o que o formando escreveu.
  novaMensagem(s, 'formando', payload?.mensagem || '', payload?.anexosDaAbertura || []);
  if (s.payload) delete s.payload.anexosDaAbertura;
  solicitacoes.push(s);
  return s;
}

// --- extrato -----------------------------------------------------------------
async function extratoDoFormando(adesao) {
  // o boleto único é outra forma de pagar as mesmas parcelas: não entra na conta
  const bs = await Promise.all(adesao.boletos.filter((b) => !b.unico).map(async (b) => ({ ...b, ...(await projetarComValor(b, adesao.adesaoId, adesao)) })));
  const pagas = bs.filter((b) => b.status === 'pago')
    .sort((a, b) => (a.pagoEm || a.vencimento).localeCompare(b.pagoEm || b.vencimento));
  const arredonda = (n) => Math.round(n * 100) / 100;
  const totalPago = arredonda(pagas.reduce((a, b) => a + (b.valorPago || b.valor), 0));
  // o mesmo "em aberto" do financeiro: vencida conta com os encargos até hoje
  const emAberto = arredonda(bs.filter((b) => b.status !== 'pago').reduce((a, b) => a + b.valorDevido, 0));

  return {
    contrato: {
      total: adesao.contrato.total,
      parcelas: adesao.contrato.parcelas,
      mensalidade: adesao.contrato.mensalidade,
      primeiraParcela: adesao.contrato.primeiraParcela,
      assinadoEm: adesao.contrato.assinadoEm,
    },
    // Transparência do reajuste: o que já foi aplicado e o que está programado.
    reajustes: adesao.reajustesAplicados || [],
    reajusteProgramado: adesao.reajuste?.aplicado ? null : adesao.reajuste || null,
    pagamentos: pagas.map((b) => ({
      parcela: b.parcela,
      vencimento: b.vencimento,
      pagoEm: b.pagoEm,
      valor: b.valor,
      valorPago: b.valorPago || b.valor,
      forma: b.pagoPeloUnico ? 'Boleto único' : 'Boleto',
    })),
    totais: {
      pago: totalPago,
      emAberto,
      parcelasPagas: pagas.length,
      parcelasEmAberto: bs.length - pagas.length,
      quitado: emAberto === 0,
    },
    emitidoEm: new Date().toISOString(),
  };
}

function pdfDoExtrato(adesao, turma, extrato) {
  const brl = (v) => `R$ ${Number(v).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}`;
  const data = (iso) => iso ? iso.slice(0, 10).split('-').reverse().join('/') : '—';
  const l = [];
  const p = (y, txt, tam = 10, fonte = 'n', x = 40) => l.push({ x, y, tam, txt, fonte });

  p(800, 'INDAIA EVENTOS  ·  FORMATURAS', 9, 'b');
  p(786, 'Extrato de pagamentos', 9);
  p(730, 'Extrato de pagamentos', 22, 'b');
  p(706, `${adesao.nome.replace(/\s*\(TESTE\)\s*/i, '')}  ·  ${turma.rotulo}`, 10);
  p(692, `Emitido em ${data(extrato.emitidoEm)}`, 9);

  let y = 655;
  const linha = (rot, val) => { p(y, rot, 10); p(y, val, 10, 'b', 300); y -= 26; };
  linha('Contrato', `${brl(extrato.contrato.total)} em ${extrato.contrato.parcelas}x`);
  linha('Parcelas pagas', `${extrato.totais.parcelasPagas} de ${extrato.contrato.parcelas}`);
  linha('Total pago', brl(extrato.totais.pago));
  linha('Em aberto', brl(extrato.totais.emAberto));

  y -= 14;
  p(y, 'PAGAMENTOS', 9, 'b'); y -= 20;
  p(y, 'Parcela', 9, 'b'); p(y, 'Vencimento', 9, 'b', 140); p(y, 'Pago em', 9, 'b', 250); p(y, 'Valor', 9, 'b', 380);
  y -= 16;
  for (const pg of extrato.pagamentos) {
    if (y < 120) break;
    p(y, String(pg.parcela), 10);
    p(y, data(pg.vencimento), 10, 'n', 140);
    p(y, data(pg.pagoEm), 10, 'n', 250);
    p(y, brl(pg.valorPago), 10, 'n', 380);
    y -= 17;
  }

  p(70, 'Documento de teste gerado pelo ambiente local da Area do Formando.', 8);
  p(58, 'Nao substitui recibo fiscal.', 8);
  return montarPdf(l);
}

// --- recibo de parcela paga --------------------------------------------------
// O extrato mostra tudo junto; o recibo é o papel de uma parcela só, que é o que
// as pessoas pedem para prestar contas com a família ou com quem ajudou a pagar.
function reciboDaParcela(adesao, turma, b) {
  return {
    numero: `REC-${turma.codigo}-${String(b.parcela).padStart(3, '0')}`,
    formando: adesao.nome.replace(/\s*\(TESTE\)\s*/i, ''),
    cpf: adesao.cpf.replace(/^(\d{3})(\d{3})(\d{3})(\d{2})$/, '$1.$2.$3-$4'),
    turma: turma.rotulo,
    evento: turma.eventoCrm,
    parcela: b.parcela,
    totalParcelas: adesao.contrato.parcelas,
    descricao: b.descricao,
    vencimento: b.vencimento,
    pagoEm: b.pagoEm,
    valorPago: b.valorPago || b.valor,
    forma: 'Boleto bancário',
    emitidoEm: new Date().toISOString(),
  };
}

function pdfDoRecibo(r) {
  const brl = (v) => `R$ ${Number(v).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}`;
  const data = (iso) => iso ? iso.slice(0, 10).split('-').reverse().join('/') : '—';
  const l = [];
  const p = (y, txt, tam = 10, fonte = 'n', x = 40) => l.push({ x, y, tam, txt, fonte });

  p(800, 'INDAIA EVENTOS  ·  FORMATURAS', 9, 'b');
  p(786, 'Recibo de pagamento de parcela', 9);
  p(730, `Recibo ${r.numero}`, 22, 'b');
  p(706, `${r.formando}  ·  ${r.turma}`, 10);

  let y = 660;
  const linha = (rot, val) => { p(y, rot, 10); p(y, val, 10, 'b', 300); y -= 26; };
  linha('CPF', r.cpf);
  linha('Evento', r.evento);
  linha('Parcela', `${r.parcela} de ${r.totalParcelas}`);
  linha('Descricao', r.descricao);
  linha('Vencimento', data(r.vencimento));
  linha('Pago em', data(r.pagoEm));
  linha('Forma de pagamento', r.forma);
  linha('Valor pago', brl(r.valorPago));

  y -= 16;
  p(y, 'Recebemos a importancia acima, referente a parcela do termo de adesao', 10); y -= 16;
  p(y, 'individual de formatura da turma indicada.', 10);

  p(70, 'Documento de teste gerado pelo ambiente local da Area do Formando.', 8);
  p(58, 'Nao substitui recibo fiscal.', 8);
  return montarPdf(l);
}

// --- informe anual de pagamentos (imposto de renda) --------------------------
// Soma o que foi pago em cada ano-calendário. Quem declara precisa disso, e hoje
// pede por WhatsApp.
function informeAnual(adesao) {
  const pagas = adesao.boletos.map((b) => ({ ...b, status: situacaoBoleto(b) })).filter((b) => b.status === 'pago');
  const porAno = new Map();
  for (const b of pagas) {
    const ano = (b.pagoEm || b.vencimento).slice(0, 4);
    const atual = porAno.get(ano) || { ano, total: 0, parcelas: 0 };
    atual.total = arredonda(atual.total + (b.valorPago || b.valor));
    atual.parcelas += 1;
    porAno.set(ano, atual);
  }
  return {
    anos: [...porAno.values()].sort((a, b) => b.ano.localeCompare(a.ano)),
    prestador: DADOS.config.prestador || {
      razaoSocial: 'INDAIA EVENTOS (dados de exemplo)',
      cnpj: '00.000.000/0001-00',
    },
  };
}

function pdfDoInforme(adesao, turma, ano, dadosAno, prestador) {
  const brl = (v) => `R$ ${Number(v).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}`;
  const data = (iso) => iso ? iso.slice(0, 10).split('-').reverse().join('/') : '—';
  const l = [];
  const p = (y, txt, tam = 10, fonte = 'n', x = 40) => l.push({ x, y, tam, txt, fonte });

  p(800, 'INDAIA EVENTOS  ·  FORMATURAS', 9, 'b');
  p(786, `Informe de pagamentos ${ano}`, 9);
  p(730, `Informe de pagamentos - ${ano}`, 20, 'b');
  p(706, `${adesao.nome.replace(/\s*\(TESTE\)\s*/i, '')}  ·  ${turma.rotulo}`, 10);
  p(692, `CPF ${adesao.cpf.replace(/^(\d{3})(\d{3})(\d{3})(\d{2})$/, '$1.$2.$3-$4')}`, 9);

  let y = 655;
  const linha = (rot, val) => { p(y, rot, 10); p(y, val, 10, 'b', 300); y -= 24; };
  linha('Prestador', prestador.razaoSocial);
  linha('CNPJ', prestador.cnpj);
  linha('Parcelas pagas no ano', String(dadosAno.parcelas));
  linha('Total pago no ano', brl(dadosAno.total));

  y -= 14;
  p(y, 'PARCELAS', 9, 'b'); y -= 20;
  p(y, 'Parcela', 9, 'b'); p(y, 'Vencimento', 9, 'b', 140); p(y, 'Pago em', 9, 'b', 250); p(y, 'Valor', 9, 'b', 380);
  y -= 16;
  for (const b of dadosAno.itens) {
    if (y < 120) break;
    p(y, String(b.parcela), 10);
    p(y, data(b.vencimento), 10, 'n', 140);
    p(y, data(b.pagoEm), 10, 'n', 250);
    p(y, brl(b.valorPago || b.valor), 10, 'n', 380);
    y -= 17;
  }

  p(70, 'Documento de teste gerado pelo ambiente local da Area do Formando.', 8);
  p(58, 'Confira os valores com a equipe antes de usar na declaracao.', 8);
  return montarPdf(l);
}

// --- termo de adesão em PDF --------------------------------------------------
// No ambiente real é o PDF assinado que vem do DocuSeal. Aqui sai um resumo com
// os dados do contrato e as cláusulas que a tela cita.
function pdfDoTermo(adesao, turma) {
  const brl = (v) => `R$ ${Number(v).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}`;
  const data = (iso) => iso ? iso.slice(0, 10).split('-').reverse().join('/') : '—';
  const l = [];
  const p = (y, txt, tam = 10, fonte = 'n', x = 40) => l.push({ x, y, tam, txt, fonte });

  p(800, 'INDAIA EVENTOS  ·  FORMATURAS', 9, 'b');
  p(786, 'Termo de adesao individual - resumo', 9);
  p(730, 'Termo de adesao', 22, 'b');
  p(706, `${adesao.nome.replace(/\s*\(TESTE\)\s*/i, '')}  ·  ${turma.rotulo}`, 10);

  let y = 660;
  const linha = (rot, val) => { p(y, rot, 10); p(y, val, 10, 'b', 300); y -= 24; };
  linha('Assinado em', data(adesao.contrato.assinadoEm));
  linha('Forma', adesao.contrato.docusealSubmissionId ? 'Assinatura digital (DocuSeal)' : 'Documento anexado');
  linha('Valor total', brl(adesao.contrato.total));
  linha('Parcelamento', `${adesao.contrato.parcelas}x de ${brl(adesao.contrato.mensalidade)}`);
  linha('Primeira parcela', data(adesao.contrato.primeiraParcela));
  linha('Evento', `${turma.eventoCrm} - ${data(turma.dataEvento)}`);

  y -= 14;
  p(y, 'CLAUSULAS CITADAS NA AREA DO FORMANDO', 9, 'b'); y -= 20;
  const resumo = [
    ['4.3', 'Parcela em atraso: juros de mora de 1% ao mes sobre o valor da parcela, pro rata die.'],
    ['8.1', 'Inadimplencia suspende a participacao em eventos, ensaios e a retirada de convites.'],
    ['8.2', 'Negativacao e precedida de notificacao por escrito, com 15 dias para regularizar.'],
    ['17.3', 'Reprogramacao da forma de pagamento: taxa fixa de R$ 75,00.'],
  ];
  for (const [num, txt] of resumo) {
    p(y, num, 9, 'b');
    p(y, txt, 9, 'n', 80);
    y -= 18;
  }

  p(70, 'Resumo de teste gerado pelo ambiente local. O termo assinado esta no CRM.', 8);
  return montarPdf(l);
}

// Contestação em aberto daquela parcela — enquanto existe, a tela mostra o
// protocolo e não deixa abrir outra.
const contestacaoAberta = (adesaoId, billId) => {
  const s = solicitacoes.find((x) => x.adesaoId === adesaoId && x.tipo === 'contestacao' && estaAberta(x) && x.payload?.billId === billId);
  return s ? { protocolo: s.protocolo, criadoEm: s.criadoEm, motivo: s.payload?.motivo || null } : null;
};

const comprovantesDoBoleto = (adesaoId, billId) => comprovantes
  .filter((c) => c.adesaoId === adesaoId && c.billId === billId)
  .map(({ conteudo, adesaoId: _a, ...resto }) => resto);

// A etapa é identificada por data+nome: os dados não têm id próprio.
const chaveEtapa = (e) => `${e.data}|${e.etapa}`;

function projetarTurma(turma, adesaoId) {
  const minhas = presencas.get(adesaoId) || {};
  // Quem está na turma: só o nome, como a API do CRM manda (07/10). A contagem
  // sai da lista para os dois nunca discordarem.
  const colegas = DADOS.adesoes
    .filter((a) => a.turmaId === turma.id && a.situacao !== 'cancelada')
    .map((a) => ({ nome: String(a.nome ?? '').trim(), souEu: a.adesaoId === adesaoId }))
    .filter((c) => c.nome)
    .sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR'));

  return {
    codigo: turma.codigo, rotulo: turma.rotulo, curso: turma.curso, cursos: turma.cursos,
    dataEvento: turma.dataEvento, cidade: turma.cidade, espaco: turma.espaco,
    pacote: turma.pacote, formandos: colegas.length, consultora: turma.consultora,
    colegas,
    comissao: turma.comissao || [],
    fotos: turma.fotos,
    cronograma: turma.cronograma.map((e) => ({ ...e, chave: chaveEtapa(e), presenca: minhas[chaveEtapa(e)] || null })),
    avisos: turma.avisos,
  };
}

// --- central de avisos (o sino) ----------------------------------------------
// Junta num lugar só o que hoje o formando só descobre entrando em cada aba:
// parcela vencida ou a vencer, resposta de pedido, aviso da equipe e etapa perto.
function notificacoes(adesao) {
  const turma = acharTurma(adesao.turmaId);
  const hojeD = new Date(`${HOJE}T12:00:00`);
  const emDias = (iso) => Math.round((new Date(`${iso}T12:00:00`) - hojeD) / 86400000);
  const itens = [];

  if (adesao.situacao !== 'cancelada') {
    const bs = adesao.boletos.map((b) => ({ ...b, status: situacaoBoleto(b) }));
    for (const b of bs.filter((b) => b.status === 'em_atraso')) {
      itens.push({
        id: `atraso-${b.id}`, tipo: 'atraso', prioridade: 1,
        titulo: `${nomeCobranca(b)} vencida`,
        texto: `Venceu em ${b.vencimento.split('-').reverse().join('/')} — gere a 2ª via com data nova.`,
        quando: b.vencimento, ir: 'financeiro', billId: b.id,
      });
    }
    for (const b of bs.filter((b) => b.status === 'expirado')) {
      const ps = b.unico.parcelas;
      itens.push({
        id: `expirou-${b.id}`, tipo: 'vencimento', prioridade: 2,
        titulo: 'Boleto único cancelado',
        texto: `Venceu em ${b.vencimento.split('-').reverse().join('/')} sem pagamento. ${ps.length > 1 ? `As parcelas ${ps[0].parcela} a ${ps[ps.length - 1].parcela} continuam` : `A parcela ${ps[0].parcela} continua`} como estava${ps.length > 1 ? 'm' : ''}.`,
        quando: b.vencimento, ir: 'financeiro',
      });
    }
    // "vence em N dias" só para o que já tem boleto na mão para pagar
    for (const b of bs.filter((b) => b.status === 'em_aberto')) {
      const d = emDias(b.vencimento);
      if (d >= 0 && d <= 10) {
        itens.push({
          id: `vence-${b.id}`, tipo: 'vencimento', prioridade: 2,
          titulo: `${nomeCobranca(b)} vence ${d === 0 ? 'hoje' : d === 1 ? 'amanhã' : `em ${d} dias`}`,
          texto: `${b.vencimento.split('-').reverse().join('/')} · R$ ${(b.valorAtualizado || b.valor).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}`,
          quando: b.vencimento, ir: 'financeiro', billId: b.id,
        });
      }
    }
  }

  for (const s of solicitacoes.filter((s) => s.adesaoId === adesao.adesaoId)) {
    // chamado aberto pelo sistema: o formando fica sabendo que a equipe já está vendo
    if (s.tipo === 'pagamento_duplicado' && estaAberta(s)) {
      itens.push({
        id: `pedido-${s.id}`, tipo: 'pedido', prioridade: 1,
        titulo: 'Pagamento em duplicidade',
        texto: `Identificamos um pagamento a mais. A equipe vai entrar em contato para resolver (${s.protocolo}).`,
        quando: s.criadoEm.slice(0, 10), ir: 'pedidos',
      });
    }
    // Resposta nova da equipe: o id leva a mensagem, então cada resposta volta a
    // acender o sino (a anterior já lida não esconde a nova).
    const ultima = (s.mensagens || []).filter((m) => m.autor === 'equipe').slice(-1)[0];
    if (ultima && estaAberta(s)) {
      itens.push({
        id: `resposta-${ultima.id}`, tipo: 'pedido', prioridade: 1,
        titulo: s.status === 'aguardando_formando' ? `A equipe precisa de você: ${s.payload?.assunto || s.rotulo}` : `Resposta no pedido ${s.protocolo}`,
        texto: ultima.texto.slice(0, 90), quando: ultima.criadoEm.slice(0, 10), ir: 'pedidos', pedidoId: s.id,
      });
    }
    if (!estaAberta(s)) {
      itens.push({
        id: `pedido-${s.id}-${s.status}`, tipo: 'pedido', prioridade: 2,
        titulo: `${s.payload?.assunto || s.rotulo}: ${['concluida', 'atendida'].includes(s.status) ? 'resolvido' : 'não aprovado'}`,
        texto: s.protocolo, quando: (s.resolvidoEm || s.criadoEm).slice(0, 10), ir: 'pedidos', pedidoId: s.id,
      });
    }
  }

  // O mural da turma não entra aqui: o sino é do que depende do formando.
  const proxima = turma.cronograma.filter((e) => e.data >= HOJE).sort((a, b) => a.data.localeCompare(b.data))[0];
  if (proxima && emDias(proxima.data) <= 45) {
    itens.push({
      id: `etapa-${chaveEtapa(proxima)}`, tipo: 'etapa', prioridade: 3,
      titulo: `Chegando: ${proxima.etapa}`,
      texto: `${proxima.data.split('-').reverse().join('/')}${proxima.local ? ` · ${proxima.local}` : ''}`,
      quando: proxima.data, ir: 'cronograma',
    });
  }

  const vistas = lidas.get(adesao.adesaoId) || new Set();
  const lista = itens
    .map((i) => ({ ...i, lida: vistas.has(i.id) }))
    .sort((a, b) => (a.prioridade - b.prioridade) || b.quando.localeCompare(a.quando));
  return { itens: lista, naoLidas: lista.filter((i) => !i.lida).length };
}

// --- HTTP --------------------------------------------------------------------
const TIPOS = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json', '.ttf': 'font/ttf', '.jpg': 'image/jpeg',
};

const responder = (res, status, corpo) => {
  const texto = JSON.stringify(corpo);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(texto);
};

const lerCorpo = (req) => new Promise((resolve) => {
  let dados = '';
  req.on('data', (c) => { dados += c; if (dados.length > 60e6) req.destroy(); });   // 60 MB: até 5 anexos de 8 MB em base64
  req.on('end', () => { try { resolve(dados ? JSON.parse(dados) : {}); } catch { resolve({}); } });
});

function exigirFormando(req, res) {
  const cabecalho = req.headers.authorization || '';
  const dados = lerToken(cabecalho.replace(/^Bearer /i, ''));
  // O token da etapa de escolha de turma não abre dado nenhum: só serve para escolher.
  if (!dados || !dados.adesaoId || dados.etapa) { responder(res, 401, { erro: 'sessao_invalida' }); return null; }
  const adesao = acharAdesao(dados.adesaoId);
  if (!adesao) { responder(res, 401, { erro: 'sessao_invalida' }); return null; }
  return adesao;
}

const registrarAcesso = (adesaoId, tela, req) => {
  acessos.push({ adesaoId, tela, entrouEm: new Date().toISOString(), ip: req.socket.remoteAddress });
};

// --- equipe: respostas prontas, prazo interno e ações -------------------------
// Respostas prontas por assunto. {nome}, {parcela} e {protocolo} são trocados
// na hora; a pessoa sempre pode editar antes de enviar. `acao` é o botão que o
// texto sugere (responder, pedir informação ou concluir).
const RESPOSTAS_PRONTAS = [
  { tema: 'pagamentos', titulo: 'Baixa feita', acao: 'concluir',
    texto: 'Olá, {nome}! Conferimos o seu pagamento da {parcela} e a baixa já foi feita: ela aparece como paga no portal. Obrigado por avisar!' },
  { tema: 'pagamentos', titulo: 'Pedir comprovante', acao: 'pedir_info',
    texto: 'Olá, {nome}! Ainda não localizamos o pagamento da {parcela}. Pode anexar aqui o comprovante, com a data e o valor pagos?' },
  { tema: 'pagamentos', titulo: 'Proposta de negociação', acao: 'pedir_info',
    texto: 'Olá, {nome}! Podemos juntar as parcelas vencidas num boleto único, com vencimento em 5 dias, ou dividir o valor nas próximas parcelas. Qual das duas opções fica melhor para você?' },
  { tema: 'pagamentos', titulo: 'Duplicidade: como devolver', acao: 'pedir_info',
    texto: 'Olá, {nome}! Confirmamos o pagamento em duplicidade da {parcela}. Prefere que o valor seja abatido da próxima parcela ou devolvido na sua conta? Se for na conta, informe banco, agência e conta no seu nome.' },
  { tema: 'pagamentos', titulo: 'Declaração de quitação enviada', acao: 'concluir',
    texto: 'Olá, {nome}! A sua declaração de quitação está anexada aqui. Qualquer coisa, é só responder.' },
  { tema: 'dados', titulo: 'Cadastro corrigido', acao: 'concluir',
    texto: 'Olá, {nome}! Corrigimos o seu cadastro conforme o documento enviado. Confira em "Meus dados".' },
  { tema: 'dados', titulo: 'Pedir documento', acao: 'pedir_info',
    texto: 'Olá, {nome}! Para corrigir o seu cadastro precisamos de uma foto de um documento com foto (RG ou CNH) em que o dado apareça. Pode anexar aqui?' },
  { tema: 'convites', titulo: 'Convites liberados', acao: 'concluir',
    texto: 'Olá, {nome}! Os seus convites já estão liberados no portal, em "Contrato e convites". Lembre de nomear cada um para a lista da portaria.' },
  { tema: 'eventos', titulo: 'Data e local confirmados', acao: 'concluir',
    texto: 'Olá, {nome}! A data, o horário e o local estão no Cronograma do portal. Se algo mudar, avisamos por lá e por e-mail.' },
  { tema: 'contrato', titulo: 'Cópia do contrato', acao: 'concluir',
    texto: 'Olá, {nome}! A cópia do seu termo de adesão está anexada aqui e também fica em "Contrato e convites" no portal.' },
  { tema: '*', titulo: 'Pedir mais detalhes', acao: 'pedir_info',
    texto: 'Olá, {nome}! Para resolver, precisamos de mais alguns detalhes. Pode nos contar um pouco mais aqui?' },
  { tema: '*', titulo: 'Recebemos e estamos vendo', acao: 'responder',
    texto: 'Olá, {nome}! Recebemos o seu pedido ({protocolo}) e já estamos verificando. Respondemos por aqui assim que tivermos a resposta.' },
];

// PRAZO INTERNO. O formando NÃO vê prazo (decisão de 22/09/2026). A equipe vê
// há quanto tempo o formando espera: desde a última fala dele sem resposta.
const META_HORAS = { atencao: 24, atrasado: 48 };
function esperaDaEquipe(s) {
  if (!['pendente', 'em_atendimento'].includes(s.status)) return null;
  const ms = s.mensagens;
  let desde = null;
  for (let i = ms.length - 1; i >= 0 && ms[i].autor === 'formando'; i -= 1) desde = ms[i].criadoEm;
  if (!desde) return null;
  const horas = (Date.now() - new Date(desde).getTime()) / 3600000;
  return { desde, horas: Math.round(horas * 10) / 10, nivel: horas >= META_HORAS.atrasado ? 'atrasado' : horas >= META_HORAS.atencao ? 'atencao' : 'ok' };
}

function pedidoParaAEquipe(s) {
  const a = acharAdesao(s.adesaoId);
  const t = a && acharTurma(a.turmaId);
  const ultima = s.mensagens[s.mensagens.length - 1] || null;
  return {
    id: s.id, protocolo: s.protocolo, tipo: s.tipo, rotulo: s.rotulo, tema: s.tema,
    assunto: s.payload?.assunto || s.rotulo, status: s.status, prioridade: s.prioridade,
    responsavel: s.responsavel, responsavelNome: s.responsavel ? nomeDaEquipe(s.responsavel) : null,
    grupo: s.grupo || [],
    formando: a ? { nome: a.nome, cpf: a.cpf, turma: t?.rotulo || '' } : null,
    criadoEm: s.criadoEm, resolvidoEm: s.resolvidoEm, espera: esperaDaEquipe(s),
    ultimaMensagem: ultima ? { autor: ultima.autor, texto: ultima.texto.slice(0, 120), criadoEm: ultima.criadoEm } : null,
    qtdAnexos: s.mensagens.reduce((n, m) => n + m.anexos.length, 0),
  };
}

async function painelDoFormando(adesao) {
  const turma = acharTurma(adesao.turmaId);
  const boletos = await Promise.all(adesao.boletos.filter((b) => !b.unico).map((b) => projetarComValor(b, adesao.adesaoId, adesao)));
  const minhas = presencas.get(adesao.adesaoId) || {};
  return {
    nome: adesao.nome, cpf: adesao.cpf, email: adesao.email, telefone: adesao.telefone, curso: adesao.curso,
    situacao: adesao.situacao, turma: turma?.rotulo || '',
    contrato: { total: adesao.contrato?.total, parcelas: adesao.contrato?.parcelas, assinadoEm: adesao.contrato?.assinadoEm },
    resumo: {
      pagas: boletos.filter((b) => b.status === 'pago').length,
      vencidas: boletos.filter((b) => ['em_atraso', 'em_analise'].includes(b.status)).length,
      emAberto: arredonda(boletos.filter((b) => b.status !== 'pago').reduce((n, b) => n + Number(b.totalBoleto || 0), 0)),
    },
    parcelas: boletos.map((b) => ({ id: b.id, parcela: b.parcela, vencimento: b.vencimento, status: b.status, total: b.totalBoleto, pagoEm: b.pagoEm || null })),
    comprovantes: comprovantes.filter((c) => c.adesaoId === adesao.adesaoId)
      .map((c) => ({ id: c.id, billId: c.billId, arquivo: c.arquivo, status: c.status, enviadoEm: c.enviadoEm })),
    outrosPedidos: solicitacoes.filter((s) => s.adesaoId === adesao.adesaoId)
      .map((s) => ({ id: s.id, protocolo: s.protocolo, rotulo: s.payload?.assunto || s.rotulo, status: s.status, criadoEm: s.criadoEm })),
    presencas: (turma?.cronograma || []).map((e) => ({ etapa: e.etapa, data: e.data, resposta: minhas[chaveEtapa(e)] || null })),
  };
}

async function apiDaEquipe(req, res, rota, metodo, url) {
  if (metodo === 'GET' && rota === '/_equipe/config') {
    return responder(res, 200, { equipe: EQUIPE, divisao: DIVISAO, respostasProntas: RESPOSTAS_PRONTAS, metaHoras: META_HORAS });
  }
  if (metodo === 'POST' && rota === '/_equipe/divisao') {
    const { regras } = await lerCorpo(req);
    for (const r of Array.isArray(regras) ? regras : []) {
      const alvo = DIVISAO.find((d) => d.tema === r.tema);
      if (alvo && Array.isArray(r.atendentes)) alvo.atendentes = r.atendentes.filter((id) => EQUIPE.some((p) => p.id === id));
    }
    return responder(res, 200, { divisao: DIVISAO });
  }
  // Respostas prontas: a equipe vê, edita, cria e apaga (no protótipo, em memória).
  if (metodo === 'POST' && rota === '/_equipe/respostas') {
    const { respostas } = await lerCorpo(req);
    if (!Array.isArray(respostas)) return responder(res, 400, { erro: 'lista_invalida' });
    const temas = new Set(['*', ...DIVISAO.map((d) => d.tema)]);
    const acoes = new Set(['responder', 'pedir_info', 'concluir']);
    const limpas = respostas
      .map((r) => ({ tema: temas.has(r.tema) ? r.tema : '*', titulo: String(r.titulo || '').trim().slice(0, 60), acao: acoes.has(r.acao) ? r.acao : 'responder', texto: String(r.texto || '').trim().slice(0, 2000) }))
      .filter((r) => r.titulo && r.texto);
    RESPOSTAS_PRONTAS.splice(0, RESPOSTAS_PRONTAS.length, ...limpas);
    return responder(res, 200, { respostasProntas: RESPOSTAS_PRONTAS });
  }
  if (metodo === 'GET' && rota === '/_equipe/pedidos') {
    const lista = solicitacoes.filter((s) => s.tipo !== 'cancelamento').map(pedidoParaAEquipe)
      .sort((a, b) => (b.espera?.horas || 0) - (a.espera?.horas || 0) || b.criadoEm.localeCompare(a.criadoEm));
    return responder(res, 200, { pedidos: lista });
  }
  const mUm = rota.match(/^\/_equipe\/pedidos\/([\w-]+)$/);
  if (metodo === 'GET' && mUm) {
    const s = solicitacoes.find((x) => x.id === mUm[1]);
    if (!s) return responder(res, 404, { erro: 'nao_encontrado' });
    const adesao = acharAdesao(s.adesaoId);
    return responder(res, 200, {
      ...pedidoParaAEquipe(s), payload: s.payload, mensagens: s.mensagens, registros: s.registros,
      painel: adesao ? await painelDoFormando(adesao) : null,
    });
  }
  const mAnexo = rota.match(/^\/_equipe\/anexos\/([\w-]+)$/);
  if (metodo === 'GET' && mAnexo) {
    const a = anexosGuardados.get(mAnexo[1]);
    return a ? responder(res, 200, a) : responder(res, 404, { erro: 'nao_encontrado' });
  }
  const mAcao = rota.match(/^\/_equipe\/pedidos\/([\w-]+)\/acao$/);
  if (metodo === 'POST' && mAcao) {
    const s = solicitacoes.find((x) => x.id === mAcao[1]);
    if (!s) return responder(res, 404, { erro: 'nao_encontrado' });
    const corpo = await lerCorpo(req);
    const quem = EQUIPE.find((p) => p.id === corpo.quem) || EQUIPE[0];
    const texto = String(corpo.texto || '').trim();
    const guardados = guardarAnexos(corpo.anexos);
    if (guardados.erro) return responder(res, 400, { erro: guardados.erro });
    const fala = () => novaMensagem(s, 'equipe', texto, guardados.anexos, quem.nome);
    switch (corpo.acao) {
      case 'assumir':
        if (s.responsavel !== quem.id) novoRegistro(s, 'transferencia', `${quem.nome} assumiu (antes: ${nomeDaEquipe(s.responsavel)}).`, quem.nome);
        s.responsavel = quem.id;
        if (s.status === 'pendente') s.status = 'em_atendimento';
        break;
      case 'responder':
      case 'pedir_info':
        if (!texto && !guardados.anexos.length) return responder(res, 400, { erro: 'texto_obrigatorio' });
        fala();
        s.status = corpo.acao === 'pedir_info' ? 'aguardando_formando' : 'em_atendimento';
        if (!s.responsavel) s.responsavel = quem.id;
        break;
      case 'concluir':
      case 'recusar':
        if (corpo.acao === 'recusar' && texto.length < 5) return responder(res, 400, { erro: 'motivo_obrigatorio' });
        if (texto || guardados.anexos.length) fala();
        s.status = corpo.acao === 'concluir' ? 'concluida' : 'recusada';
        s.resolvidoEm = new Date().toISOString();
        novoRegistro(s, 'status', corpo.acao === 'concluir' ? 'Concluído.' : 'Recusado.', quem.nome);
        break;
      case 'nota':
        if (!texto) return responder(res, 400, { erro: 'texto_obrigatorio' });
        novoRegistro(s, 'nota', texto, quem.nome);
        break;
      case 'transferir': {
        const para = EQUIPE.find((p) => p.id === corpo.para);
        if (!para) return responder(res, 400, { erro: 'atendente_invalido' });
        novoRegistro(s, 'transferencia', `Transferido de ${nomeDaEquipe(s.responsavel)} para ${para.nome}${texto ? `: ${texto}` : ''}.`, quem.nome);
        s.responsavel = para.id;
        break;
      }
      case 'prioridade':
        if (!['normal', 'alta', 'urgente'].includes(corpo.prioridade)) return responder(res, 400, { erro: 'prioridade_invalida' });
        novoRegistro(s, 'prioridade', `Prioridade: ${s.prioridade} → ${corpo.prioridade}.`, quem.nome);
        s.prioridade = corpo.prioridade;
        break;
      case 'dar_baixa': {
        // Atalho do painel: no CRM real é a baixa manual que já existe.
        const adesao = acharAdesao(s.adesaoId);
        const b = adesao?.boletos.find((x) => x.id === corpo.billId && !x.unico);
        if (!b) return responder(res, 404, { erro: 'nao_encontrado' });
        compensarParcela(adesao, b);
        for (const c of comprovantes.filter((c) => c.adesaoId === adesao.adesaoId && c.billId === b.id)) c.status = 'conferido';
        registrarHistorico(b.id, 'Baixa manual pela equipe', `Pedido ${s.protocolo}`);
        novoRegistro(s, 'baixa', `Baixa da Parcela ${b.parcela} feita pelo painel.`, quem.nome);
        break;
      }
      default:
        return responder(res, 400, { erro: 'acao_invalida' });
    }
    console.log(`  [equipe] ${quem.nome} · ${s.protocolo} · ${corpo.acao}`);
    return responder(res, 200, { ok: true });
  }
  return responder(res, 404, { erro: 'rota_nao_encontrada', rota });
}

async function api(req, res, url) {
  const rota = url.pathname.replace('/area-formando', '');
  const metodo = req.method;

  // --- config (público) ---
  if (metodo === 'GET' && rota === '/config') {
    return responder(res, 200, {
      whatsappAtendimento: DADOS.config.whatsappAtendimento,
      nomeAtendimento: DADOS.config.nomeAtendimento,
      mostrarReajusteProgramado: DADOS.config.mostrarReajusteProgramado,
      modoDev: MODO_DEV,
      // Só no protótipo: qual CPF usar para entrar, já que ninguém recebe o código.
      cpfExemplo: MODO_DEV ? (DADOS.adesoes.find((a) => a.adesaoId === 'ades-7506-teste') || DADOS.adesoes[0])?.cpf : undefined,
      avisoDados: DADOS.aviso,
      hojeSimulado: HOJE,
      contrato: CONTRATO,
    });
  }

  // --- auth ---
  if (metodo === 'POST' && rota === '/auth/otp/solicitar') {
    const { cpf } = await lerCorpo(req);
    const doc = soDigitos(cpf);
    const neutra = { enviado: true, canais: ['whatsapp', 'email'], destinos: {}, expiraEmSegundos: OTP.expiraMs / 1000 };

    if (doc.length !== 11) return responder(res, 400, { erro: 'cpf_invalido' });

    const naHora = (pedidosNaHora.get(doc) || []).filter((t) => Date.now() - t < OTP.horaMs);
    if (naHora.length >= OTP.tetoNaHora) {
      const minutos = Math.max(1, Math.ceil((Math.min(...naHora) + OTP.horaMs - Date.now()) / 60000));
      return responder(res, 429, { erro: 'muitas_tentativas', minutos });
    }

    const anterior = codigos.get(doc);
    if (anterior && Date.now() - anterior.criadoEm < OTP.janelaMs) {
      const faltam = Math.ceil((OTP.janelaMs - (Date.now() - anterior.criadoEm)) / 1000);
      return responder(res, 429, { erro: 'aguarde', segundos: faltam });
    }

    const encontradas = adesoesPorCpf(doc);
    // Resposta neutra: em produção nunca revela se o CPF existe. No protótipo,
    // onde nenhum código é enviado de verdade, avisamos — senão a tela fica muda.
    if (!encontradas.length) return responder(res, 200, { ...neutra, cadastrado: MODO_DEV ? false : undefined });

    const codigo = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
    codigos.set(doc, { hash: hash(codigo), expiraEm: Date.now() + OTP.expiraMs, tentativas: 0, criadoEm: Date.now() });
    pedidosNaHora.set(doc, [...naHora, Date.now()]);

    const alvo = encontradas[0];
    if (MODO_DEV) console.log(`\n  [OTP] ${alvo.nome} · CPF ${doc} · código ${codigo}\n`);

    return responder(res, 200, {
      ...neutra,
      destinos: { email: mascararEmail(alvo.email), whatsapp: mascararTelefone(alvo.telefone) },
      codigoDev: MODO_DEV ? codigo : undefined,
    });
  }

  if (metodo === 'POST' && rota === '/auth/otp/verificar') {
    const { cpf, codigo } = await lerCorpo(req);
    const doc = soDigitos(cpf);
    const guardado = codigos.get(doc);
    if (!guardado || guardado.expiraEm < Date.now()) return responder(res, 401, { erro: 'codigo_invalido' });
    if (guardado.tentativas >= OTP.tentativas) return responder(res, 429, { erro: 'muitas_tentativas' });
    guardado.tentativas += 1;
    if (hash(String(codigo || '')) !== guardado.hash) return responder(res, 401, { erro: 'codigo_invalido' });
    codigos.delete(doc);

    const encontradas = adesoesPorCpf(doc);
    if (encontradas.length > 1) {
      // CPF em mais de uma turma: devolve a escolha, com um token curto de seleção.
      return responder(res, 200, {
        precisaEscolherTurma: true,
        tokenEscolha: assinarToken({ scope: 'area-formando', role: 'formando', etapa: 'escolha', cpf: doc, adesaoId: encontradas[0].adesaoId }),
        turmas: encontradas.map((a) => {
          const t = acharTurma(a.turmaId);
          return { adesaoId: a.adesaoId, turma: t.rotulo, curso: a.curso, dataEvento: t.dataEvento, cidade: t.cidade };
        }),
      });
    }

    const adesao = encontradas[0];
    registrarAcesso(adesao.adesaoId, 'login', req);
    return responder(res, 200, {
      token: assinarToken({ scope: 'area-formando', role: 'formando', adesaoId: adesao.adesaoId }),
      expiraEm: new Date(Date.now() + TTL_TOKEN).toISOString(),
    });
  }

  if (metodo === 'POST' && rota === '/auth/escolher-turma') {
    const { adesaoId } = await lerCorpo(req);
    const dados = lerToken((req.headers.authorization || '').replace(/^Bearer /i, ''));
    if (!dados || dados.etapa !== 'escolha') return responder(res, 401, { erro: 'sessao_invalida' });
    const adesao = acharAdesao(adesaoId);
    // Só pode escolher entre as adesões do próprio CPF autenticado.
    if (!adesao || adesao.cpf !== dados.cpf) return responder(res, 404, { erro: 'nao_encontrado' });
    registrarAcesso(adesao.adesaoId, 'login', req);
    return responder(res, 200, {
      token: assinarToken({ scope: 'area-formando', role: 'formando', adesaoId: adesao.adesaoId }),
      expiraEm: new Date(Date.now() + TTL_TOKEN).toISOString(),
    });
  }

  if (metodo === 'POST' && rota === '/auth/refresh') {
    const adesao = exigirFormando(req, res); if (!adesao) return;
    return responder(res, 200, {
      token: assinarToken({ scope: 'area-formando', role: 'formando', adesaoId: adesao.adesaoId }),
      expiraEm: new Date(Date.now() + TTL_TOKEN).toISOString(),
    });
  }

  // --- daqui para baixo, tudo parte do adesaoId do token ---
  // --- meus dados: o formando confere e pede correção do contato ---
  // O valor só muda de verdade depois que a equipe confere: até lá, fica pendente.
  if (metodo === 'GET' && rota === '/perfil') {
    const adesao = exigirFormando(req, res); if (!adesao) return;
    const turma = acharTurma(adesao.turmaId);
    const pendente = contatoPendente.get(adesao.adesaoId) || null;
    return responder(res, 200, {
      nome: adesao.nome,
      cpf: adesao.cpf.replace(/^(\d{3})(\d{3})(\d{3})(\d{2})$/, '$1.$2.$3-$4'),
      email: adesao.email,
      telefone: adesao.telefone,
      curso: adesao.curso,
      turma: turma.rotulo,
      pendente,
      // Os mesmos três estados do CRM (mig 1053): quem nunca escolheu recebe o
      // padrão da casa, quem escolheu recebe o dele, e quem desligou fica em 0.
      lembreteDias: lembretes.has(adesao.adesaoId)
        ? (lembretes.get(adesao.adesaoId) || null)
        : LEMBRETE_PADRAO_DIAS,
      lembreteEscolhido: lembretes.has(adesao.adesaoId),
    });
  }

  // Lembrete de vencimento: quantos dias antes avisar. null desliga.
  if (metodo === 'POST' && rota === '/perfil/lembrete') {
    const adesao = exigirFormando(req, res); if (!adesao) return;
    const { dias } = await lerCorpo(req);
    if (dias === null || dias === 0) {
      // 0 é "não quero", e precisa ficar gravado: apagar faria o formando
      // voltar ao padrão e receber de novo o aviso que ele desligou.
      lembretes.set(adesao.adesaoId, 0);
      return responder(res, 200, { lembreteDias: null, lembreteEscolhido: true });
    }
    const n = Number(dias);
    if (![1, 3, 5, 7].includes(n)) return responder(res, 400, { erro: 'prazo_invalido' });
    lembretes.set(adesao.adesaoId, n);
    const s = novaSolicitacao(adesao, 'lembrete', { mensagem: `Avisar por e-mail ${n} dia(s) antes de cada vencimento.`, quantidade: n });
    console.log(`  [${s.protocolo}] ${adesao.nome}: lembrete ${n} dia(s) antes`);
    return responder(res, 200, { lembreteDias: n, protocolo: s.protocolo });
  }

  if (metodo === 'POST' && rota === '/perfil/contato') {
    const adesao = exigirFormando(req, res); if (!adesao) return;
    const { email, telefone } = await lerCorpo(req);
    const novoEmail = String(email || '').trim();
    const novoTelefone = soDigitos(telefone);

    if (novoEmail && !/^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/.test(novoEmail)) {
      return responder(res, 400, { erro: 'email_invalido' });
    }
    if (novoTelefone && (novoTelefone.length < 10 || novoTelefone.length > 13)) {
      return responder(res, 400, { erro: 'telefone_invalido' });
    }
    const mudouEmail = novoEmail && novoEmail !== adesao.email;
    const mudouTelefone = novoTelefone && novoTelefone !== soDigitos(adesao.telefone);
    if (!mudouEmail && !mudouTelefone) return responder(res, 400, { erro: 'nada_mudou' });

    const pendente = {
      email: mudouEmail ? novoEmail : null,
      telefone: mudouTelefone ? novoTelefone : null,
      pedidoEm: new Date().toISOString(),
    };
    contatoPendente.set(adesao.adesaoId, pendente);
    const pedido = novaSolicitacao(adesao, 'dados_contato', {
      mensagem: [
        mudouEmail ? `e-mail: ${adesao.email} → ${novoEmail}` : '',
        mudouTelefone ? `telefone: ${adesao.telefone} → ${novoTelefone}` : '',
      ].filter(Boolean).join(' · '),
    });
    pendente.protocolo = pedido.protocolo;
    console.log(`  [${pedido.protocolo}] ${adesao.nome}: correção de contato`);
    return responder(res, 201, { pendente, protocolo: pedido.protocolo });
  }

  if (metodo === 'GET' && rota === '/me') {
    const adesao = exigirFormando(req, res); if (!adesao) return;
    const turma = acharTurma(adesao.turmaId);
    return responder(res, 200, {
      nome: adesao.nome,
      primeiroNome: adesao.nome.split(' ')[0],
      curso: adesao.curso,
      situacao: adesao.situacao,
      canceladaEm: adesao.canceladaEm,
      turma: { codigo: turma.codigo, rotulo: turma.rotulo, dataEvento: turma.dataEvento, cidade: turma.cidade },
    });
  }

  if (metodo === 'GET' && rota === '/financeiro') {
    const adesao = exigirFormando(req, res); if (!adesao) return;
    if (adesao.situacao === 'cancelada') return responder(res, 409, { erro: 'adesao_cancelada', canceladaEm: adesao.canceladaEm });
    registrarAcesso(adesao.adesaoId, 'financeiro', req);
    const boletos = await Promise.all(adesao.boletos.map((b) => projetarComValor(b, adesao.adesaoId, adesao)));
    // quantos comprovantes cada cobrança já tem, para o selo na linha
    for (const p of boletos) {
      p.qtdComprovantes = comprovantes.filter((c) => c.adesaoId === adesao.adesaoId && c.billId === p.id).length;
      p.contestacao = contestacaoAberta(adesao.adesaoId, p.id);
    }
    return responder(res, 200, { resumo: resumoFinanceiro(adesao, boletos), boletos });
  }

  const mBoleto = rota.match(/^\/financeiro\/([\w-]+)$/);
  if (metodo === 'GET' && mBoleto) {
    const adesao = exigirFormando(req, res); if (!adesao) return;
    // Isolamento: boleto de outra pessoa é 404, nunca 403 (não confirma existência).
    const b = adesao.boletos.find((x) => x.id === mBoleto[1]);
    if (!b) return responder(res, 404, { erro: 'nao_encontrado' });
    const status = situacaoBoleto(b);
    // sem boleto gerado ainda (ou pago pelo boleto único): nada de linha digitável
    if (status === 'agendado' || status === 'nao_gerado') {
      return responder(res, 200, {
        ...(await projetarComValor(b, adesao.adesaoId, adesao)), linhaDigitavel: null, pdfUrl: null, urlPagamento: null,
        contestacao: contestacaoAberta(adesao.adesaoId, b.id),
        comprovantes: comprovantesDoBoleto(adesao.adesaoId, b.id),
        historico: historicoDoBoleto(adesao.adesaoId, b),
      });
    }
    return responder(res, 200, {
      ...(await projetarComValor(b, adesao.adesaoId, adesao)),
      contestacao: contestacaoAberta(adesao.adesaoId, b.id),
      linhaDigitavel: b.linhaDigitavel,
      pdfUrl: b.pdfUrl,
      urlPagamento: b.urlPagamento,
      comprovantes: comprovantesDoBoleto(adesao.adesaoId, b.id),
      historico: historicoDoBoleto(adesao.adesaoId, b),
    });
  }

  // Recibo da parcela paga. No local sai PDF; o corpo em JSON serve à prévia
  // da versão publicada, que não pode iniciar download.
  const mRecibo = rota.match(/^\/financeiro\/([\w-]+)\/recibo$/);
  if (metodo === 'GET' && mRecibo) {
    const adesao = exigirFormando(req, res); if (!adesao) return;
    const b = adesao.boletos.find((x) => x.id === mRecibo[1]);
    if (!b) return responder(res, 404, { erro: 'nao_encontrado' });
    if (situacaoBoleto(b) !== 'pago') return responder(res, 409, { erro: 'parcela_nao_paga' });
    return responder(res, 200, reciboDaParcela(adesao, acharTurma(adesao.turmaId), b));
  }

  const mReciboPdf = rota.match(/^\/financeiro\/([\w-]+)\/recibo\/pdf$/);
  if (metodo === 'GET' && mReciboPdf) {
    const adesao = exigirFormando(req, res); if (!adesao) return;
    const b = adesao.boletos.find((x) => x.id === mReciboPdf[1]);
    if (!b) return responder(res, 404, { erro: 'nao_encontrado' });
    if (situacaoBoleto(b) !== 'pago') return responder(res, 409, { erro: 'parcela_nao_paga' });
    const pdf = pdfDoRecibo(reciboDaParcela(adesao, acharTurma(adesao.turmaId), b));
    res.writeHead(200, {
      'content-type': 'application/pdf',
      'content-disposition': `inline; filename="recibo-parcela-${b.parcela}.pdf"`,
      'cache-control': 'no-store',
    });
    return res.end(pdf);
  }

  // --- informe anual de pagamentos (declaração de imposto de renda) ---
  if (metodo === 'GET' && rota === '/informe-ir') {
    const adesao = exigirFormando(req, res); if (!adesao) return;
    return responder(res, 200, informeAnual(adesao));
  }

  const mInformeAno = rota.match(/^\/informe-ir\/(\d{4})$/);
  if (metodo === 'GET' && mInformeAno) {
    const adesao = exigirFormando(req, res); if (!adesao) return;
    const info = informeAnual(adesao);
    const doAno = info.anos.find((a) => a.ano === mInformeAno[1]);
    if (!doAno) return responder(res, 404, { erro: 'sem_pagamentos_no_ano' });
    const itens = adesao.boletos
      .map((b) => ({ ...b, status: situacaoBoleto(b) }))
      .filter((b) => b.status === 'pago' && (b.pagoEm || b.vencimento).startsWith(mInformeAno[1]))
      .sort((a, b) => (a.pagoEm || a.vencimento).localeCompare(b.pagoEm || b.vencimento))
      .map((b) => ({ parcela: b.parcela, vencimento: b.vencimento, pagoEm: b.pagoEm, valorPago: b.valorPago || b.valor }));
    const turma = acharTurma(adesao.turmaId);
    return responder(res, 200, {
      ...doAno, itens, prestador: info.prestador,
      formando: adesao.nome.replace(/\s*\(TESTE\)\s*/i, ''),
      cpf: adesao.cpf.replace(/^(\d{3})(\d{3})(\d{3})(\d{2})$/, '$1.$2.$3-$4'),
      turma: turma.rotulo,
    });
  }

  const mInforme = rota.match(/^\/informe-ir\/(\d{4})\/pdf$/);
  if (metodo === 'GET' && mInforme) {
    const adesao = exigirFormando(req, res); if (!adesao) return;
    const ano = mInforme[1];
    const info = informeAnual(adesao);
    const doAno = info.anos.find((a) => a.ano === ano);
    if (!doAno) return responder(res, 404, { erro: 'sem_pagamentos_no_ano' });
    const itens = adesao.boletos
      .map((b) => ({ ...b, status: situacaoBoleto(b) }))
      .filter((b) => b.status === 'pago' && (b.pagoEm || b.vencimento).startsWith(ano))
      .sort((a, b) => (a.pagoEm || a.vencimento).localeCompare(b.pagoEm || b.vencimento));
    const pdf = pdfDoInforme(adesao, acharTurma(adesao.turmaId), ano, { ...doAno, itens }, info.prestador);
    res.writeHead(200, {
      'content-type': 'application/pdf',
      'content-disposition': `inline; filename="informe-${ano}.pdf"`,
      'cache-control': 'no-store',
    });
    return res.end(pdf);
  }

  // --- comprovante de pagamento ---
  // Quem pagou por fora, ou pagou e a baixa demorou, manda o comprovante por aqui.
  // A parcela não muda de situação: quem dá baixa é a equipe, depois de conferir.
  const mComprovante = rota.match(/^\/financeiro\/([\w-]+)\/comprovante$/);
  if (metodo === 'POST' && mComprovante) {
    const adesao = exigirFormando(req, res); if (!adesao) return;
    const b = adesao.boletos.find((x) => x.id === mComprovante[1]);
    if (!b) return responder(res, 404, { erro: 'nao_encontrado' });

    const { arquivo, tipo, tamanho, conteudo, observacao } = await lerCorpo(req);
    const TIPOS_OK = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'];
    if (!arquivo || !TIPOS_OK.includes(tipo)) return responder(res, 400, { erro: 'tipo_nao_aceito' });
    if (Number(tamanho) > 8 * 1024 * 1024) return responder(res, 400, { erro: 'arquivo_grande' });

    const registro = {
      id: `comp-${comprovantes.length + 1}`,
      adesaoId: adesao.adesaoId,
      billId: b.id,
      arquivo: String(arquivo).slice(0, 120),
      tipo,
      tamanho: Number(tamanho) || 0,
      observacao: String(observacao || '').slice(0, 500),
      status: 'em_analise',
      enviadoEm: new Date().toISOString(),
      // No ambiente real, o arquivo vai para o bucket e aqui fica só a chave.
      conteudo: typeof conteudo === 'string' ? conteudo : null,
    };
    comprovantes.push(registro);
    const pedidoComp = novaSolicitacao(adesao, 'comprovante', {
      mensagem: `${nomeCobranca(b)} · ${registro.arquivo}${registro.observacao ? ' · ' + registro.observacao : ''}`,
      billId: b.id,
    });
    registro.protocolo = pedidoComp.protocolo;
    console.log(`  [comprovante] ${adesao.nome} · parcela ${b.parcela} · ${registro.arquivo} (${Math.round(registro.tamanho / 1024)} KB)`);
    const { conteudo: _, ...semArquivo } = registro;
    return responder(res, 201, semArquivo);
  }

  // --- meus comprovantes: tudo o que o formando já anexou, num lugar só ---
  if (metodo === 'GET' && rota === '/comprovantes') {
    const adesao = exigirFormando(req, res); if (!adesao) return;
    const lista = comprovantes
      .filter((c) => c.adesaoId === adesao.adesaoId)
      .sort((a, b) => b.enviadoEm.localeCompare(a.enviadoEm))
      .map(({ conteudo, adesaoId: _a, ...resto }) => {
        const b = adesao.boletos.find((x) => x.id === resto.billId);
        return { ...resto, cobranca: b ? nomeCobranca(b) : '—', vencimento: b?.vencimento || null, temArquivo: Boolean(conteudo) };
      });
    return responder(res, 200, { comprovantes: lista });
  }

  // O arquivo em si, para abrir na tela. No ambiente real, link assinado do bucket.
  const mVerComprovante = rota.match(/^\/comprovantes\/([\w-]+)$/);
  if (metodo === 'GET' && mVerComprovante) {
    const adesao = exigirFormando(req, res); if (!adesao) return;
    const c = comprovantes.find((x) => x.id === mVerComprovante[1] && x.adesaoId === adesao.adesaoId);
    if (!c) return responder(res, 404, { erro: 'nao_encontrado' });
    return responder(res, 200, { id: c.id, arquivo: c.arquivo, tipo: c.tipo, conteudo: c.conteudo });
  }

  // PDF da parcela. No ambiente real, é o PDF do boleto na Vindi.
  const mPdf = rota.match(/^\/financeiro\/([\w-]+)\/pdf$/);
  if (metodo === 'GET' && mPdf) {
    const adesao = exigirFormando(req, res); if (!adesao) return;
    const b = adesao.boletos.find((x) => x.id === mPdf[1]);
    if (!b) return responder(res, 404, { erro: 'nao_encontrado' });
    const pdf = pdfDoBoleto(adesao, acharTurma(adesao.turmaId), { ...b, status: situacaoBoleto(b) });
    res.writeHead(200, {
      'content-type': 'application/pdf',
      'content-disposition': `inline; filename="parcela-${b.parcela}-${adesao.adesaoId}.pdf"`,
      'cache-control': 'no-store',
    });
    return res.end(pdf);
  }

  // --- 2ª via de parcela vencida ---
  // Boleto vencido não é pagável: o banco recusa. Aqui o formando escolhe a nova
  // data e recebe a 2ª via com os encargos já somados.
  // Regra do protótipo (a confirmar): multa de 2% + juros de 1% ao mês, pro rata.
  // Prévia da 2ª via: a mesma conta do boleto de verdade, sem gerar nada. É o
  // que faz o valor mostrado na escolha da data bater com o do boleto.
  const mSimular2via = rota.match(/^\/financeiro\/([\w-]+)\/segunda-via\/simular$/);
  if (metodo === 'POST' && mSimular2via) {
    const adesao = exigirFormando(req, res); if (!adesao) return;
    const b = adesao.boletos.find((x) => x.id === mSimular2via[1]);
    if (!b) return responder(res, 404, { erro: 'nao_encontrado' });
    const { novoVencimento } = await lerCorpo(req);
    const problema = validarSegundaVia(b, novoVencimento);
    if (problema) return responder(res, problema.status, problema.corpo);
    return responder(res, 200, calcularEncargos(b, new Date(`${novoVencimento}T12:00:00`)));
  }

  const mSegundaVia = rota.match(/^\/financeiro\/([\w-]+)\/segunda-via$/);
  if (metodo === 'POST' && mSegundaVia) {
    const adesao = exigirFormando(req, res); if (!adesao) return;
    const b = adesao.boletos.find((x) => x.id === mSegundaVia[1]);
    if (!b) return responder(res, 404, { erro: 'nao_encontrado' });
    const { novoVencimento } = await lerCorpo(req);
    const problema = validarSegundaVia(b, novoVencimento);
    if (problema) return responder(res, problema.status, problema.corpo);
    const novaData = new Date(`${novoVencimento}T12:00:00`);

    b.vencimentoOriginal = b.vencimentoOriginal || b.vencimento;
    const encargos = calcularEncargos(b, novaData);
    b.vencimento = novoVencimento;
    b.linhaDigitavel = linhaDigitavelFalsa(`${b.id}-${novoVencimento}`);
    b.valorAtualizado = encargos.total;
    b.encargos = encargos;
    b.segundaViaEm = new Date().toISOString();
    registrarHistorico(b.id, '2ª via gerada', `Novo vencimento ${novoVencimento.split('-').reverse().join('/')} · total ${encargos.total}`);
    console.log(`  [2ª via] ${adesao.nome} · parcela ${b.parcela} · novo vencimento ${novoVencimento} · ${encargos.total}`);
    return responder(res, 200, {
      ...projetarBoleto(b),
      linhaDigitavel: b.linhaDigitavel,
      pdfUrl: b.pdfUrl,
      urlPagamento: b.urlPagamento,
      encargos,
      comprovantes: comprovantesDoBoleto(adesao.adesaoId, b.id),
    });
  }

  // --- antecipação: o portal emite um boleto único com as parcelas escolhidas ---
  // /simular devolve a composição sem gerar nada; a rota sem sufixo gera.
  const mAntecipar = rota.match(/^\/financeiro\/antecipar(\/simular)?$/);
  if (metodo === 'POST' && mAntecipar) {
    const adesao = exigirFormando(req, res); if (!adesao) return;
    const { billIds } = await lerCorpo(req);
    const r = await montarUnico(adesao, billIds);
    if (r.erro) return responder(res, 400, { erro: r.erro });
    // a simulação já mostra a taxa: N boletos viram um, e a taxa é cobrada uma vez
    if (mAntecipar[1]) {
      const taxa = taxaDoContrato(adesao);
      return responder(res, 200, {
        ...r.unico,
        taxaBoleto: taxa,
        totalBoleto: arredonda(r.unico.valor + taxa),
        economiaTaxa: arredonda(taxa * (r.unico.unico.parcelas.length - 1)),
      });
    }

    const u = r.unico;
    sequencialUnico += 1;   // a numeração só avança quando o boleto é gerado
    adesao.boletos.push(u);
    unicosPorId.set(u.id, u);
    for (const item of u.unico.parcelas) {
      const b = adesao.boletos.find((x) => x.id === item.id);
      b.noUnico = u.id;
      registrarHistorico(b.id, 'Incluída num boleto único', `Vence em ${u.vencimento.split('-').reverse().join('/')} · a parcela continua com o boleto dela`);
    }
    registrarHistorico(u.id, 'Boleto único gerado', `${u.unico.parcelas.length} parcela(s) · total ${u.valor}`);
    console.log(`  [boleto único] ${adesao.nome} · ${u.unico.parcelas.length} parcela(s) · ${u.valor} · vence ${u.vencimento}`);
    return responder(res, 201, { ...(await projetarComValor(u, adesao.adesaoId, adesao)), linhaDigitavel: u.linhaDigitavel });
  }

  if (metodo === 'GET' && rota === '/contrato') {
    const adesao = exigirFormando(req, res); if (!adesao) return;
    registrarAcesso(adesao.adesaoId, 'contrato', req);
    const turma = acharTurma(adesao.turmaId);
    return responder(res, 200, {
      termo: {
        assinadoEm: adesao.contrato.assinadoEm,
        origem: adesao.contrato.docusealSubmissionId ? 'docuseal' : 'anexo',
        url: adesao.contrato.termoUrl,
      },
      contratoColetivo: { turma: turma.rotulo, url: adesao.contrato.contratoColetivoUrl },
      contratado: {
        total: adesao.contrato.total,
        parcelas: adesao.contrato.parcelas,
        mensalidade: adesao.contrato.mensalidade,
        primeiraParcela: adesao.contrato.primeiraParcela,
      },
      taxaBoleto: adesao.contrato.taxaBoleto ?? null,
      convites: adesao.convites,
      solicitacoes: solicitacoes.filter((s) => s.adesaoId === adesao.adesaoId).map((s) => pedidoParaOFormando(s)),
    });
  }

  // Multas do contrato e a faixa de hoje (o CRM responde o mesmo formato).
  if (metodo === 'GET' && rota === '/cancelamento/condicoes') {
    const adesao = exigirFormando(req, res); if (!adesao) return;
    const turma = acharTurma(adesao.turmaId);
    const dataFesta = turma?.dataEvento ? String(turma.dataEvento).slice(0, 10) : null;
    const dias = dataFesta ? Math.round((new Date(`${dataFesta}T12:00:00`) - new Date(`${HOJE}T12:00:00`)) / 86400000) : null;
    const faixa = faixaPenal(dias);
    const valorAdesao = Number(adesao.contrato?.total || 0);
    const aberto = solicitacoes.find((s) => s.adesaoId === adesao.adesaoId && s.tipo === 'cancelamento' && estaAberta(s));
    return responder(res, 200, {
      // Sem valor em reais (decisão de 05/10/2026): o portal mostra só o percentual.
      dataFesta, diasAteFesta: dias, escada: ESCADA_PENAL, faixa, valorAdesao,
      pedidoAberto: aberto ? { protocolo: aberto.protocolo, criadoEm: aberto.criadoEm } : null,
      jaCancelada: false,
    });
  }

  if (metodo === 'POST' && rota === '/solicitacoes') {
    const adesao = exigirFormando(req, res); if (!adesao) return;
    const corpoPedido = await lerCorpo(req);
    const { tipo, mensagem, quantidade, conviteTipo, billId, motivo } = corpoPedido;
    if (!TIPOS_SOLICITACAO[tipo]) return responder(res, 400, { erro: 'tipo_invalido' });
    if (tipo === 'cancelamento') {
      const p = corpoPedido.payload || {};
      if (!p.motivo || p.ciente !== true) return responder(res, 400, { erro: 'motivo_obrigatorio' });
      if (solicitacoes.some((s) => s.adesaoId === adesao.adesaoId && s.tipo === 'cancelamento' && estaAberta(s))) {
        return responder(res, 409, { erro: 'cancelamento_ja_pedido' });
      }
      const s = novaSolicitacao(adesao, tipo, { ...p, mensagem: [p.motivo, p.motivoDetalhe, p.observacoes].filter(Boolean).join(' — ') });
      console.log(`  [${s.protocolo}] ${adesao.nome}: pedido de cancelamento (${p.motivo})`);
      return responder(res, 201, s);
    }
    if (tipo === 'contestacao' && billId && contestacaoAberta(adesao.adesaoId, billId)) {
      return responder(res, 409, { erro: 'contestacao_ja_aberta' });
    }
    if (billId && !adesao.boletos.some((b) => b.id === billId)) return responder(res, 404, { erro: 'nao_encontrado' });
    const guardados = guardarAnexos(corpoPedido.anexos);
    if (guardados.erro) return responder(res, 400, { erro: guardados.erro });
    // Campos do formulário: o que o formando escolheu e preencheu, como ele viu.
    const campos = (Array.isArray(corpoPedido.campos) ? corpoPedido.campos : []).slice(0, 12)
      .map((c) => ({ rotulo: String(c?.rotulo || '').slice(0, 80), valor: String(c?.valor || '').slice(0, 500) }))
      .filter((c) => c.rotulo && c.valor);
    const s = novaSolicitacao(adesao, tipo, {
      mensagem: String(mensagem || '').slice(0, 4000),
      quantidade: quantidade || null,
      conviteTipo: conviteTipo || null,
      billId: billId || null,
      motivo: motivo || null,
      tema: corpoPedido.tema || null,
      assunto: corpoPedido.assunto ? String(corpoPedido.assunto).slice(0, 120) : null,
      campos,
      anexosDaAbertura: guardados.anexos,
    });
    // "Paguei e continua em aberto" com o comprovante anexado: a parcela entra em
    // análise na hora, como quando ele anexa pela própria parcela.
    if (tipo === 'contestacao' && billId && guardados.anexos.length) {
      for (const a of guardados.anexos) {
        comprovantes.push({
          id: `comp-${comprovantes.length + 1}`, adesaoId: adesao.adesaoId, billId, arquivo: a.arquivo, tipo: a.tipo,
          tamanho: a.tamanho, observacao: `Anexado no pedido ${s.protocolo}`, status: 'em_analise',
          enviadoEm: new Date().toISOString(), conteudo: anexosGuardados.get(a.id)?.conteudo || null, protocolo: s.protocolo,
        });
      }
    }
    console.log(`  [${s.protocolo}] ${adesao.nome}: ${tipo}${guardados.anexos.length ? ` · ${guardados.anexos.length} anexo(s)` : ''} → ${nomeDaEquipe(s.responsavel)}`);
    return responder(res, 201, pedidoParaOFormando(s));
  }

  // --- um pedido, com a conversa ---
  const mPedido = rota.match(/^\/solicitacoes\/([\w-]+)$/);
  if (metodo === 'GET' && mPedido) {
    const adesao = exigirFormando(req, res); if (!adesao) return;
    const s = solicitacoes.find((x) => x.id === mPedido[1] && x.adesaoId === adesao.adesaoId);
    if (!s) return responder(res, 404, { erro: 'nao_encontrado' });
    return responder(res, 200, pedidoParaOFormando(s, { comMensagens: true }));
  }

  // O formando responde. Pedido resolvido há até 7 dias volta para a equipe
  // ("isso não resolveu"); depois disso, é pedido novo.
  const mResponder = rota.match(/^\/solicitacoes\/([\w-]+)\/mensagens$/);
  if (metodo === 'POST' && mResponder) {
    const adesao = exigirFormando(req, res); if (!adesao) return;
    const s = solicitacoes.find((x) => x.id === mResponder[1] && x.adesaoId === adesao.adesaoId);
    if (!s) return responder(res, 404, { erro: 'nao_encontrado' });
    const corpo = await lerCorpo(req);
    const texto = String(corpo.texto || '').trim();
    if (texto.length < 2 && !(corpo.anexos || []).length) return responder(res, 400, { erro: 'texto_obrigatorio' });
    const reabre = ['concluida', 'atendida', 'recusada'].includes(s.status);
    if (reabre && Date.now() - new Date(s.resolvidoEm || s.criadoEm).getTime() > 7 * 86400000) {
      return responder(res, 409, { erro: 'pedido_encerrado' });
    }
    if (s.status === 'cancelada') return responder(res, 409, { erro: 'pedido_encerrado' });
    const guardados = guardarAnexos(corpo.anexos);
    if (guardados.erro) return responder(res, 400, { erro: guardados.erro });
    novaMensagem(s, 'formando', texto, guardados.anexos);
    if (reabre) { novoRegistro(s, 'reaberto', 'O formando respondeu depois do encerramento: o pedido voltou para a fila.'); s.resolvidoEm = null; }
    // A bola volta para a equipe.
    s.status = s.status === 'pendente' || reabre ? 'pendente' : 'em_atendimento';
    console.log(`  [${s.protocolo}] ${adesao.nome} respondeu${reabre ? ' (reabriu)' : ''}`);
    return responder(res, 201, pedidoParaOFormando(s, { comMensagens: true }));
  }

  // Ver um anexo da conversa (do formando ou da equipe).
  const mAnexo = rota.match(/^\/solicitacoes\/([\w-]+)\/anexos\/([\w-]+)$/);
  if (metodo === 'GET' && mAnexo) {
    const adesao = exigirFormando(req, res); if (!adesao) return;
    const s = solicitacoes.find((x) => x.id === mAnexo[1] && x.adesaoId === adesao.adesaoId);
    const existe = s && s.mensagens.some((m) => m.anexos.some((a) => a.id === mAnexo[2]));
    if (!existe) return responder(res, 404, { erro: 'nao_encontrado' });
    return responder(res, 200, anexosGuardados.get(mAnexo[2]));
  }

  // Aviso no celular (mig 1247 no CRM). Aqui só guarda a inscrição: o protótipo
  // não envia push (a chave é de teste, sem a privada).
  if (metodo === 'GET' && rota === '/push/chave') {
    if (!exigirFormando(req, res)) return;
    return responder(res, 200, { chave: 'BCgjTepj7r_dgkeWJ1TyxWib31DMjc-19_GkI7d0P6jevjgebz0p-g6vhqoRFS1su2_Y0TT03R0vfTCiUi2h6Ek' });
  }
  if (metodo === 'POST' && (rota === '/push/inscricao' || rota === '/push/inscricao/remover')) {
    if (!exigirFormando(req, res)) return;
    return responder(res, 200, { ativo: rota === '/push/inscricao' });
  }

  // Todos os pedidos do formando, com protocolo e prazo — é o que responde ao
  // "abri um pedido e ninguém me deu retorno".
  if (metodo === 'GET' && rota === '/solicitacoes') {
    const adesao = exigirFormando(req, res); if (!adesao) return;
    return responder(res, 200, {
      solicitacoes: solicitacoes
        .filter((s) => s.adesaoId === adesao.adesaoId)
        .sort((a, b) => b.criadoEm.localeCompare(a.criadoEm))
        .map((s) => pedidoParaOFormando(s)),
    });
  }

  // Extrato: tudo o que foi pago, o que falta e como está composto o contrato.
  if (metodo === 'GET' && rota === '/extrato') {
    const adesao = exigirFormando(req, res); if (!adesao) return;
    return responder(res, 200, await extratoDoFormando(adesao));
  }

  if (metodo === 'GET' && rota === '/extrato/pdf') {
    const adesao = exigirFormando(req, res); if (!adesao) return;
    const pdf = pdfDoExtrato(adesao, acharTurma(adesao.turmaId), await extratoDoFormando(adesao));
    res.writeHead(200, {
      'content-type': 'application/pdf',
      'content-disposition': `inline; filename="extrato-${adesao.adesaoId}.pdf"`,
      'cache-control': 'no-store',
    });
    return res.end(pdf);
  }

  if (metodo === 'GET' && rota === '/turma') {
    const adesao = exigirFormando(req, res); if (!adesao) return;
    registrarAcesso(adesao.adesaoId, 'turma', req);
    return responder(res, 200, projetarTurma(acharTurma(adesao.turmaId), adesao.adesaoId));
  }

  // Confirmação de presença numa etapa do cronograma.
  if (metodo === 'POST' && rota === '/turma/presenca') {
    const adesao = exigirFormando(req, res); if (!adesao) return;
    const { chave, resposta } = await lerCorpo(req);
    const turma = acharTurma(adesao.turmaId);
    const etapa = turma.cronograma.find((e) => chaveEtapa(e) === chave);
    if (!etapa) return responder(res, 404, { erro: 'etapa_nao_encontrada' });
    if (!['sim', 'nao'].includes(resposta)) return responder(res, 400, { erro: 'resposta_invalida' });

    const minhas = presencas.get(adesao.adesaoId) || {};
    minhas[chave] = resposta;
    presencas.set(adesao.adesaoId, minhas);
    const s = novaSolicitacao(adesao, 'presenca', {
      mensagem: `${etapa.etapa} (${etapa.data}): ${resposta === 'sim' ? 'vou' : 'não vou'}.`,
    });
    console.log(`  [${s.protocolo}] ${adesao.nome}: presença em ${etapa.etapa} = ${resposta}`);
    return responder(res, 200, { chave, presenca: resposta, protocolo: s.protocolo });
  }

  // --- central de avisos ---
  if (metodo === 'GET' && rota === '/notificacoes') {
    const adesao = exigirFormando(req, res); if (!adesao) return;
    return responder(res, 200, notificacoes(adesao));
  }

  if (metodo === 'POST' && rota === '/notificacoes/lidas') {
    const adesao = exigirFormando(req, res); if (!adesao) return;
    const { ids } = await lerCorpo(req);
    const vistas = lidas.get(adesao.adesaoId) || new Set();
    for (const id of Array.isArray(ids) ? ids : []) vistas.add(String(id));
    lidas.set(adesao.adesaoId, vistas);
    return responder(res, 200, { naoLidas: notificacoes(adesao).naoLidas });
  }

  // Termo de adesão e contrato coletivo em PDF. No ambiente real, link assinado
  // de curta duração para o arquivo do DocuSeal.
  if (metodo === 'GET' && rota === '/contrato/termo/pdf') {
    const adesao = exigirFormando(req, res); if (!adesao) return;
    const pdf = pdfDoTermo(adesao, acharTurma(adesao.turmaId));
    res.writeHead(200, {
      'content-type': 'application/pdf',
      'content-disposition': `inline; filename="termo-${adesao.adesaoId}.pdf"`,
      'cache-control': 'no-store',
    });
    return res.end(pdf);
  }

  // Só no protótipo: espelha o que a equipe veria na aba de acessos da turma.
  // Só no protótipo: faz os boletos únicos do formando vencerem ontem, para ver
  // a expiração sem esperar três dias (a data de "hoje" é fixa nos dados).
  if (MODO_DEV && metodo === 'POST' && rota === '/_dev/expirar-unicos') {
    const adesao = exigirFormando(req, res); if (!adesao) return;
    const ontem = new Date(`${HOJE}T12:00:00`);
    ontem.setDate(ontem.getDate() - 1);
    const unicos = adesao.boletos.filter((b) => b.unico && b.status !== 'pago');
    for (const u of unicos) u.vencimento = ontem.toISOString().slice(0, 10);
    return responder(res, 200, { expirados: unicos.map((u) => u.id) });
  }

  // Só no protótipo: simula a compensação do boleto único. As parcelas dele são
  // quitadas e os boletos delas deixam de valer — é o que a Vindi fará de verdade.
  if (MODO_DEV && metodo === 'POST' && rota === '/_dev/pagar-unicos') {
    const adesao = exigirFormando(req, res); if (!adesao) return;
    const unicos = adesao.boletos.filter((b) => b.unico && situacaoBoleto(b) === 'em_aberto');
    for (const u of unicos) compensarUnico(adesao, u);
    return responder(res, 200, { pagos: unicos.map((u) => u.id) });
  }

  // Só no protótipo: simula a compensação do boleto de UMA parcela, pago sozinho.
  if (MODO_DEV && metodo === 'POST' && rota === '/_dev/pagar-parcela') {
    const adesao = exigirFormando(req, res); if (!adesao) return;
    const { billId } = await lerCorpo(req);
    const b = adesao.boletos.find((x) => x.id === billId && !x.unico);
    if (!b) return responder(res, 404, { erro: 'nao_encontrado' });
    compensarParcela(adesao, b);
    return responder(res, 200, { pago: b.id });
  }

  // ===== TELA DA EQUIPE (só no protótipo) =====================================
  // Simula a fila do CRM (Área do Formando › Solicitações) para testar o
  // atendimento de ponta a ponta: o que a equipe faz aqui o formando vê no portal.
  if (rota.startsWith('/_equipe/')) {
    if (!MODO_DEV) return responder(res, 404, { erro: 'rota_nao_encontrada' });
    return apiDaEquipe(req, res, rota, metodo, url);
  }

  if (metodo === 'GET' && rota === '/_acessos') {
    return responder(res, 200, { acessos: acessos.slice(-100), solicitacoes });
  }

  return responder(res, 404, { erro: 'rota_nao_encontrada', rota });
}

/**
 * LIGAR O PORTAL LOCAL AO CRM LOCAL (14/10/2026).
 *
 * Com `API_CRM=http://localhost:3333/api/area-formando node servidor.mjs`, o
 * index servido aqui recebe a URL da API e o portal passa a ler dados REAIS —
 * é o único jeito de testar o que só existe no CRM (compra de convites, por
 * exemplo), sem mexer no `publico/index.html`, que é o mesmo arquivo que vai
 * ao ar.
 *
 * Sem a variável nada muda: o protótipo segue com os dados de exemplo.
 */
const API_CRM_LOCAL = process.env.API_CRM || '';

function comApiDoCrm(html) {
  if (!API_CRM_LOCAL) return html;
  const tag = `<script>window.API_URL = ${JSON.stringify(API_CRM_LOCAL)};</script>`;
  const texto = String(html);
  // Antes do app.js, para o adaptador do CRM se instalar na carga.
  return texto.includes('<script')
    ? texto.replace('<script', `${tag}
  <script`)
    : texto + tag;
}

function estatico(req, res, url) {
  // A tela da equipe (simulação da fila do CRM) mora fora de publico/: ela
  // nunca vai para o site publicado.
  if (MODO_DEV && /^\/equipe\/?$/.test(url.pathname)) {
    fs.readFile(path.join(AQUI, 'equipe', 'index.html'), (erro, html) => {
      if (erro) { res.writeHead(404).end(); return; }
      res.writeHead(200, { 'content-type': TIPOS['.html'], 'cache-control': 'no-store' }); res.end(html);
    });
    return;
  }
  let caminho = url.pathname === '/' ? '/index.html' : url.pathname;
  if (caminho.startsWith('/formando')) caminho = caminho.replace(/^\/formando\/?/, '/') || '/index.html';
  const arquivo = path.join(AQUI, 'publico', path.normalize(caminho).replace(/^[\\/]+/, ''));
  if (!arquivo.startsWith(path.join(AQUI, 'publico'))) { res.writeHead(403).end(); return; }
  fs.readFile(arquivo, (erro, conteudo) => {
    if (erro) {
      // SPA: qualquer rota desconhecida cai no index.
      fs.readFile(path.join(AQUI, 'publico', 'index.html'), (e2, html) => {
        if (e2) { res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('não encontrado'); return; }
        res.writeHead(200, { 'content-type': TIPOS['.html'] }); res.end(comApiDoCrm(html));
      });
      return;
    }
    res.writeHead(200, { 'content-type': TIPOS[path.extname(arquivo)] || 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(path.extname(arquivo) === '.html' ? comApiDoCrm(conteudo) : conteudo);
  });
}

http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORTA}`);
  if (url.pathname.startsWith('/area-formando')) {
    api(req, res, url).catch((erro) => { console.error(erro); responder(res, 500, { erro: 'falha_interna' }); });
    return;
  }
  estatico(req, res, url);
}).listen(PORTA, () => {
  const exemplos = DADOS.adesoes.slice(0, 3);
  console.log('');
  console.log('  Área do Formando — ambiente local de testes');
  if (API_CRM_LOCAL) {
    console.log(`  LIGADO AO CRM: ${API_CRM_LOCAL}`);
    console.log('  Os dados são REAIS. Entre com o CPF de um formando de verdade.');
  }
  console.log(`  http://localhost:${PORTA}/`);
  if (MODO_DEV) console.log(`  Tela da equipe (fila de pedidos): http://localhost:${PORTA}/equipe`);
  console.log('');
  console.log(`  ${DADOS.aviso}`);
  console.log(`  Data simulada: ${HOJE} · turma ${DADOS.turmas[0].rotulo}`);
  console.log('');
  console.log('  CPFs para entrar (o código aparece na tela e aqui no terminal):');
  const meu = DADOS.adesoes.find((a) => a.adesaoId === 'ades-7506-teste');
  if (meu) console.log(`    ${meu.cpf}  ${meu.nome}  <- o seu cadastro de teste`);
  exemplos.forEach((a) => console.log(`    ${a.cpf}  ${a.nome}`));
  console.log(`    ${DADOS.adesoes.find((a) => a.situacao === 'cancelada').cpf}  adesão cancelada`);
  const dupla = DADOS.adesoes.find((a) => a.adesaoId === 'ades-dupla-02');
  if (dupla) console.log(`    ${dupla.cpf}  mesmo CPF em duas turmas`);
  console.log('');
  console.log('  Lista completa: dados/exemplo.json · Ctrl+C para parar');
  console.log('');
});
