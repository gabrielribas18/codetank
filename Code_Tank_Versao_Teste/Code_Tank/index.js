import express from "express";
import qrcode from "qrcode";
import pino from "pino";
import pg from "pg";
import {
  default as makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
} from "@whiskeysockets/baileys";
import fs from "node:fs";
import path from "node:path";

const { Pool } = pg;

const PORT = Number(process.env.PORT || 3000);
const DATABASE_URL = process.env.DATABASE_URL;
const TANQUE_CAPACIDADE = 14900;
const ALERTA_ESTOQUE = 3000;
const LIMITE_ABASTECIMENTOS = 2;
const JANELA_LIMITE_MINUTOS = 20;
const AUTH_DIR = process.env.AUTH_DIR || "./auth";

const GROUP_ONLY = (process.env.GROUP_ONLY || "")
  .split(",")
  .map((item) => item.trim())
  .filter(Boolean);

if (!DATABASE_URL) {
  throw new Error("A variável DATABASE_URL não foi configurada.");
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 5,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
});

const app = express();
app.use(express.json());

let sock;
let qrAtual = null;
let whatsappConectado = false;
let iniciandoWhatsApp = false;

const logger = pino({
  level: process.env.LOG_LEVEL || "info",
});

function normalizarTexto(texto) {
  return String(texto || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim();
}

function identificarMovimentacao(texto) {
  const normalizado = normalizarTexto(texto).toUpperCase();

  const abastecido = normalizado.match(
    /^ABASTECIDO\s*:?\s*(\d+(?:[,.]\d+)?)\s*(?:LITROS?|L)?$/
  );

  const entrada = normalizado.match(
    /^(?:ENTRADA|RECEBIDO)\s*:?\s*(\d+(?:[,.]\d+)?)\s*(?:LITROS?|L)?$/
  );

  if (abastecido) {
    const litros = Number(abastecido[1].replace(",", "."));

    return Number.isFinite(litros) && litros > 0
      ? { tipo: "abastecido", litros }
      : null;
  }

  if (entrada) {
    const litros = Number(entrada[1].replace(",", "."));

    return Number.isFinite(litros) && litros > 0
      ? { tipo: "entrada", litros }
      : null;
  }

  return null;
}

function extrairTexto(message) {
  if (!message) return "";

  const m =
    message.ephemeralMessage?.message ||
    message.viewOnceMessage?.message ||
    message.viewOnceMessageV2?.message ||
    message;

  return (
    m.conversation ||
    m.extendedTextMessage?.text ||
    m.imageMessage?.caption ||
    m.videoMessage?.caption ||
    m.documentMessage?.caption ||
    ""
  ).trim();
}

function chaveMensagem(msg) {
  return msg?.key?.id || null;
}

function jidRemetente(msg) {
  return (
    msg?.key?.participant ||
    msg?.key?.remoteJid ||
    "desconhecido"
  );
}

function nomeRemetente(msg) {
  return msg?.pushName || jidRemetente(msg);
}

function mensagemCitada(msg) {
  const context =
    msg?.message?.extendedTextMessage?.contextInfo ||
    msg?.message?.imageMessage?.contextInfo ||
    msg?.message?.videoMessage?.contextInfo;

  if (!context?.stanzaId) return null;

  return context.stanzaId;
}

// ==========================================
// INICIALIZAÇÃO DO BANCO
// ==========================================

async function inicializarBanco() {
  const tabelas = await pool.query(`
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name IN ('movimentacoes', 'tanque_estado')
  `);

  const existentes = new Set(
    tabelas.rows.map((r) => r.table_name)
  );

  if (
    !existentes.has("movimentacoes") ||
    !existentes.has("tanque_estado")
  ) {
    throw new Error(
      "As tabelas public.movimentacoes e public.tanque_estado precisam existir no Neon."
    );
  }

  await pool.query(`
    CREATE TABLE IF NOT EXISTS relatorios_enviados (
      data TEXT PRIMARY KEY,
      enviado_em TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`
    INSERT INTO tanque_estado (id, estoque)
    VALUES (1, 0)
    ON CONFLICT (id) DO NOTHING
  `);

  logger.info(
    "Banco PostgreSQL conectado. Estrutura existente preservada."
  );
}

// ==========================================
// ESTOQUE
// ==========================================

async function obterEstoque(client = pool) {
  const result = await client.query(
    "SELECT estoque FROM tanque_estado WHERE id = 1"
  );

  return Number(result.rows[0]?.estoque ?? 0);
}

function formatarLitros(valor) {
  return Number(valor).toLocaleString("pt-BR", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  });
}

async function textoEstoque() {
  const estoque = await obterEstoque();

  let resposta =
    `⛽ *ESTOQUE ATUAL*\n${formatarLitros(estoque)} litros`;

  if (estoque < ALERTA_ESTOQUE) {
    resposta +=
      "\n⚠️ *ATENÇÃO: estoque abaixo de 3.000 litros!*";
  }

  resposta +=
    `\nCapacidade: ${formatarLitros(TANQUE_CAPACIDADE)} litros`;

  return resposta;
}

// ==========================================
// PREVISÃO DO TEMPO — GUARAPUAVA/PR
// Usa Open-Meteo, sem chave de API ou dependência adicional.
// ==========================================

const TEMPO_LOCAL = {
  nome: "Guarapuava - PR",
  latitude: -25.3905,
  longitude: -51.4562,
};

function descricaoTempo(codigo) {
  const descricoes = {
    0: "Céu limpo",
    1: "Predominantemente limpo",
    2: "Parcialmente nublado",
    3: "Nublado",
    45: "Neblina",
    48: "Neblina com geada",
    51: "Garoa fraca",
    53: "Garoa moderada",
    55: "Garoa intensa",
    56: "Garoa congelante fraca",
    57: "Garoa congelante intensa",
    61: "Chuva fraca",
    63: "Chuva moderada",
    65: "Chuva forte",
    66: "Chuva congelante fraca",
    67: "Chuva congelante forte",
    71: "Neve fraca",
    73: "Neve moderada",
    75: "Neve forte",
    77: "Grãos de neve",
    80: "Pancadas de chuva fracas",
    81: "Pancadas de chuva moderadas",
    82: "Pancadas de chuva fortes",
    85: "Pancadas de neve fracas",
    86: "Pancadas de neve fortes",
    95: "Trovoadas",
    96: "Trovoadas com granizo fraco",
    99: "Trovoadas com granizo forte",
  };

  return descricoes[codigo] || "Condição não identificada";
}

async function obterPrevisaoTempo() {
  const url = new URL("https://api.open-meteo.com/v1/forecast");

  url.search = new URLSearchParams({
    latitude: String(TEMPO_LOCAL.latitude),
    longitude: String(TEMPO_LOCAL.longitude),
    current: [
      "temperature_2m",
      "apparent_temperature",
      "relative_humidity_2m",
      "precipitation",
      "weather_code",
      "wind_speed_10m",
    ].join(","),
    hourly: "temperature_2m,precipitation_probability",
    forecast_days: "1",
    timezone: "America/Sao_Paulo",
  }).toString();

  const resposta = await fetch(url, {
    signal: AbortSignal.timeout(12000),
    headers: { "User-Agent": "CodeTank/1.0" },
  });

  if (!resposta.ok) {
    throw new Error(`Open-Meteo respondeu com HTTP ${resposta.status}`);
  }

  const dados = await resposta.json();

  if (!dados.current || !dados.hourly) {
    throw new Error("A API não retornou os dados meteorológicos esperados.");
  }

  const atual = dados.current;
  const horarios = dados.hourly.time || [];

  const indiceAtual = Math.max(
    0,
    horarios.findIndex((horario) => horario >= atual.time)
  );

  const proximasHoras = [];

  for (
    let i = indiceAtual;
    i < Math.min(indiceAtual + 4, horarios.length);
    i++
  ) {
    proximasHoras.push({
      hora: horarios[i].slice(11, 16),
      temperatura: dados.hourly.temperature_2m?.[i],
      chuva: dados.hourly.precipitation_probability?.[i],
    });
  }

  const numero = (valor, casas = 0) =>
    Number.isFinite(Number(valor))
      ? Number(valor).toLocaleString("pt-BR", {
          minimumFractionDigits: casas,
          maximumFractionDigits: casas,
        })
      : "indisponível";

  let texto =
    `🌦️ *PREVISÃO DO TEMPO — ${TEMPO_LOCAL.nome}*\n` +
    `Atualizado: ${String(atual.time || "").replace("T", " ")}\n\n` +
    `🌡️ Temperatura: *${numero(atual.temperature_2m)}°C*\n` +
    `🤔 Sensação térmica: ${numero(atual.apparent_temperature)}°C\n` +
    `☁️ Condição: ${descricaoTempo(atual.weather_code)}\n` +
    `💧 Umidade: ${numero(atual.relative_humidity_2m)}%\n` +
    `🌧️ Precipitação atual: ${numero(atual.precipitation, 1)} mm\n` +
    `💨 Vento: ${numero(atual.wind_speed_10m)} km/h`;

  if (proximasHoras.length) {
    texto += "\n\n*PRÓXIMAS HORAS*";

    for (const item of proximasHoras) {
      texto +=
        `\n${item.hora} — ${numero(item.temperatura)}°C` +
        ` | Chuva: ${numero(item.chuva)}%`;
    }
  }

  texto += "\n\n_Fonte: Open-Meteo. Previsão sujeita a atualização._";

  return texto;
}

// ==========================================
// REGISTRAR ENTRADA E ABASTECIMENTO
// ==========================================

async function registrarMovimentacao({
  tipo,
  litros,
  remetente,
  nome,
  grupo,
  messageId,
  mensagem,
}) {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const estado = await client.query(
      "SELECT estoque FROM tanque_estado WHERE id = 1 FOR UPDATE"
    );

    const estoqueAtual = Number(
      estado.rows[0]?.estoque ?? 0
    );

    const tipoBanco =
      tipo === "abastecido" ? "ABASTECIDO" : "ENTRADA";

    if (tipoBanco === "ABASTECIDO") {
      const desde = await client.query(
        `SELECT COUNT(*)::int AS total
         FROM movimentacoes
         WHERE tipo = 'ABASTECIDO'
           AND remetente = $1
           AND cancelada = FALSE
           AND "timestamp" >= NOW() - ($2 || ' minutes')::interval`,
        [remetente, String(JANELA_LIMITE_MINUTOS)]
      );

      if (desde.rows[0].total >= LIMITE_ABASTECIMENTOS) {
        await client.query("ROLLBACK");

        return {
          ok: false,
          mensagem:
            `Limite atingido: você pode registrar no máximo ${LIMITE_ABASTECIMENTOS} abastecimentos a cada ${JANELA_LIMITE_MINUTOS} minutos.`,
        };
      }

      if (litros > estoqueAtual) {
        await client.query("ROLLBACK");

        return {
          ok: false,
          mensagem:
            `Estoque insuficiente. Disponível: ${formatarLitros(estoqueAtual)} litros.`,
        };
      }
    }

    const novoEstoque =
      tipoBanco === "ENTRADA"
        ? estoqueAtual + litros
        : estoqueAtual - litros;

    if (novoEstoque > TANQUE_CAPACIDADE) {
      await client.query("ROLLBACK");

      return {
        ok: false,
        mensagem:
          `Operação recusada. O tanque comporta no máximo ${formatarLitros(TANQUE_CAPACIDADE)} litros. Estoque atual: ${formatarLitros(estoqueAtual)} litros.`,
      };
    }

    if (novoEstoque < 0) {
      await client.query("ROLLBACK");

      return {
        ok: false,
        mensagem:
          "Operação recusada: o estoque não pode ficar negativo.",
      };
    }

    await client.query(
      `INSERT INTO movimentacoes
       (
         tipo,
         litros,
         remetente,
         nome,
         mensagem,
         "timestamp",
         data,
         whatsapp_message_id,
         grupo_jid,
         cancelada,
         criada_em
       )
       VALUES (
         $1,
         $2,
         $3,
         $4,
         $5,
         NOW(),
         TO_CHAR(
           NOW() AT TIME ZONE 'America/Sao_Paulo',
           'DD/MM/YYYY'
         ),
         $6,
         $7,
         FALSE,
         NOW()
       )`,
      [
        tipoBanco,
        litros,
        remetente,
        nome,
        mensagem || `${tipoBanco}: ${litros}`,
        messageId,
        grupo,
      ]
    );

    await client.query(
      "UPDATE tanque_estado SET estoque = $1 WHERE id = 1",
      [novoEstoque]
    );

    await client.query("COMMIT");

    return {
      ok: true,
      mensagem:
        `✅ *${tipoBanco === "ENTRADA" ? "ENTRADA REGISTRADA" : "ABASTECIMENTO REGISTRADO"}*\n` +
        `Quantidade: ${formatarLitros(litros)} litros\n` +
        `Estoque atual: ${formatarLitros(novoEstoque)} litros` +
        (novoEstoque < ALERTA_ESTOQUE
          ? "\n⚠️ *ATENÇÃO: estoque abaixo de 3.000 litros!*"
          : ""),
    };
  } catch (error) {
    await client.query("ROLLBACK");

    if (error.code === "23505") {
      return {
        ok: false,
        mensagem:
          "Esta mensagem já foi registrada anteriormente.",
      };
    }

    throw error;
  } finally {
    client.release();
  }
}

// ==========================================
// CANCELAR MOVIMENTAÇÃO
// ==========================================

async function cancelarMovimentacao({
  quantidade,
  mensagemId,
  remetente,
}) {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    await client.query(
      "SELECT estoque FROM tanque_estado WHERE id = 1 FOR UPDATE"
    );

    let query;
    let params;

    if (mensagemId) {
      query = `
        SELECT *
        FROM movimentacoes
        WHERE whatsapp_message_id = $1
          AND cancelada = FALSE
          AND tipo IN ('ABASTECIDO', 'ENTRADA')
        FOR UPDATE
      `;

      params = [mensagemId];
    } else if (quantidade != null) {
      query = `
        SELECT *
        FROM movimentacoes
        WHERE litros = $1
          AND cancelada = FALSE
          AND tipo IN ('ABASTECIDO', 'ENTRADA')
        ORDER BY "timestamp" DESC, id DESC
        LIMIT 1
        FOR UPDATE
      `;

      params = [quantidade];
    } else {
      query = `
        SELECT *
        FROM movimentacoes
        WHERE cancelada = FALSE
          AND tipo IN ('ABASTECIDO', 'ENTRADA')
        ORDER BY "timestamp" DESC, id DESC
        LIMIT 1
        FOR UPDATE
      `;

      params = [];
    }

    const encontrado = await client.query(query, params);
    const mov = encontrado.rows[0];

    if (!mov) {
      await client.query("ROLLBACK");

      return {
        ok: false,
        mensagem:
          "Não encontrei uma movimentação ativa correspondente para cancelar.",
      };
    }

    const estoqueAtual = await obterEstoque(client);
    const litros = Number(mov.litros);

    const novoEstoque =
      mov.tipo === "ENTRADA"
        ? estoqueAtual - litros
        : estoqueAtual + litros;

    if (novoEstoque < 0 || novoEstoque > TANQUE_CAPACIDADE) {
      await client.query("ROLLBACK");

      return {
        ok: false,
        mensagem:
          "Cancelamento recusado para não deixar o estoque negativo ou acima da capacidade do tanque.",
      };
    }

    await client.query(
      `UPDATE movimentacoes
       SET cancelada = TRUE
       WHERE id = $1`,
      [mov.id]
    );

    await client.query(
      `INSERT INTO movimentacoes
       (
         tipo,
         litros,
         remetente,
         nome,
         mensagem,
         "timestamp",
         data,
         whatsapp_message_id,
         grupo_jid,
         cancelada,
         criada_em
       )
       VALUES (
         'CANCELAMENTO',
         $1,
         $2,
         $3,
         $4,
         NOW(),
         TO_CHAR(
           NOW() AT TIME ZONE 'America/Sao_Paulo',
           'DD/MM/YYYY'
         ),
         NULL,
         $5,
         FALSE,
         NOW()
       )`,
      [
        litros,
        remetente,
        "Cancelamento",
        `Cancelamento da movimentação ID ${mov.id}`,
        mov.grupo_jid,
      ]
    );

    await client.query(
      "UPDATE tanque_estado SET estoque = $1 WHERE id = 1",
      [novoEstoque]
    );

    await client.query("COMMIT");

    return {
      ok: true,
      mensagem:
        `✅ *MOVIMENTAÇÃO CANCELADA*\n` +
        `Tipo: ${mov.tipo}\n` +
        `Quantidade: ${formatarLitros(litros)} litros\n` +
        `Estoque atual: ${formatarLitros(novoEstoque)} litros`,
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

// ==========================================
// ENVIO DE MENSAGENS
// ==========================================

async function enviarTexto(grupo, texto) {
  if (!sock || !whatsappConectado) {
    logger.warn("Mensagem não enviada: WhatsApp desconectado.");
    return;
  }

  await sock.sendMessage(grupo, {
    text: texto,
  });
}

// ==========================================
// PROCESSAMENTO DAS MENSAGENS
// ==========================================

async function processarMensagem(msg) {
  const grupo = msg.key?.remoteJid;

  if (!grupo || !grupo.endsWith("@g.us")) return;
  if (msg.key?.fromMe) return;

  if (GROUP_ONLY.length && !GROUP_ONLY.includes(grupo)) {
    return;
  }

  const texto = extrairTexto(msg.message);

  if (!texto) return;

  const comando = normalizarTexto(texto).toUpperCase();
  const remetente = jidRemetente(msg);
  const nome = nomeRemetente(msg);
  const messageId = chaveMensagem(msg);

  try {
    if (comando === "ESTOQUE") {
      await enviarTexto(grupo, await textoEstoque());
      return;
    }

    if (comando === "TEMPO") {
      try {
        await enviarTexto(grupo, await obterPrevisaoTempo());
      } catch (error) {
        logger.error({ err: error }, "Erro ao consultar previsão do tempo");

        await enviarTexto(
          grupo,
          "Não consegui consultar a previsão do tempo agora. Tente novamente em alguns minutos."
        );
      }

      return;
    }

    if (comando === "AJUDA") {
      await enviarTexto(
        grupo,
        "*COMANDOS DO CODETANK*\n\n" +
          "ESTOQUE — consulta o estoque\n" +
          "TEMPO — consulta a previsão do tempo de Guarapuava/PR\n" +
          "ABASTECIDO: 250 litros — registra abastecimento/saída\n" +
          "ENTRADA: 5000 — registra recebimento\n" +
          "RECEBIDO: 5000 — registra recebimento\n" +
          "CANCELAR — cancela a movimentação ativa mais recente\n" +
          "CANCELAR: 250 — cancela a movimentação ativa mais recente de 250 litros\n" +
          "Responda à mensagem original com CANCELAR para cancelar aquela movimentação\n" +
          "RELATORIO — mostra o relatório"
      );

      return;
    }

    if (
      comando === "RELATORIO" ||
      comando === "RELATÓRIO"
    ) {
      await enviarTexto(grupo, await gerarRelatorio());
      return;
    }

    const cancelamento = comando.match(
      /^CANCELAR\s*:?\s*(\d+(?:[,.]\d+)?)?\s*(?:LITROS?|L)?$/
    );

    if (cancelamento) {
      const citada = mensagemCitada(msg);

      const quantidade = cancelamento[1]
        ? Number(cancelamento[1].replace(",", "."))
        : null;

      const resultado = await cancelarMovimentacao({
        quantidade,
        mensagemId: citada,
        remetente,
      });

      await enviarTexto(grupo, resultado.mensagem);
      return;
    }

    const movimentacao = identificarMovimentacao(texto);

    if (!movimentacao) return;

    const resultado = await registrarMovimentacao({
      ...movimentacao,
      remetente,
      nome,
      grupo,
      messageId,
      mensagem: texto,
    });

    await enviarTexto(grupo, resultado.mensagem);
  } catch (error) {
    logger.error(
      { err: error },
      "Erro ao processar mensagem"
    );

    await enviarTexto(
      grupo,
      "❌ Ocorreu um erro ao processar. Verifique os logs do sistema."
    );
  }
}

// ==========================================
// RELATÓRIO
// ==========================================

async function gerarRelatorio() {
  const client = await pool.connect();

  try {
    const estoque = await obterEstoque(client);

    const hoje = await client.query(`
      SELECT
        COALESCE(
          SUM(
            CASE
              WHEN tipo = 'ENTRADA' THEN litros
              ELSE 0
            END
          ), 0
        ) AS entradas,

        COALESCE(
          SUM(
            CASE
              WHEN tipo = 'ABASTECIDO' THEN litros
              ELSE 0
            END
          ), 0
        ) AS abastecimentos,

        COUNT(*)::int AS quantidade

      FROM movimentacoes

      WHERE cancelada = FALSE
        AND tipo IN ('ENTRADA', 'ABASTECIDO')
        AND (
          "timestamp" AT TIME ZONE 'America/Sao_Paulo'
        )::date = (
          NOW() AT TIME ZONE 'America/Sao_Paulo'
        )::date
    `);

    const row = hoje.rows[0];

    return (
      `📊 *RELATÓRIO DIÁRIO — CODETANK*\n` +
      `Estoque atual: ${formatarLitros(estoque)} litros\n` +
      `Entradas hoje: ${formatarLitros(row.entradas)} litros\n` +
      `Abastecimentos hoje: ${formatarLitros(row.abastecimentos)} litros\n` +
      `Movimentações ativas hoje: ${row.quantidade}` +
      (estoque < ALERTA_ESTOQUE
        ? "\n⚠️ *ATENÇÃO: estoque abaixo de 3.000 litros!*"
        : "")
    );
  } finally {
    client.release();
  }
}

// ==========================================
// RELATÓRIO AUTOMÁTICO ÀS 19H
// ==========================================

async function enviarRelatorioDiario() {
  if (!whatsappConectado || GROUP_ONLY.length === 0) {
    return;
  }

  const agora = new Date();

  const partes = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Sao_Paulo",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(agora);

  const hora = partes.find(
    (p) => p.type === "hour"
  )?.value;

  const minuto = partes.find(
    (p) => p.type === "minute"
  )?.value;

  if (hora !== "19" || minuto !== "00") return;

  const hoje = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Sao_Paulo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(agora);

  const marcado = await pool.query(
    `INSERT INTO relatorios_enviados (data)
     VALUES ($1)
     ON CONFLICT (data) DO NOTHING
     RETURNING data`,
    [hoje]
  );

  if (!marcado.rowCount) return;

  const relatorio = await gerarRelatorio();

  for (const grupo of GROUP_ONLY) {
    await enviarTexto(grupo, relatorio);
  }
}

// ==========================================
// CONEXÃO WHATSAPP
// ==========================================

async function iniciarWhatsApp() {
  if (iniciandoWhatsApp) return;

  iniciandoWhatsApp = true;

  try {
    fs.mkdirSync(path.dirname(AUTH_DIR), {
      recursive: true,
    });

    const { state, saveCreds } =
      await useMultiFileAuthState(AUTH_DIR);

    sock = makeWASocket({
      auth: state,
      logger,
      printQRInTerminal: false,
      browser: ["CodeTank", "Chrome", "1.0.0"],
      markOnlineOnConnect: false,
      syncFullHistory: false,
    });

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", async (update) => {
      const {
        connection,
        lastDisconnect,
        qr,
      } = update;

      if (qr) {
        qrAtual = await qrcode.toDataURL(qr);

        logger.info(
          "QR Code gerado. Acesse /qr para visualizar."
        );
      }

      if (connection === "open") {
        whatsappConectado = true;
        qrAtual = null;

        logger.info("WhatsApp conectado!");
      }

      if (connection === "close") {
        whatsappConectado = false;

        const statusCode =
          lastDisconnect?.error?.output?.statusCode;

        const deveReconectar =
          statusCode !== DisconnectReason.loggedOut;

        logger.warn(
          { statusCode, deveReconectar },
          "Conexão WhatsApp encerrada"
        );

        if (deveReconectar) {
          iniciandoWhatsApp = false;

          setTimeout(() => iniciarWhatsApp(), 3000);
        } else {
          logger.error(
            "WhatsApp desconectado. Remova a sessão antiga e gere novo QR."
          );
        }
      }
    });

    sock.ev.on(
      "messages.upsert",
      async ({ messages, type }) => {
        if (type !== "notify") return;

        for (const msg of messages) {
          await processarMensagem(msg);
        }
      }
    );
  } catch (error) {
    logger.error(
      { err: error },
      "Falha ao iniciar WhatsApp"
    );

    iniciandoWhatsApp = false;

    setTimeout(() => iniciarWhatsApp(), 5000);
  }
}

// ==========================================
// ROTAS DO SERVIDOR
// ==========================================

app.get("/health", async (_req, res) => {
  try {
    await pool.query("SELECT 1");

    res.json({
      status: "ok",
      database: "connected",
      whatsapp: whatsappConectado
        ? "connected"
        : "disconnected",
    });
  } catch {
    res.status(503).json({
      status: "error",
      database: "disconnected",
    });
  }
});

app.get("/qr", async (_req, res) => {
  if (whatsappConectado) {
    return res.send(
      "<h2>WhatsApp já está conectado ao CodeTank.</h2>"
    );
  }

  if (!qrAtual) {
    return res.status(503).send(
      "<h2>QR ainda não foi gerado.</h2>" +
      "<p>Aguarde alguns segundos e atualize a página. Consulte os logs do Render.</p>"
    );
  }

  res.send(`
    <!doctype html>
    <html lang="pt-br">
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <title>CodeTank - QR Code</title>
      </head>

      <body style="font-family:Arial;text-align:center;padding:24px">
        <h2>Conectar WhatsApp ao CodeTank</h2>

        <p>
          Abra Dispositivos conectados no WhatsApp
          e escaneie o QR Code.
        </p>

        <img
          src="${qrAtual}"
          alt="QR Code WhatsApp"
          style="max-width:320px;width:100%"
        >
      </body>
    </html>
  `);
});

app.get("/", (_req, res) => {
  res.send(
    "CodeTank está ativo. Consulte /health ou /qr."
  );
});

// ==========================================
// INICIALIZAÇÃO DO SISTEMA
// ==========================================

async function iniciarServidor() {
  try {
    await inicializarBanco();

    app.listen(PORT, "0.0.0.0", () => {
      logger.info(`Servidor ativo na porta ${PORT}`);
    });

    await iniciarWhatsApp();

    setInterval(() => {
      enviarRelatorioDiario().catch((error) =>
        logger.error(
          { err: error },
          "Erro no relatório diário"
        )
      );
    }, 60 * 1000);
  } catch (error) {
    logger.error(
      { err: error },
      "Falha na inicialização"
    );

    process.exit(1);
  }
}

process.on("SIGTERM", async () => {
  logger.info("Encerrando CodeTank...");

  try {
    await pool.end();
  } finally {
    process.exit(0);
  }
});

iniciarServidor();
