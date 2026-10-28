
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

function carregarBanco() {
  if (fs.existsSync(DB_FILE)) {
    return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  }

  const banco = {
    estoque: ESTOQUE_INICIAL,
    movimentacoes: [],
    ultimoRelatorio: ''
  };

  salvarBanco(banco);
  return banco;
}

function salvarBanco() {
  const temporario = `${DB_FILE}.tmp`;
  fs.writeFileSync(temporario, JSON.stringify(banco, null, 2));
  fs.renameSync(temporario, DB_FILE);
}

let banco = carregarBanco();

function litros(valor) {
  return Number(valor).toLocaleString('pt-BR', {
    maximumFractionDigits: 2
  });
}

function textoEstoque() {
  let texto =
    `Estoque atual: ${litros(banco.estoque)} L\n` +
    `Capacidade máxima: ${litros(CAPACIDADE_MAXIMA)} L`;

  if (banco.estoque <= LIMITE_ALERTA) {
    texto += '\n⚠️ ALERTA: estoque em 8.000 L ou menos!';
  }

  return texto;
}

function processarMensagem(texto, remetente, nome) {
  const comando = texto.trim().toUpperCase();

  if (comando === 'ESTOQUE') {
    return textoEstoque();
  }

  if (comando === 'AJUDA') {
    return [
      'COMANDOS DO CODE TANK',
      'ESTOQUE',
      'ABASTECIDO: 250',
      'ENTRADA: 5000',
      'RECEBIDO: 5000',
      'RELATORIO',
      '',
      'Digite os litros sem separador de milhar.'
    ].join('\n');
  }

  if (comando === 'RELATORIO' || comando === 'RELATÓRIO') {
    const ultimas = banco.movimentacoes.slice(-30).reverse();

    const linhas = ultimas.map(m =>
      `${m.data} | ${m.tipo} | ${m.litros} L | ${m.nome}`
    );

    return `RELATÓRIO DO TANQUE\n${textoEstoque()}\n\n` +
      (linhas.join('\n') || 'Nenhuma movimentação registrada.');
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
      return `ERRO: estoque insuficiente. Disponível: ${litros(banco.estoque)} L.`;
    }

    banco.estoque -= quantidade;
  } else {
    if (banco.estoque + quantidade > CAPACIDADE_MAXIMA) {
      const espaco = CAPACIDADE_MAXIMA - banco.estoque;
      return `ERRO: capacidade excedida. Espaço disponível: ${litros(espaco)} L.`;
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

  return `${tipo === 'ABASTECIDO' ? 'Abastecimento' : 'Entrada'} registrada: ${sinal}${litros(quantidade)} L.\n${textoEstoque()}`;
}

// Página simples para verificar se o serviço está ativo.
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

async function conectarWhatsApp() {
  const { state, saveCreds } =
    await useMultiFileAuthState(AUTH_DIR);

  const socket = makeWASocket({
    auth: state,
    browser: ['Code Tank', 'Chrome', '1.0.0'],
    printQRInTerminal: false,
    markOnlineOnConnect: false
  });

  socket.ev.on('creds.update', saveCreds);

  socket.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      console.log('Escaneie o QR Code com o WhatsApp:');
      qrcode.generate(qr, { small: true });
      console.log('WhatsApp > Aparelhos conectados > Conectar um aparelho');
    }

    if (connection === 'open') {
      console.log('WhatsApp conectado!');
    }

    if (
      connection === 'close' &&
      lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut
    ) {
      setTimeout(() => conectarWhatsApp().catch(console.error), 3000);
    }
  });

  socket.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;

    for (const mensagem of messages) {
      if (!mensagem.message || mensagem.key.fromMe) continue;

      const grupo = mensagem.key.remoteJid;

      // O bot só responde em grupos.
      if (!grupo?.endsWith('@g.us')) continue;

      // Quando configurado, restringe ao grupo autorizado.
      if (GROUP_ONLY && grupo !== GROUP_ONLY) continue;

      const texto =
        mensagem.message.conversation ||
        mensagem.message.extendedTextMessage?.text ||
        '';

      if (!texto.trim()) continue;

      const remetente = mensagem.key.participant || grupo;
      const nome = mensagem.pushName || remetente;

      const resposta = processarMensagem(texto, remetente, nome);

      if (resposta) {
        await socket.sendMessage(grupo, { text: resposta });
      }
    }
  });

  return socket;
}

conectarWhatsApp().catch(erro => {
  console.error('Erro ao iniciar o WhatsApp:', erro);
});
