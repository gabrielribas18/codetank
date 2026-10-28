
import express from 'express';
import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState
} from '@whiskeysockets/baileys';
import qrcode from 'qrcode-terminal';
import fs from 'node:fs';
import path from 'node:path';

const PORT = Number(process.env.PORT || 3000);
const GROUP_ONLY = process.env.GROUP_ONLY || '';
const DATA_DIR = process.env.DATA_DIR || './data';
const AUTH_DIR = process.env.AUTH_DIR || './auth';

const ESTOQUE_INICIAL = 10000;
const CAPACIDADE_MAXIMA = 14500;
const LIMITE_ALERTA = 8000;

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(AUTH_DIR, { recursive: true });

const DB_FILE = path.join(DATA_DIR, 'tanque.json');

function salvarBanco() {
  const temporario = `${DB_FILE}.tmp`;
  fs.writeFileSync(temporario, JSON.stringify(banco, null, 2));
  fs.renameSync(temporario, DB_FILE);
}

function carregarBanco() {
  if (fs.existsSync(DB_FILE)) {
    return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  }

  const novo = {
    estoque: ESTOQUE_INICIAL,
    movimentacoes: [{
      tipo: 'INICIAL',
      litros: ESTOQUE_INICIAL,
      remetente: 'Sistema',
      nome: 'Sistema',
      mensagem: 'Estoque inicial configurado',
      timestamp: new Date().toISOString(),
      data: new Date().toLocaleString('pt-BR', {
        timeZone: 'America/Sao_Paulo'
      })
    }],
    ultimoRelatorio: ''
  };

  fs.writeFileSync(DB_FILE, JSON.stringify(novo, null, 2));
  return novo;
}

let banco = carregarBanco();

function formatarLitros(valor) {
  return Number(valor).toLocaleString('pt-BR', {
    maximumFractionDigits: 2
  });
}

function textoEstoque() {
  let texto =
    `Estoque atual: ${formatarLitros(banco.estoque)} L\n` +
    `Capacidade máxima: ${formatarLitros(CAPACIDADE_MAXIMA)} L`;

  if (banco.estoque <= LIMITE_ALERTA) {
    texto += '\n⚠️ ALERTA: estoque em 8.000 L ou menos!';
  }

  return texto;
}

function textoRelatorio() {
  const ultimas = banco.movimentacoes.slice(-30).reverse();

  const linhas = ultimas.map(m =>
    `${m.data} | ${m.tipo} | ${m.tipo === 'ABASTECIDO' ? '-' : '+'}${formatarLitros(m.litros)} L | ${m.nome}`
  );

  return `RELATÓRIO DIÁRIO DO TANQUE\n${textoEstoque()}\n\nÚltimas movimentações:\n${
    linhas.join('\n') || 'Nenhuma movimentação registrada.'
  }`;
}

function processarMensagem(texto, remetente, nome) {
  const comando = texto.trim().toUpperCase();

  if (comando === 'ESTOQUE') return textoEstoque();

  if (comando === 'AJUDA') {
    return [
      'COMANDOS DO CODE TANK',
      'ESTOQUE',
      'ABASTECIDO: 250',
      'ENTRADA: 5000',
      'RECEBIDO: 5000',
      'RELATORIO',
      '',
      'Digite litros sem separador de milhar: 5000, não 5.000.'
    ].join('\n');
  }

  if (comando === 'RELATORIO' || comando === 'RELATÓRIO') {
    return textoRelatorio();
  }

  const resultado = texto.match(
    /^\s*(ABASTECIDO|ENTRADA|RECEBIDO)\s*:\s*(\d+(?:[.,]\d+)?)/im
  );

  if (!resultado) return null;

  const tipo = resultado[1].toUpperCase() === 'ABASTECIDO'
    ? 'ABASTECIDO'
    : 'ENTRADA';

  const quantidade = Number(resultado[2].replace(',', '.'));

  if (!Number.isFinite(quantidade) || quantidade <= 0) {
    return 'ERRO: informe uma quantidade maior que zero.';
  }

  if (tipo === 'ABASTECIDO') {
    const limite = Date.now() - 20 * 60 * 1000;

    const recentes = banco.movimentacoes.filter(m =>
      m.tipo === 'ABASTECIDO' &&
      m.remetente === remetente &&
      new Date(m.timestamp).getTime() >= limite
    );

    if (recentes.length >= 2) {
      return 'LIMITE ATINGIDO: você já registrou dois abastecimentos nos últimos 20 minutos. Nenhum litro foi descontado.';
    }

    if (quantidade > banco.estoque) {
      return `ERRO: estoque insuficiente. Disponível: ${formatarLitros(banco.estoque)} L.`;
    }

    banco.estoque -= quantidade;
  } else {
    if (banco.estoque + quantidade > CAPACIDADE_MAXIMA) {
      const espaco = CAPACIDADE_MAXIMA - banco.estoque;
      return `ERRO: capacidade excedida. Espaço disponível: ${formatarLitros(espaco)} L.`;
    }

    banco.estoque += quantidade;
  }

  banco.movimentacoes.push({
    tipo,
    litros: quantidade,
    remetente,
    nome,
    mensagem: texto,
    timestamp: new Date().toISOString(),
    data: new Date().toLocaleString('pt-BR', {
      timeZone: 'America/Sao_Paulo'
    })
  });

  salvarBanco();

  const sinal = tipo === 'ABASTECIDO' ? '-' : '+';

  return `${tipo === 'ABASTECIDO' ? 'Abastecimento' : 'Entrada'} registrada: ${sinal}${formatarLitros(quantidade)} L.\n${textoEstoque()}`;
}

// Servidor para verificar se o serviço está ativo.
const app = express();

app.get('/', (_req, res) => {
  res.send('Code Tank está ativo.');
});

app.get('/health', (_req, res) => {
  res.json({ ativo: true, estoque: banco.estoque });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Servidor ativo na porta ${PORT}`);
});

let socketWhatsApp;
let reconectando = false;

async function conectarWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

  const socket = makeWASocket({
    auth: state,
    browser: ['Code Tank', 'Chrome', '1.0.0'],
    printQRInTerminal: false,
    markOnlineOnConnect: false
  });

  socketWhatsApp = socket;
  socket.ev.on('creds.update', saveCreds);

  socket.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      console.log('Escaneie o QR Code com o WhatsApp:');
      qrcode.generate(qr, { small: true });
      console.log('WhatsApp > Aparelhos conectados > Conectar um aparelho');
    }

    if (connection === 'open') {
      console.log('WhatsApp conectado!');
      reconectando = false;
    }

    if (connection === 'close' && !reconectando) {
      const motivo = lastDisconnect?.error?.output?.statusCode;
      if (motivo === DisconnectReason.loggedOut) {
        console.error('Sessão encerrada. Será necessário conectar novamente.');
        return;
      }

      reconectando = true;
      setTimeout(() => {
        conectarWhatsApp().catch(erro =>
          console.error('Falha ao reconectar:', erro)
        );
      }, 3000);
    }
  });

  socket.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;

    for (const mensagem of messages) {
      if (!mensagem.message || mensagem.key.fromMe) continue;

      const grupo = mensagem.key.remoteJid;
      if (!grupo?.endsWith('@g.us')) continue;
      if (GROUP_ONLY && grupo !== GROUP_ONLY) continue;

      const texto =
        mensagem.message.conversation ||
        mensagem.message.extendedTextMessage?.text ||
        mensagem.message.imageMessage?.caption ||
        mensagem.message.videoMessage?.caption ||
        '';

      if (!texto.trim()) continue;

      const remetente = mensagem.key.participant || grupo;
      const nome = mensagem.pushName || remetente;
      const resposta = processarMensagem(texto, remetente, nome);

      if (resposta) {
        try {
          await socket.sendMessage(grupo, { text: resposta });
        } catch (erro) {
          console.error('Erro ao responder no grupo:', erro);
        }
      }
    }
  });
}

// Relatório automático às 19h, horário de Brasília.
// Só envia para o grupo quando GROUP_ONLY estiver configurado.
function partesHorarioBrasilia() {
  const partes = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(new Date());

  return Object.fromEntries(partes.map(p => [p.type, p.value]));
}

setInterval(async () => {
  try {
    const horario = partesHorarioBrasilia();
    const hoje = `${horario.year}-${horario.month}-${horario.day}`;

    if (horario.hour !== '19' || horario.minute !== '00') return;
    if (banco.ultimoRelatorio === hoje) return;

    if (!GROUP_ONLY || !socketWhatsApp?.user) {
      console.log('Relatório das 19h pendente: configure GROUP_ONLY e conecte o WhatsApp.');
      return;
    }

    await socketWhatsApp.sendMessage(GROUP_ONLY, {
      text: textoRelatorio()
    });

    banco.ultimoRelatorio = hoje;
    salvarBanco();
    console.log(`Relatório diário enviado em ${hoje}.`);
  } catch (erro) {
    console.error('Erro no relatório diário:', erro);
  }
}, 15000);

conectarWhatsApp().catch(erro => {
  console.error('Erro ao iniciar o WhatsApp:', erro);
});
