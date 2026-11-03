# Validação da migration de exposições — 29/10/2026

Resultado: migration `ExposicoesStartups1793232000000` validada em PostgreSQL 16
real, em banco separado com nome exclusivo `juntai_exposure_test_<uuid>`.
Nenhum código de produção foi alterado nesta validação. A migration não foi
executada no `juntai_db` principal.

## Isolamento

Foi usado o servidor do container `postgres_juntai`, com um banco temporário
distinto, não um schema dentro do principal. O schema completo de `juntai_db` foi
copiado usando `pg_dump --schema-only --no-owner --no-privileges`. Dados reais não
foram copiados. Somente fixtures sintéticas foram inseridas no banco temporário.

O teste instancia outro `DataSource`, com `database` explicitamente temporário,
`synchronize=false` e somente a migration avaliada na lista de migrations. A
identidade do banco é confirmada antes das inserções. O script exige opt-in e
valida o prefixo e UUID do nome antes de remover o recurso que ele próprio criou.

O banco principal recebeu apenas leituras: dump de schema e contagens de usuários,
investidores, startups, interações, histórico de investimentos e migrations. O
schema normalizado e essas contagens foram comparados antes/depois, sem diferenças.

## Verificações aprovadas (13)

1. Aplicação da migration real via `DataSource.runMigrations`, com registro no
   histórico e nenhuma migration restante entre as configuradas para o teste.
2. Preservação de dados sintéticos, colunas, defaults, constraints e índices de
   todas as tabelas preexistentes; apenas o histórico de migrations recebe a
   entrada esperada.
3. Onze colunas com os tipos e nulabilidade previstos; PK UUID, índice composto,
   três CHECKs e duas FKs com `ON DELETE CASCADE`.
4. Defaults de timestamp, origem real, versão de contrato e semântica; posição e
   versão do recomendador opcionais.
5. Rejeição de UUID duplicado sem ON CONFLICT, referências inexistentes, campos
   obrigatórios nulos, origem inválida, posição zero/negativa e origem de dados
   inválida. Conferidos os SQLSTATEs de cada classe de erro.
6. `ON CONFLICT(id) DO NOTHING` preserva timestamp e snapshot originais em retry.
7. Duas transações reais: segunda inserção aguarda lock; primeira confirma;
   segunda não insere, consulta a exposição existente e resta uma única linha.
8. Duas transações reais: primeira desfaz; segunda consegue inserir e resta uma
   única linha.
9. UUIDs diferentes permitem exposições diferentes para o mesmo investidor/startup.
10. Duas chamadas concorrentes ao `MatchmakingService.confirmExposure` real
    retornam mesmo ID/timestamp; snapshot corresponde à projeção autorizada,
    sem nome/email sintéticos.
11. `undoLastMigration` é bloqueado pela exceção prevista, preservando tabela,
    exposições e registro da migration.
12. Inserções e falhas de constraints não modificam as tabelas preexistentes.
13. Exclusão de startup, investidor ou usuário remove exposições em cascata. Esses
    cenários são revertidos por transações de teste; o estado anterior é conferido.

Para as verificações concorrentes, foram usadas duas conexões e uma terceira
consulta a `pg_stat_activity` para confirmar espera de lock antes de liberar a
primeira transação. O cenário usa READ COMMITTED, como o banco restaurado.

## Regressões executadas

- Backend: 55 testes aprovados, 1 ignorado; TypeScript sem erros.
- Python: 155 testes aprovados, 1 ignorado.
- Frontend: 4 testes de visibilidade aprovados.
- Teste PostgreSQL dedicado: 13 verificações aprovadas.

Os testes ignorados são a integração administrativa que escreveria no banco
configurado e a integração opcional de embeddings reais.

Comandos, executados nos respectivos repositórios:

```powershell
# Backend — requer Docker e autorização para criar/remover o banco temporário.
$env:EXPOSURES_DISPOSABLE_TEST='1'
node tests/exposures-postgres.cjs

# Backend — sem integração administrativa no banco principal.
$env:ADMIN_DB_TEST='0'
node --test tests/*.test.cjs
node node_modules/typescript/bin/tsc --noEmit

# Python
python -m pytest -q

# Frontend
node --test tests/exposureVisibility.test.mjs
```

O teste descartável está fora do glob `*.test.cjs`, para não criar bancos em uma
execução comum de testes. Usa as configurações locais de conexão sem imprimi-las.

## Limpeza e observações

Todos os bancos temporários criados nas tentativas foram removidos, com ausência
confirmada em `pg_database`, inclusive após uma falha inicial de fixture. Essa
fixture precisou informar `capital_procurado`, que é NOT NULL no schema restaurado.
Foi ajustado somente o dado sintético; a migration e o código de produção não
precisaram de correção.

A validação confirma prontidão técnica da migration para as decisões adotadas:
idempotência por UUID de contexto, múltiplas exposições por par, cascata, rollback
automático bloqueado e estratégia atual de snapshots/hashes/locks.

A aplicação no banco principal continua pendente de autorização. Um comando
genérico `migration:run` pode executar outras migrations pendentes: a validação
desta migration isoladamente não autoriza nem valida todas as demais pendências.
