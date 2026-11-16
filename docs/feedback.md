# Feedback após interações

API autenticada, privada: somente o autor consulta ou edita sua avaliação. O destinatário é resolvido pelo servidor a partir dos participantes; IDs enviados pelo cliente não escolhem o avaliado.

- `GET /avaliacoes/conversa/:uuid` ou `/avaliacoes/reuniao/:id`: `{ elegivel, nome, avaliacao }`. A avaliação contém id, nota, comentario, criadoEm e atualizadoEm; ausente retorna null. Fora da interação retorna 404.
- `PUT` nos mesmos caminhos: `{ nota, comentario? }`. Nota inteira de 1 a 5; comentário opcional de até 2000 caracteres. Cria ou atualiza a avaliação do autor e retorna o mesmo contrato do GET. Índices únicos parciais garantem uma avaliação por autor/contexto mesmo com concorrência. Conversas exigem mensagens de ambos; reuniões exigem status realizada. Contexto ainda inelegível retorna 409.
- `GET /avaliacoes/pendentes`: até 20 reuniões realizadas sem avaliação do usuário, mais recentes primeiro. Conversas são avaliadas por iniciativa do participante.
- `POST /avaliacoes/:tipo/:id/adiar`: resposta 204; suspende o lembrete por 24 horas, persistido por usuário/contexto. Não impede avaliação manual.

## Conclusão de reuniões

A conclusão manual só é aceita a partir do horário de início (400 antes disso). O processo em Server.ts roda ao iniciar e a cada 60 segundos, concluindo apenas reuniões ainda agendadas cujo início ocorreu há pelo menos 24 horas. Se o servidor ficar indisponível, a próxima inicialização recupera as reuniões vencidas. Canceladas e no_show não são alteradas. Atualizações manuais condicionais evitam sobrescrever uma mudança concorrente (409).

## Implantação e dados existentes

Aplicar a migration `1794787200000-FeedbackInteracoes` no ambiente de destino antes de disponibilizar as rotas. A migration é entregue pelo PR; não é aplicada automaticamente pelo servidor. O frontend depende desta versão da API.

A migration cria a tabela avaliacoes se ausente, adiciona conversa_id e atualizado_em, validações para novas escritas, índices únicos e a tabela de adiamentos. Dados históricos são preservados; CHECKs NOT VALID permitem mantê-los enquanto restringem novas escritas. Duplicidades históricas por reunião/autor impedem a criação do índice: revisar e resolver explicitamente antes de reaplicar, sem exclusão automática. A execução deve ser transacional, como o padrão do TypeORM. Não há rollback destrutivo automático.

## Validação

`npm test` e `npm run build`.

Integração PostgreSQL local: `$env:FEEDBACK_DB_TEST='1'; node tests/feedback-postgres.cjs` (PowerShell). Usa as credenciais locais já configuradas, cria tabelas mínimas em um schema aleatório dentro de uma transação, aplica a migration nesse schema e faz rollback no final. Não modifica as tabelas de negócio. Cobre autorização, elegibilidade bilateral, privacidade, upsert concorrente, pendências, adiamento, conclusão de reuniões e restrições no banco.

## Feedback compacto e confirmação de investimento

Migration adicional: `1794787200001-FeedbackResultados`, aplicada depois de FeedbackInteracoes. Adiciona resultado_interacao e perspectiva_investimento com CHECKs e valores neutros para avaliações anteriores, preservando nota/comentário.

PUT aceita `resultadoInteracao`: em_analise, avancar, nao_seguir; e `perspectivaInvestimento`: nao_definido, em_negociacao, intencao, realizado, nao_se_aplica. Clientes anteriores podem omitir esses campos: novos registros usam os valores neutros, e atualizações preservam as métricas já existentes. Valores desconhecidos ou null são rejeitados com 400.

GET/PUT retornam esses campos na própria avaliacao e dois indicadores: investimentoInformadoPeloOutro e investimentoConfirmado. O primeiro revela somente se o outro participante declarou realizado nessa mesma interação. O segundo é calculado no servidor e só é verdadeiro quando ambos declararam realizado; uma edição que retire a declaração desfaz a confirmação. Intenção ou negociação nunca confirmam investimento. Nota, comentário, resultado e demais perspectivas do outro participante não são retornados. Não há compartilhamento automático entre conversa e reunião, nem alteração do histórico financeiro ou registro de valores investidos.

O frontend usa três perguntas: estrelas, resultado e perspectiva; comentário opcional fica recolhido. A declaração de investimento realizado e sua confirmação são explicadas no próprio formulário.
