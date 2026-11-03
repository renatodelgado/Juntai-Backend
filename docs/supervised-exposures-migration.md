# Exposições supervisionadas — validação e aplicação em 31/10/2026

**Aplicada com COMMIT:** `ExposicoesSupervised1793404800000`.
Arquivo novo: `src/shared/database/migrations/1793404800000-ExposicoesSupervised.ts`.
A migration original não foi modificada.

Destino confirmado: `postgres_juntai`, PostgreSQL 16.14, porta 5433,
`juntai_db`, schema `public`, TypeORM `synchronize=false`.

## Mudança e garantias

O nome real foi consultado no catálogo: `exposicoes_startups_origem_recomendacao_check`.
A migration valida a definição anterior e exige transação ativa. Remove apenas
essa CHECK e recria uma equivalente admitindo `discovery`, `rules`, `supervised`.
Não há DML nos registros de negócio, DROP/CREATE de tabela ou alteração de colunas.
Rollback automático por `down` é recusado para não invalidar histórico supervisionado;
requer plano explícito de preservação. O rollback da transação foi testado.

PK, duas FKs com ON DELETE CASCADE, CHECKs de posição e origem dos dados, dois
índices, 11 colunas/defaults e demais objetos inspecionados foram preservados.

## Backup existente comprovado

Foi usado o backup já existente, sem criar outro:

`C:\Users\Vinicius\AppData\Local\Temp\juntai-migration-backups\juntai_db-before-exposicoes-2026-10-29T20-12-50-024Z.dump`

SHA-256: `fa6eb99e5a56986d8446cc65cd1040de1144c86001b34c09d5bbc2fef7fcb15c`.
Tamanho: 5.072.186 bytes. Checksum e manifesto conferidos.

O arquivo foi **restaurado integralmente** em banco descartável. Como antecedia a
criação de exposições, a migration original foi aplicada somente nessa cópia.
O resultado coincidiu exatamente com o principal antes desta alteração: contagens
e hashes de todas as tabelas, histórico, colunas, constraints, índices e sequências.
Isso comprovou recuperação e compatibilidade; não apenas leitura do arquivo.
Nenhum conteúdo pessoal restaurado foi impresso ou exportado para o repositório.
Todos os bancos usados nessas validações foram removidos.

## Validação prévia e execução principal

`scripts/supervised-migration.cjs --validate-backup <arquivo.dump>`:

1. Restaura/reconstrói o estado prévio e compara com leitura do principal.
2. Insere duas exposições preexistentes somente na cópia e verifica preservação.
3. Executa a nova migration em uma transação desfeita e confirma rollback completo.
4. Executa a migration via TypeORM e confere que só ela foi registrada.
5. Testa três origens válidas, origem desconhecida, PK, FK, NULL e posição zero.
6. Executa a suíte backend sem a integração administrativa de escrita e TypeScript.
7. Guarda recibo local em `artifacts/migrations/`, ignorado pelo Git.

Antes da aplicação principal, a integração HTTP completa também passou com a
migration aplicada apenas na cópia descartável.

`scripts/supervised-migration.cjs --apply` foi executado após esses testes. O script
reconferiu backup e hash da migration, `current_database()`, estado completo e
lista de pendências. Dentro da mesma transação, usou locks e o executor TypeORM.
A única pendente era `ExposicoesSupervised1793404800000`; somente ela foi executada.
Comparações de preservação ocorreram antes do COMMIT e foram repetidas após ele.

O único registro acrescentado ao principal foi o registro autorizado na tabela
`migrations` (ID 7, timestamp `1793404800000`). A sequência dessa tabela avançou
normalmente. Nenhum registro preexistente foi alterado.

Recibos, sem conteúdo de perfis: `artifacts/migrations/supervised-validation.json`
e `artifacts/migrations/supervised-applied.json`. Eles preservam evidências do
estado inspecionado e hashes, não são novos backups. O modo `--apply` não é um
comando para reaplicar: estados divergentes ou migration já aplicada interrompem
a operação. O backup continua recuperável pelo mesmo conjunto de migrations.

## Pós-COMMIT

Uma conexão independente somente de leitura conferiu:

- Histórico com as seis migrations anteriores intactas e a nova como sétima.
- Nenhuma migration pendente.
- CHECK validada aceitando os três valores e rejeitando `invalid`, avaliada sobre
  uma lista de valores em SELECT, sem inserir testes no principal.
- Demais constraints/índices/colunas e registros preservados.
- `exposicoes_startups` continua vazia e `funil_interacoes` continua com um registro.

## Fluxo completo de exposição

Foi removido somente o bloqueio 409 provisório no backend e corrigidas as revisões
e projeções de snapshot para usar os atributos supervisionados quando a origem é
supervised, incluindo `estado`. Os fluxos discovery/rules usam suas projeções
anteriores. O tipo de usuário startup também é conferido nesse novo ramo.

O teste `level1-integration.cjs` usa aplicação Express, login/JWT, TypeORM,
FastAPI/XGBoost real e banco descartável. Se a cópia tiver o schema anterior,
executa somente a nova migration nela, com o histórico copiado como metadados.
Após o principal migrado, usa a cópia do schema atual e não há migration pendente.

Resultados antes e depois do COMMIT:

- Recomendação Node → FastAPI supervisionada real e contexto assinado.
- Confirmação HTTP 200 e persistência com `origem_recomendacao='supervised'`.
- `versao_recomendador='xgboost-level2-seed42-temporal-v1'` e posição corretas.
- Snapshot igual à projeção dos perfis usados, sem informações pessoais extras.
- Quatro confirmações concorrentes do mesmo contexto devolvem a mesma exposição.
- Fallback por indisponibilidade controlada usa HTTP real do 1A e contexto rules,
  com persistência e idempotência preservadas.
- Principal permanece igual ao estado já migrado durante todos esses testes.

**90 testes backend aprovados, um administrativo ignorado; TypeScript sem erros;
17 verificações de integração aprovadas.** Testes de regressão adicionais rejeitam
alteração do estado do investidor/startup entre recomendação e confirmação.

## Arquivos desta etapa e limites

- Nova migration e `scripts/supervised-migration{,-state}.cjs`.
- `MatchmakingService.ts`: persistência supervisionada e snapshots/revisões.
- `tests/supervised-matchmaking.test.cjs` e `tests/level1-integration.cjs`.
- `.gitignore`: recibos locais excluídos.
- Esta documentação e atualização do status da integração anterior.

Não houve alteração de frontend, FastAPI, XGBoost, algoritmos, dataset ou `.env`.
A estratégia padrão permanece rules, sem ativação automática ou deploy.

Pendência independente de coleta/inferência: o adaptador offline Python
`StoredExposure` ainda só aceita discovery/rules. Uma futura exportação de
exposições supervised para esse adaptador precisará ampliar seu contrato sob
autorização; ele não participa da persistência Node testada e não foi modificado,
respeitando o escopo desta etapa. Não há bloqueio restante no registro PostgreSQL.
