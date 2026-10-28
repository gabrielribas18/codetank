"""
Code Tank - controle de estoque de diesel
Python 3.10+
Primeira etapa: lógica local com SQLite.
Esta versão ainda NÃO lê mensagens do WhatsApp; a integração será uma etapa separada.
"""

import re
import sqlite3
from datetime import datetime
from pathlib import Path

DB_PATH = Path(__file__).with_name("tanque_diesel.db")
CAPACIDADE_MAXIMA = 14900.0
LIMITE_ALERTA = 3000.0
ESTOQUE_INICIAL = 0.0


def conectar():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def preparar_banco():
    with conectar() as conn:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS configuracao (
                chave TEXT PRIMARY KEY,
                valor REAL NOT NULL
            )
        """)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS movimentacoes (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                chave_mensagem TEXT UNIQUE,
                tipo TEXT NOT NULL CHECK (tipo IN ('INICIAL', 'ENTRADA', 'ABASTECIDO')),
                litros REAL NOT NULL CHECK (litros > 0),
                origem TEXT NOT NULL,
                mensagem TEXT NOT NULL,
                data_hora TEXT NOT NULL
            )
        """)
        existe = conn.execute(
            "SELECT valor FROM configuracao WHERE chave = 'estoque_inicial'"
        ).fetchone()
        if existe is None:
            conn.execute(
                "INSERT INTO configuracao (chave, valor) VALUES ('estoque_inicial', ?)",
                (ESTOQUE_INICIAL,)
            )
            conn.execute("""
                INSERT INTO movimentacoes
                (chave_mensagem, tipo, litros, origem, mensagem, data_hora)
                VALUES ('MOVIMENTO_INICIAL_UNICO', 'INICIAL', ?, 'Sistema',
                        'Estoque inicial configurado', ?)
            """, (ESTOQUE_INICIAL, datetime.now().isoformat(timespec="seconds")))


def obter_estoque(conn=None):
    propria_conexao = conn is None
    if propria_conexao:
        conn = conectar()
    try:
        saldo = conn.execute("""
            SELECT COALESCE(SUM(
                CASE
                    WHEN tipo IN ('INICIAL', 'ENTRADA') THEN litros
                    WHEN tipo = 'ABASTECIDO' THEN -litros
                    ELSE 0
                END
            ), 0) AS saldo
            FROM movimentacoes
        """).fetchone()["saldo"]
        return float(saldo)
    finally:
        if propria_conexao:
            conn.close()


def extrair_movimentacao(mensagem):
    """
    Reconhece somente o valor logo após:
      ABASTECIDO: 250
      ENTRADA: 5000
      RECEBIDO: 5000
    Ignora o restante da mensagem.
    Aceita ponto ou vírgula decimal e separador de milhar simples.
    """
    padrao = re.compile(
        r"(?im)^\s*(ABASTECIDO|ENTRADA|RECEBIDO)\s*:\s*"
        r"([0-9]+(?:[.,][0-9]+)?)"
    )
    achado = padrao.search(mensagem)
    if not achado:
        return None

    palavra = achado.group(1).upper()
    valor_texto = achado.group(2).replace(",", ".")
    litros = float(valor_texto)

    if palavra == "ABASTECIDO":
        tipo = "ABASTECIDO"
    else:
        tipo = "ENTRADA"

    if litros <= 0:
        raise ValueError("A quantidade precisa ser maior que zero.")
    return tipo, litros, achado.group(0).strip()


def registrar_movimentacao(mensagem, origem="Terminal", chave_mensagem=None):
    extraida = extrair_movimentacao(mensagem)
    if extraida is None:
        return "Mensagem ignorada: não encontrei ABASTECIDO:, ENTRADA: ou RECEBIDO: no começo de uma linha."

    tipo, litros, comando = extraida
    chave = chave_mensagem or f"terminal-{datetime.now().isoformat(timespec='microseconds')}"

    with conectar() as conn:
        duplicada = conn.execute(
            "SELECT id FROM movimentacoes WHERE chave_mensagem = ?", (chave,)
        ).fetchone()
        if duplicada:
            return "Mensagem duplicada: não foi registrada novamente."

        saldo_atual = obter_estoque(conn)

        if tipo == "ABASTECIDO":
            if litros > saldo_atual:
                return (
                    f"ERRO: retirada de {litros:g} L maior que o saldo "
                    f"disponível de {saldo_atual:g} L. Nada foi registrado."
                )
            novo_saldo = saldo_atual - litros
        else:
            novo_saldo = saldo_atual + litros
            if novo_saldo > CAPACIDADE_MAXIMA:
                disponivel = CAPACIDADE_MAXIMA - saldo_atual
                return (
                    f"ERRO: a entrada de {litros:g} L ultrapassaria a capacidade. "
                    f"Cabem apenas {max(disponivel, 0):g} L. Nada foi registrado."
                )

        conn.execute("""
            INSERT INTO movimentacoes
            (chave_mensagem, tipo, litros, origem, mensagem, data_hora)
            VALUES (?, ?, ?, ?, ?, ?)
        """, (
            chave, tipo, litros, origem, mensagem,
            datetime.now().isoformat(timespec="seconds")
        ))
        saldo_atualizado = obter_estoque(conn)

    if tipo == "ABASTECIDO":
        resposta = f"Abastecimento registrado: -{litros:g} L."
    else:
        resposta = f"Entrada registrada: +{litros:g} L."

    resposta += f"\nEstoque atualizado: {saldo_atualizado:g} L."
    if saldo_atualizado <= LIMITE_ALERTA:
        resposta += "\nALERTA: estoque em 3.000 L ou menos."
    return resposta


def mostrar_estoque():
    saldo = obter_estoque()
    print(f"\nEstoque atual: {saldo:g} L")
    print(f"Capacidade máxima: {CAPACIDADE_MAXIMA:g} L")
    if saldo <= LIMITE_ALERTA:
        print("ALERTA: estoque em 3.000 L ou menos.")


def mostrar_relatorio():
    with conectar() as conn:
        linhas = conn.execute("""
            SELECT data_hora, tipo, litros, origem, mensagem
            FROM movimentacoes
            ORDER BY id DESC
            LIMIT 30
        """).fetchall()
    print("\n=== RELATÓRIO DO TANQUE ===")
    print(f"Gerado em: {datetime.now().strftime('%d/%m/%Y %H:%M:%S')}")
    print(f"Estoque atual: {obter_estoque():g} L")
    print("\nÚltimas movimentações:")
    for linha in linhas:
        sinal = "-" if linha["tipo"] == "ABASTECIDO" else "+"
        print(
            f"- {linha['data_hora']} | {linha['tipo']} | "
            f"{sinal}{linha['litros']:g} L | {linha['origem']}"
        )


def main():
    preparar_banco()
    print("=== CODE TANK | CONTROLE DE DIESEL ===")
    print("Comandos: ESTOQUE, RELATORIO, AJUDA, FIM")
    print("Movimentações: ABASTECIDO: 250 | ENTRADA: 5000 | RECEBIDO: 5000")
    print("Observação: esta é a versão de teste local, ainda sem WhatsApp.\n")

    while True:
        try:
            mensagem = input("Digite um comando ou mensagem: ").strip()
        except (EOFError, KeyboardInterrupt):
            print("\nEncerrando.")
            break

        if not mensagem:
            continue

        comando = mensagem.upper().strip()
        if comando in ("FIM", "SAIR", "EXIT"):
            print("Programa encerrado.")
            break
        elif comando == "ESTOQUE":
            mostrar_estoque()
        elif comando in ("RELATORIO", "RELATÓRIO"):
            mostrar_relatorio()
        elif comando == "AJUDA":
            print(
                "\nComandos disponíveis:\n"
                "  ESTOQUE\n"
                "  ABASTECIDO: 250\n"
                "  ENTRADA: 5000\n"
                "  RECEBIDO: 5000\n"
                "  RELATORIO\n"
                "  FIM\n"
                "O valor usado é somente o que vem logo após os dois-pontos."
            )
        else:
            print(registrar_movimentacao(mensagem))


if __name__ == "__main__":
    main()
