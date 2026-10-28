CODE TANK — PROTÓTIPO LOCAL

REQUISITOS
- Python 3.10 ou superior
- Não precisa instalar bibliotecas externas

ARQUIVOS
- main.py: programa
- tanque_diesel.db: será criado automaticamente na primeira execução

COMO TESTAR NO WINDOWS / VS CODE
1. Extraia o ZIP para uma pasta.
2. Abra essa pasta no VS Code (Arquivo > Abrir Pasta).
3. Abra Terminal > Novo Terminal.
4. Confira o Python: python --version
5. Execute: python main.py

COMANDOS DE TESTE
ESTOQUE
ABASTECIDO: 250, trator John Deere, operador João, horímetro 1520,5
RECEBIDO: 5000
ENTRADA: 100
RELATORIO
FIM

IMPORTANTE
- O estoque inicial de 10.000 L é cadastrado automaticamente apenas na primeira execução.
- Capacidade máxima: 14.500 L.
- Alerta de estoque baixo: 8.000 L ou menos.
- A entrada é recusada se ultrapassar a capacidade.
- O abastecimento é recusado se superar o saldo.
- O banco registra as movimentações.
- A proteção contra duplicidade usa uma chave única de mensagem. Na versão de terminal é gerada uma chave para cada teste; na futura integração WhatsApp, a chave deve ser o ID real da mensagem recebido da API.
- Esta versão NÃO está conectada ao WhatsApp e NÃO envia relatório automático às 19h. Isso exige integração e execução em um computador/servidor ligado.
- Para reiniciar completamente o teste, feche o programa e apague tanque_diesel.db. Isso apaga todo o histórico.
