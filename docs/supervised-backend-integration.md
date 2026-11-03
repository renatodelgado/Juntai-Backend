# Integração experimental Node.js → FastAPI — Nível 2

O backend suporta `MATCHMAKING_STRATEGY=rules|supervised`. O padrão permanece
**rules**, inclusive quando a variável está ausente/vazia. O `.env` local não foi
alterado. Valor desconhecido produz erro explícito de configuração (500).
Frontend, IA, modelo e dataset permanecem inalterados. A migration autorizada de exposições está documentada abaixo.

## Configuração e fluxo

```dotenv
MATCHMAKING_STRATEGY=rules
MATCHMAKING_API_URL=http://127.0.0.1:8000
MATCHMAKING_TIMEOUT_MS=5000
```

A estratégia só é aplicada às recomendações (`GET /startups/recomendacoes`) e à
descoberta com `sort=compatibility`. As ordenações explícitas `recent`, `name` e
`investment` continuam sendo consultas paginadas ao banco, sem inferência. O nome
legado `compatibility` seleciona o ranking configurado; não redefine o significado
do campo numérico `compatibility`.

Requer investidor autenticado, ativo e aprovado. Candidatas vêm do PostgreSQL
com os filtros existentes; o ramo supervisionado confirma também atividade,
aprovação, distinção entre UUID do perfil/usuário e tipo de usuário startup.
O FastAPI recebe somente projeções de atributos estruturados e `usuario.id/ativo`.
Nomes, emails, hashes de senha, textos livres e URLs não são enviados. São enviados
os atributos dos snapshots supervisionados e `estado`; `cidade` foi excluída pelo
pipeline treinado e não é enviada. Nenhum acesso ao PostgreSQL é feito pela IA.

`MatchmakingClient` reutiliza transporte, URL, timeout, AbortController e sanitização
de erros. Requisições supervisionadas têm validador próprio (enums, tipos estritos,
valores financeiros/contagens, perfis operacionais). Respostas exigem modelo XGBoost,
versões compatíveis, origem sintética, flag experimental, janela de 30 dias,
identidade correta, IDs autorizados e sem duplicações, probabilidades finitas em
[0,1], posições/ordem coerentes e versões iguais em todas as recomendações.
Campos extras do serviço não são propagados ao frontend.

Até 10.000 candidatas por chamada e limite até 1.000, conforme o FastAPI. Para
catálogos maiores, o backend obtém o top L de cada lote, verifica a identidade do
modelo e calcula o top L global por probabilidade decrescente e UUID crescente.
Não há fórmula híbrida com o 1A. Na descoberta, permanece o limite preexistente de
1.000 resultados ranqueados; o total corresponde a esse conjunto. Não foi criado
novo mecanismo de paginação de todo o catálogo nesta etapa.

## Fallback e erros graves

- Conexão indisponível, HTTP 5xx, rota supervisionada ausente (404) ou timeout:
  log estruturado sem dados pessoais e tentativa de todo o ranking pelo 1A.
- Falha num lote posterior descarta o ranking supervisionado parcial e recalcula
  todos os lotes com regras. Nunca são misturadas escalas/probabilidades.
- Payload inválido, HTTP 4xx de contrato, JSON inválido, probabilidades/IDs/ordem
  inconsistentes ou versões divergentes: log de erro de contrato e HTTP 502;
  **não são escondidos como sucesso com fallback**.
- Se o 1A também falhar, o erro controlado é propagado. Nenhuma probabilidade ou
  recomendação fictícia é produzida.

No fallback, `origemRecomendacao="rules"` e `fallback={de:"supervised",motivo:...}`.
Recomendações mantêm o score/explicações do 1A e contexto `rules`; não contêm
`probabilidadeInteresse`. O fallback de indisponibilidade foi exercitado com um
servidor HTTP controlado que responde 503 no supervised e encaminha rules ao
FastAPI real. Timeout usa transporte simulado nos testes unitários.

## Contrato e frontend

Exemplo reduzido de resposta real no banco descartável:

```json
{
  "origemRecomendacao": "supervised",
  "experimental": true,
  "versaoModelo": "xgboost-level2-seed42-temporal-v1",
  "versaoContrato": "supervised-v1",
  "versaoFeatures": "profiles-rules-v1",
  "versaoTarget": "first-interest-v1",
  "recomendacoes": [
    {"probabilidadeInteresse": 0.17781418561935425, "posicao": 1, "posicaoRanking": 1},
    {"probabilidadeInteresse": 0.17180465161800385, "posicao": 2, "posicaoRanking": 2}
  ]
}
```

A resposta completa inclui UUIDs, contexto assinado, avisos do modelo/perfil e
versões em cada recomendação. `versaoAlgoritmo` continua disponível como versão
do recomendador usado. No ramo rules, são preservados todos os campos anteriores,
com origem/posição adicionadas. No ramo supervised não se inventam `score`,
critérios ou explicações do 1A.

Na descoberta, `items/total/hasMore/facets` continuam no formato atual. Cards
supervisionados acrescentam `probabilidadeInteresse`, `posicaoRanking`,
`origemRecomendacao`, `versaoModelo`, `avisos` e contexto. **O campo compatibility
fica ausente**, em vez de receber `probabilidadeInteresse * 100`. Ele continua
reservado ao score real do 1A no ramo rules/fallback.

O schema Zod atual do frontend aceita essa resposta (compatibility é opcional),
mantém os cards na ordem recebida e não mostra um percentual 1A inventado. Porém
descarta os novos campos, portanto **não exibe a probabilidade ou origem**.
O colega do frontend deverá ampliar o schema/adaptador/modelo para preservá-los,
rotular a métrica como "probabilidade estimada de interesse — experimental" e
distinguir 1A/supervised/fallback. O seletor "maior compatibilidade" também precisa
explicar a estratégia ativa. Não houve alteração no frontend nem teste funcional
com a interface; a aceitação do contrato foi validada com o schema real.

## Exposições - atualização em 31/10/2026

A migration `ExposicoesSupervised1793404800000` foi validada e aplicada ao
`juntai_db` com autorização explícita. A CHECK agora admite `supervised`,
`discovery` e `rules`. O bloqueio 409 provisório foi removido. Contextos assinados
persistem a mesma origem, posição e versão do XGBoost; snapshots e revisões
incluem os atributos supervisionados, inclusive estado. Quatro confirmações
concorrentes retornaram a mesma exposição no teste PostgreSQL isolado.

A aplicação, comprovação do backup recuperável, constraints e dados preservados
estão em [supervised-exposures-migration.md](supervised-exposures-migration.md).
Nenhum dado sintético foi inserido no principal. A estratégia permanece rules por
padrão; ativação com frontend depende de nova autorização.

## Testes e preservação do ambiente

```powershell
$env:ADMIN_DB_TEST='0'
node --test tests/*.test.cjs
.\node_modules\.bin\tsc.cmd --noEmit

# Com o FastAPI atualizado em 8001; variável só neste processo de teste:
$env:MATCHMAKING_API_URL='http://127.0.0.1:8001'
node tests/level1-integration.cjs
```

O teste de integração começa explicitamente com rules, habilita supervised somente
nos blocos isolados e restaura a configuração. Usa a aplicação Express real,
login/JWT, TypeORM, FastAPI/XGBoost real e PostgreSQL descartável. Copia apenas o
schema sem copiar perfis; aplica somente a nova migration na cópia se necessário. Confere o resultado do
backend com chamada direta ao FastAPI, paginação, filtros, contexto e confirmação HTTP 200,
depois testa fallback HTTP e exposição idempotente. Remove somente o banco criado.

Resultados desta execução: **90 testes de backend aprovados e um ignorado**
(integração administrativa que escreveria no banco principal), **TypeScript sem
erros** e **17 verificações de integração aprovadas**. Os testes supervisionados usam
transporte/banco simulados para cenários de erro e grandes lotes; a suíte de
integração usa o XGBoost, HTTP e banco descartável reais, com indisponibilidade
supervisionada simulada por um servidor HTTP controlado no teste de fallback.

Foi verificado que todas as contagens/hashes das tabelas de `juntai_db` e seu schema
permaneceram iguais ao início. O principal continuou com zero exposições e uma
interação. Não foi usada uma conta real para recomendações: faltou identificação
confirmada de conta de teste; o fluxo completo ocorreu com perfis sintéticos
somente no banco descartável. Estratégia supervisionada não foi ativada no `.env`
ou no backend existente. Ativação funcional com frontend depende de autorização.
