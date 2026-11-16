# Interessados na startup

GET /startups/interessados exige autenticação de startup ativa e aprovada. A startup é derivada exclusivamente do usuário autenticado. Não aceita startupId de outra conta. Somente eventos interesse_demonstrado são considerados, deduplicados por investidor com a data do primeiro interesse. Perfis inativos ou não aprovados são omitidos.

Retorna items e resumo (interessados, conversasIniciadas e reunioesAgendadas). Cada item contém somente identidade/apresentação pública, preferências de segmento/estágio, áreas de ajuda e os vínculos reais de conversa/reuniões. Não retorna email, senha, telefone, ticket ou avaliações de terceiros. Uma conversa só é considerada iniciada após mensagem do investidor; avaliar conversa exige mensagem dos dois participantes. Reunião agendada tem precedência na situação, seguida de reunião realizada (em acompanhamento), conversa e novo interesse. O contador de reuniões soma todos os agendamentos, mesmo quando um investidor tem mais de um.

Não há migration, compatibilidade calculada ou mudança nas regras de iniciar conversa/agendamento. A página /startup/matches oferece perfil em modal, filtros locais, atualização a cada minuto/no retorno da janela e ações para conversa, reunião e feedback existentes. Reuniões aceitam ?reuniao=:id para abrir os detalhes do registro autorizado pela API.

Testes: npm test; npm run build; INTERESTED_DB_TEST=1 node tests/startup-interested-postgres.cjs (somente PostgreSQL local, schema temporário com rollback).
