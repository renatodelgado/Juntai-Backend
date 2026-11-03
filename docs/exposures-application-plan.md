# Plano para aplicação exclusiva de exposições

Preparado em 29/10/2026. A aplicação NÃO foi executada.

Destino confirmado por SELECT: container postgres_juntai, banco juntai_db,
PostgreSQL 16.14, schema public. synchronize=false no código.

Registradas: StartupApresentacaoUrl1791158400000,
AtualizarCadastroStartupInvestidor1791244800000,
UsuarioAvatarOpcional1791244800001, ConversasMensagens1791244800002,
IndicesAuditoria1791244800003. Comparação com os arquivos disponíveis: única
pendente ExposicoesStartups1793232000000. Tabela e índice ainda inexistentes.

## Backup já realizado

Arquivo completo, formato custom do pg_dump:
`C:\Users\Vinicius\AppData\Local\Temp\juntai-migration-backups\juntai_db-before-exposicoes-2026-10-29T20-12-50-024Z.dump`

Manifesto: mesmo caminho com sufixo `.json`.
Tamanho: 5.072.186 bytes.
SHA-256: `fa6eb99e5a56986d8446cc65cd1040de1144c86001b34c09d5bbc2fef7fcb15c`.

Arquivo decodificado integralmente por pg_restore --file=/dev/null, sem conexão
de restauração. Isso verifica leitura/descompressão, mas não equivale a testar
restauração em outro banco. Não imprimir nem versionar o conteúdo do backup.
Como está numa pasta temporária, preservar dump e manifesto num local seguro e
durável antes da aplicação. Se houver novas escritas, produzir backup novo na
janela de aplicação, com o tráfego de escrita pausado.

## Comandos PowerShell

Executar a partir de E:\ViniciusDoc\Projetos\Juntai-Backend.

```powershell
# Permitido nesta preparação: apenas consultas, em transação READ ONLY.
node scripts/apply-exposures.cjs --plan

# Verificação local do backup existente.
Get-FileHash -Algorithm SHA256 -LiteralPath 'C:\Users\Vinicius\AppData\Local\Temp\juntai-migration-backups\juntai_db-before-exposicoes-2026-10-29T20-12-50-024Z.dump'

# SOMENTE APÓS AUTORIZAÇÃO EXPLÍCITA; ainda não executado.
node scripts/apply-exposures.cjs --apply 'C:\Users\Vinicius\AppData\Local\Temp\juntai-migration-backups\juntai_db-before-exposicoes-2026-10-29T20-12-50-024Z.dump'
```

O script compara o arquivo da migration ao SHA-256 aprovado, verifica backup e
manifesto, valida DB_NAME/current_database e histórico exato das cinco migrations.
Não carrega as outras migrations. Na aplicação, obtém lock de coordenação e lock
do histórico; executa somente o up() selecionado e registra seu resultado pelo
MigrationExecutor oficial na mesma transação. Se alguma checagem falhar antes do
commit, ocorre rollback da transação. Não chama down(). Um novo histórico ou
arquivo diferente exige revisão, em vez de seguir automaticamente.

Não usar migration:run genérico nem fake migrations para outras pendências.
O lock não substitui uma janela operacional sem outro executor de migrations.

## Ordem proposta após aprovação

1. Pausar novas escritas no backend e impedir outros executores de migrations.
2. Preservar/renovar backup e manifesto e conferir checksum.
3. Repetir --plan. Se o estado divergir, interromper e revisar.
4. Executar --apply com o backup verificado.
5. Rodar as consultas abaixo, verificar as seis migrations e retomar o backend.

## Consultas pós-aplicação (somente leitura)

```powershell
docker exec postgres_juntai psql -U admin -d juntai_db -X -v ON_ERROR_STOP=1 -c "BEGIN READ ONLY; SELECT current_database(),current_schema(); SELECT id,timestamp,name FROM public.migrations ORDER BY timestamp,id; SELECT column_name,data_type,udt_name,is_nullable,column_default FROM information_schema.columns WHERE table_schema='public' AND table_name='exposicoes_startups' ORDER BY ordinal_position; SELECT indexname,indexdef FROM pg_indexes WHERE schemaname='public' AND tablename='exposicoes_startups' ORDER BY indexname; SELECT conname,contype,pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid='public.exposicoes_startups'::regclass ORDER BY contype,conname; COMMIT;"
```

Esperado: 11 colunas; dois índices (PK e exposicoes_par_data); uma PK, duas FKs
CASCADE e três CHECKs; exatamente uma nova entrada no histórico. Não inserir
exposições sintéticas no principal para verificar a migration.

Reversão automática permanece bloqueada por decisão aprovada. Qualquer correção
após o commit exige nova decisão; não restaurar o backup por cima do principal
automaticamente, pois isso poderia apagar gravações posteriores.
