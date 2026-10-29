
import express from 'express';
import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState
} from '@whiskeysockets/baileys';
import QRCode from 'qrcode';
import fs from 'node:fs';
import pg from 'pg';

const { Pool } = pg;

const PORT = Number(process.env.PORT || 3000);
const GROUP_ONLY = process.env.GROUP_ONLY || '';
const AUTH_DIR = process.env.AUTH_DIR || './auth';

const ESTOQUE_INICIAL = 0;
const CAPACIDADE_MAXIMA = 14900;
const LIMITE_ALERTA = 3000;

if (!process.env.DATABASE_URL) {
  console.error('ERRO: configure DATABASE_URL no Render.');
  process.exit(1);
}

fs.mkdirSync(AUTH_DIR, { recursive: true });

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL.includes('localhost')
    ? false
    : { rejectUnauthorized: false },
  max: 5,
  connectionTimeoutMillis: 15000
});

let qrAtual = '';
let qrGeradoEm = 0;
let socketWhatsApp = null;
let reconectando = false;
let temporizadorReconexao = null;
let tentativaReconexao = 0;
let inicializacaoBanco = null;

function formatarLitros(valor) {
  return Number(valor).toLocaleString('pt-BR', {
    maximumFractionDigits: 2
  });
}

function dataBrasil(data = new Date()) {
  return data.toLocaleString('pt-BR', {
    timeZone: 'America/Sao_Paulo'
  });
}

async function inicializarBanco() {
  if (inicializacaoBanco) return inicializacaoBanco;

  inicializacaoBanco = (async () => {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS tanque_estado (
        id SMALLINT PRIMARY KEY CHECK (id = 1),
        estoque NUMERIC(12,2) NOT NULL,
        ultimo_relatorio TEXT NOT NULL DEFAULT ''
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS movimentacoes (
        id BIGSERIAL PRIMARY KEY,
        tipo TEXT NOT NULL,
        litros NUMERIC(12,2) NOT NULL,
        remetente TEXT NOT NULL,
        nome TEXT NOT NULL,
        mensagem TEXT NOT NULL DEFAULT '',
        timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        data TEXT NOT NULL,
        whatsapp_message_id TEXT,
        grupo_jid TEXT NOT NULL DEFAULT '',
        cancelada BOOLEAN NOT NULL DEFAULT FALSE,
        cancelada_por TEXT,
        cancelada_em TIMESTAMPTZ,
        motivo_cancelamento TEXT,
        movimentacao_origem_id BIGINT
          REFERENCES movimentacoes(id)
      )
    `);

    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_movimentacoes_data
      ON movimentacoes(timestamp DESC)
    `);

    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_movimentacoes_grupo_msg
      ON movimentacoes(grupo_jid, whatsapp_message_id)
    `);

    await pool.query(`
      INSERT INTO tanque_estado (id, estoque, ultimo_relatorio)
      VALUES (1, $1, '')
      ON CONFLICT (id) DO NOTHING
    `, [ESTOQUE_INICIAL]);

    console.log('Banco PostgreSQL pronto.');
  })();

  return inicializacaoBanco;
}

async function obterEstoque(client = pool) {
  const resultado = await client.query(
    'SELECT estoque FROM tanque_estado WHERE id = 1'
  );

  return Number(resultado.rows[0].estoque);
}

async function textoEstoque(client = pool) {
  const estoque = await obterEstoque(client);

  let texto =
    `Estoque atual: ${formatarLitros(estoque)} L\n` +
    `Capacidade máxima: ${formatarLitros(CAPACIDADE_MAXIMA)} L`;

  if (estoque < LIMITE_ALERTA) {
    texto += '\n⚠️ ALERTA: estoque abaixo de 3.000 L!';
  }

  return texto;
}

async function textoRelatorio() {
  const estoqueTexto = await textoEstoque();

  const resultado = await pool.query(`
    SELECT tipo, litros, nome, data, cancelada
    FROM movimentacoes
    ORDER BY id DESC
    LIMIT 30
  `);

  const linhas = resultado.rows.reverse().map(m => {
    if (m.tipo === 'CANCELAMENTO') {
      return `${m.data} | CANCELAMENTO | ${formatarLitros(m.litros)} L | ${m.nome}`;
    }

    const sinal = m.tipo === 'ABASTECIDO'
      ? '-'
      : m.tipo === 'ENTRADA'
        ? '+'
        : '';

    return `${m.data} | ${m.tipo} | ${sinal}${formatarLitros(m.litros)} L | ${m.nome}${m.cancelada ? ' | CANCELADA' : ''}`;
  });

  return `RELATÓRIO DO TANQUE\n${estoqueTexto}\n\nÚltimas movimentações:\n${linhas.join('\n') || 'Nenhuma movimentação registrada.'}`;
}

async function registrarMovimentacao({
  tipo,
  quantidade,
  remetente,
  nome,
  texto,
  grupo,
  mensagemId
}) {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const estado = await client.query(
      'SELECT estoque FROM tanque_estado WHERE id = 1 FOR UPDATE'
    );

    let estoque = Number(estado.rows[0].estoque);

    if (tipo === 'ABASTECIDO') {
      const limite = new Date(Date.now() - 20 * 60 * 1000);

      const recentes = await client.query(`
        SELECT COUNT(*)::int AS total
        FROM movimentacoes
        WHERE tipo = 'ABASTECIDO'
          AND remetente = $1
          AND timestamp >= $2
      `, [remetente, limite]);

      if (recentes.rows[0].total >= 2) {
        await client.query('ROLLBACK');
        return 'LIMITE ATINGIDO: você já registrou dois abastecimentos nos últimos 20 minutos. Nenhum litro foi descontado.';
      }

      if (quantidade > estoque) {
        await client.query('ROLLBACK');
        return `ERRO: estoque insuficiente. Disponível: ${formatarLitros(estoque)} L.`;
      }

      estoque -= quantidade;
    } else {
      if (estoque + quantidade > CAPACIDADE_MAXIMA) {
        const espaco = CAPACIDADE_MAXIMA - estoque;
        await client.query('ROLLBACK');

        return `ERRO: capacidade excedida. Espaço disponível: ${formatarLitros(espaco)} L.`;
      }

      estoque += quantidade;
    }

    await client.query(
      'UPDATE tanque_estado SET estoque = $1 WHERE id = 1',
      [estoque]
    );

    await client.query(`
      INSERT INTO movimentacoes
        (tipo, litros, remetente, nome, mensagem, data,
         whatsapp_message_id, grupo_jid)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    `, [
      tipo,
      quantidade,
      remetente,
      nome,
      texto,
      dataBrasil(),
      mensagemId || null,
      grupo
    ]);

    await client.query('COMMIT');

    return `${tipo === 'ABASTECIDO' ? 'Abastecimento registrado: -' : 'Entrada registrada: +'}${formatarLitros(quantidade)} L.\n${await textoEstoque()}`;
  } catch (erro) {
    await client.query('ROLLBACK').catch(() => {});
    throw erro;
  } finally {
    client.release();
  }
}

async function cancelarMovimentacao({
  quantidade,
  mensagemRespondidaId,
  grupo,
  remetente,
  nome,
  texto,
  mensagemId
}) {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const estado = await client.query(
      'SELECT estoque FROM tanque_estado WHERE id = 1 FOR UPDATE'
    );

    let estoque = Number(estado.rows[0].estoque);
    let resultado;

    if (mensagemRespondidaId) {
      resultado = await client.query(`
        SELECT *
        FROM movimentacoes
        WHERE grupo_jid = $1
          AND whatsapp_message_id = $2
          AND tipo IN ('ABASTECIDO', 'ENTRADA')
          AND cancelada = FALSE
        ORDER BY id DESC
        LIMIT 1
        FOR UPDATE
      `, [grupo, mensagemRespondidaId]);
    } else if (quantidade !== null) {
      resultado = await client.query(`
        SELECT *
        FROM movimentacoes
        WHERE grupo_jid = $1
          AND litros = $2
          AND tipo IN ('ABASTECIDO', 'ENTRADA')
          AND cancelada = FALSE
        ORDER BY id DESC
        LIMIT 1
        FOR UPDATE
      `, [grupo, quantidade]);
    } else {
      resultado = await client.query(`
        SELECT *
        FROM movimentacoes
        WHERE grupo_jid = $1
          AND tipo IN ('ABASTECIDO', 'ENTRADA')
          AND cancelada = FALSE
        ORDER BY id DESC
        LIMIT 1
        FOR UPDATE
      `, [grupo]);
    }

    if (!resultado.rowCount) {
      await client.query('ROLLBACK');

      if (mensagemRespondidaId) {
        return 'Não encontrei uma movimentação ativa associada à mensagem respondida.';
      }

      if (quantidade !== null) {
        return `Não encontrei uma movimentação ativa de ${formatarLitros(quantidade)} L neste grupo.`;
      }

      return 'Não encontrei movimentações que possam ser canceladas neste grupo.';
    }

    const movimentacao = resultado.rows[0];
    const litros = Number(movimentacao.litros);

    if (movimentacao.tipo === 'ABASTECIDO') {
      if (estoque + litros > CAPACIDADE_MAXIMA) {
        await client.query('ROLLBACK');
        return 'Não foi possível cancelar: a devolução ultrapassaria a capacidade máxima.';
      }

      estoque += litros;
    } else {
      if (estoque < litros) {
        await client.query('ROLLBACK');

        return `Não foi possível cancelar esta entrada: o estoque atual (${formatarLitros(estoque)} L) é menor que ${formatarLitros(litros)} L.`;
      }

      estoque -= litros;
    }

    await client.query(
      'UPDATE tanque_estado SET estoque = $1 WHERE id = 1',
      [estoque]
    );

    await client.query(`
      UPDATE movimentacoes
      SET cancelada = TRUE,
          cancelada_por = $1,
          cancelada_em = NOW(),
          motivo_cancelamento = $2
      WHERE id = $3
    `, [remetente, texto, movimentacao.id]);

    await client.query(`
      INSERT INTO movimentacoes
        (tipo, litros, remetente, nome, mensagem, data,
         whatsapp_message_id, grupo_jid, movimentacao_origem_id)
      VALUES ('CANCELAMENTO', $1, $2, $3, $4, $5, $6, $7, $8)
    `, [
      litros,
      remetente,
      nome,
      `Cancelou movimentação #${movimentacao.id}: ${movimentacao.tipo} ${litros} L`,
      dataBrasil(),
      mensagemId || null,
      grupo,
      movimentacao.id
    ]);

    await client.query('COMMIT');

    return `Movimentação cancelada com sucesso.\nOriginal: ${movimentacao.tipo} ${formatarLitros(litros)} L, registrada por ${movimentacao.nome} em ${movimentacao.data}.\n${await textoEstoque()}`;
  } catch (erro) {
    await client.query('ROLLBACK').catch(() => {});
    throw erro;
  } finally {
    client.release();
  }
}

async function processarMensagem(
  texto,
  remetente,
  nome,
  grupo,
  mensagemId,
  mensagemRespondidaId
) {
  const comando = texto.trim().toUpperCase();

  if (comando === 'ESTOQUE') {
    return textoEstoque();
  }

  if (comando === 'AJUDA') {
    return [
      'COMANDOS DO CODE TANK',
      '',
      'ESTOQUE',
      'ABASTECIDO: 250 LITROS',
      'ABASTECIDO 250',
      'ABASTECIDO 250L',
      'ABASTECIDO: 250',
      'ENTRADA: 5000',
      'RECEBIDO: 5000',
      'CANCELAR',
      'CANCELAR: 250',
      'Responda à mensagem original com CANCELAR para cancelar aquela movimentação.',
      'RELATORIO',
      '',
      'Informe litros sem separador de milhar: 5000, não 5.000.'
    ].join('\n');
  }

  if (comando === 'RELATORIO' || comando === 'RELATÓRIO') {
    return textoRelatorio();
  }

  const cancelar = texto.trim().match(
    /^CANCELAR(?:\s*:\s*(\d+(?:[.,]\d+)?))?\s*$/i
  );

  if (cancelar) {
    const quantidade = cancelar[1] === undefined
      ? null
      : Number(cancelar[1].replace(',', '.'));

    if (quantidade !== null &&
        (!Number.isFinite(quantidade) || quantidade <= 0)) {
      return 'ERRO: informe uma quantidade maior que zero. Exemplo: CANCELAR: 250';
    }

    return cancelarMovimentacao({
      quantidade,
      mensagemRespondidaId,
      grupo,
      remetente,
      nome,
      texto,
      mensagemId
    });
  }

  const resultado = texto.match(
    /^\s*(ABASTECIDO|ENTRADA|RECEBIDO)\s*:\s*(\d+(?:[.,]\d+)?)\s*$/i
  );

  if (!resultado) return null;

  const tipo = resultado[1].toUpperCase() === 'ABASTECIDO'
    ? 'ABASTECIDO'
    : 'ENTRADA';

  const quantidade = Number(resultado[2].replace(',', '.'));

  if (!Number.isFinite(quantidade) || quantidade <= 0) {
    return 'ERRO: informe uma quantidade maior que zero.';
  }

  return registrarMovimentacao({
    tipo,
    quantidade,
    remetente,
    nome,
    texto,
    grupo,
    mensagemId
  });
}

const app = express();

app.get('/', (_req, res) => {
  res.send('Code Tank está ativo.');
});

app.get('/health', async (_req, res) => {
  try {
    await inicializarBanco();

    res.json({
      ativo: true,
      conectado: Boolean(socketWhatsApp?.user),
      estoque: await obterEstoque()
    });
  } catch (erro) {
    res.status(500).json({
      ativo: false,
      erro: 'Falha ao acessar o banco de dados.'
    });
  }
});

app.get('/qr', async (_req, res) => {
  res.setHeader('Cache-Control', 'no-store');

  if (!qrAtual || Date.now() - qrGeradoEm > 60000) {
    return res.status(404).send(
      'QR Code indisponível ou expirado. Confira os logs e atualize a página.'
    );
  }

  try {
    const imagem = await QRCode.toDataURL(qrAtual, {
      width: 350,
      margin: 3,
      errorCorrectionLevel: 'M'
    });

    res.send(`<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Cache-Control" content="no-store">
<title>Conectar WhatsApp - Code Tank</title>
</head>
<body style="font-family:Arial;text-align:center;padding:20px;background:#f4f4f4;color:#222">
<main style="max-width:430px;margin:auto;background:white;padding:20px;border-radius:12px">
<h2>Code Tank</h2>
<p>WhatsApp → Aparelhos conectados → Conectar um aparelho.</p>
<img style="width:100%;max-width:350px" src="${imagem}" alt="QR Code">
<p>Não compartilhe esta página.</p>
</main>
</body>
</html>`);
  } catch (erro) {
    console.error('Erro ao gerar QR:', erro);
    res.status(500).send('Não foi possível gerar o QR Code.');
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Servidor ativo na porta ${PORT}`);
});

async function conectarWhatsApp() {
  if (reconectando) return;

  reconectando = true;

  try {
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

    const socket = makeWASocket({
      auth: state,
      browser: ['Code Tank', 'Chrome', '1.0.0'],
      markOnlineOnConnect: false,
      connectTimeoutMs: 60000,
      defaultQueryTimeoutMs: 60000,
      keepAliveIntervalMs: 25000
    });

    socketWhatsApp = socket;
    socket.ev.on('creds.update', saveCreds);

    socket.ev.on('connection.update', ({
      connection,
      lastDisconnect,
      qr
    }) => {
      if (qr) {
        qrAtual = qr;
        qrGeradoEm = Date.now();
        console.log('QR Code disponível temporariamente na rota /qr');
      }

      if (connection === 'open') {
        qrAtual = '';
        tentativaReconexao = 0;
        reconectando = false;
        console.log('WhatsApp conectado!');
      }

      if (connection === 'close') {
        socketWhatsApp = null;
        reconectando = false;

        const motivo = lastDisconnect?.error?.output?.statusCode;

        if (motivo === DisconnectReason.loggedOut) {
          qrAtual = '';
          console.error(
            'Sessão encerrada pelo WhatsApp. Será necessário parear novamente pelo QR Code.'
          );
          return;
        }

        if (temporizadorReconexao) {
          clearTimeout(temporizadorReconexao);
        }

        tentativaReconexao += 1;

        const espera = Math.min(
          3000 * (2 ** (tentativaReconexao - 1)),
          60000
        );

        console.log(
          `WhatsApp desconectado. Tentando reconectar em ${Math.round(espera / 1000)} segundos.`
        );

        temporizadorReconexao = setTimeout(() => {
          temporizadorReconexao = null;
          conectarWhatsApp().catch(erro =>
            console.error('Falha ao reconectar:', erro)
          );
        }, espera);
      }
    });

    socket.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify') return;

      for (const mensagem of messages) {
        if (!mensagem.message || mensagem.key.fromMe) continue;

        const grupo = mensagem.key.remoteJid;

        if (!grupo?.endsWith('@g.us')) continue;
        if (GROUP_ONLY && grupo !== GROUP_ONLY) continue;

        const conteudo = mensagem.message;

        const texto =
          conteudo.conversation ||
          conteudo.extendedTextMessage?.text ||
          conteudo.imageMessage?.caption ||
          conteudo.videoMessage?.caption ||
          '';

        if (!texto.trim()) continue;

        const contexto =
          conteudo.extendedTextMessage?.contextInfo ||
          conteudo.imageMessage?.contextInfo ||
          conteudo.videoMessage?.contextInfo ||
          {};

        const remetente = mensagem.key.participant || grupo;
        const nome = mensagem.pushName || remetente;

        try {
          await inicializarBanco();

          const resposta = await processarMensagem(
            texto,
            remetente,
            nome,
            grupo,
            mensagem.key.id,
            contexto.stanzaId || null
          );

          if (resposta) {
            await socket.sendMessage(grupo, { text: resposta });
          }
        } catch (erro) {
          console.error('Erro ao processar mensagem:', erro);

          await socket.sendMessage(grupo, {
            text: 'Não consegui processar o comando por um erro interno. Confira os logs do Render.'
          }).catch(() => {});
        }
      }
    });
  } catch (erro) {
    reconectando = false;
    console.error('Erro ao iniciar conexão com WhatsApp:', erro);

    if (temporizadorReconexao) {
      clearTimeout(temporizadorReconexao);
    }

    tentativaReconexao += 1;

    const espera = Math.min(
      3000 * (2 ** (tentativaReconexao - 1)),
      60000
    );

    temporizadorReconexao = setTimeout(() => {
      temporizadorReconexao = null;
      conectarWhatsApp().catch(console.error);
    }, espera);
  }
}

async function iniciar() {
  await inicializarBanco();

  conectarWhatsApp().catch(erro =>
    console.error('Erro ao iniciar WhatsApp:', erro)
  );

  setInterval(async () => {
    try {
      const partes = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'America/Sao_Paulo',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23'
      }).formatToParts(new Date());

      const horario = Object.fromEntries(
        partes.map(p => [p.type, p.value])
      );

      const hoje =
        `${horario.year}-${horario.month}-${horario.day}`;

      if (horario.hour !== '19' || horario.minute !== '00') return;

      const resultado = await pool.query(
        'SELECT ultimo_relatorio FROM tanque_estado WHERE id = 1'
      );

      if (resultado.rows[0].ultimo_relatorio === hoje) return;

      if (!GROUP_ONLY || !socketWhatsApp?.user) {
        console.log(
          'Relatório pendente: configure GROUP_ONLY e conecte o WhatsApp.'
        );
        return;
      }

      await socketWhatsApp.sendMessage(GROUP_ONLY, {
        text: await textoRelatorio()
      });

      await pool.query(
        'UPDATE tanque_estado SET ultimo_relatorio = $1 WHERE id = 1',
        [hoje]
      );

      console.log(`Relatório diário enviado em ${hoje}.`);
    } catch (erro) {
      console.error('Erro no relatório diário:', erro);
    }
  }, 15000);
}

iniciar().catch(erro => {
  console.error('Falha ao iniciar Code Tank:', erro);
  process.exit(1);
});
