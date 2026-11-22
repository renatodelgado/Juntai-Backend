# Recuperação de senha

O frontend solicita recuperação por `POST /auth/forgot-password` com `{ email }` e envia `{ token, senha }` a `POST /auth/reset-password`. A resposta da solicitação é genérica; tokens aleatórios são armazenados somente como hash, expiram em 30 minutos e são consumidos em uma transação. A alteração incrementa a versão de sessão, invalidando tokens de acesso anteriores. A senha aceita de 8 caracteres até 72 bytes UTF-8.

## Azure beta: preparação

1. Faça backup e aplique a migration `PasswordRecovery1795000000000` uma vez no banco beta, antes de publicar o backend. Ela adiciona `session_version` e as tabelas de recuperação e de limite. Não use `synchronize`. Valide a migração em banco de teste antes de aplicar na Azure.
2. Cadastre o segredo `acs-email-access-key` no Container App, contendo somente a chave do Azure Communication Services. A chave não pode constar no frontend ou no Git.
3. Na revisão do backend, configure `ACS_EMAIL_ACCESS_KEY` como referência ao segredo e os valores não secretos `ACS_EMAIL_ENDPOINT`, `ACS_EMAIL_SENDER`, `PASSWORD_RESET_FRONTEND_URL` (URL HTTPS terminando em `/redefinir-senha`) e `RECOVERY_TRUST_AZURE_INGRESS=true`. Esta última opção só é segura quando todo acesso passa pelo ingresso HTTP do Container Apps, que acrescenta o endereço remoto à direita do cabeçalho `X-Forwarded-For`. Sem ela, utiliza-se o endereço do socket, que pode ser compartilhado por clientes atrás de um proxy.
4. Publique backend e frontend e teste com uma conta de teste autorizada: solicitação, entrega, link expirado, reutilização, senha nova e invalidação da sessão anterior. Observe erros de envio e limites. A aceitação da API ACS não confirma entrega.

A API espera até 11 segundos para reduzir diferenças de tempo de resposta entre contas existentes e inexistentes; atrasos excepcionais de banco ou rede ainda podem introduzir variações. Solicitações são limitadas por endereço e por usuário. O limite por endereço depende da configuração correta do ingresso e não substitui proteção de borda contra tráfego distribuído. O envio e seus custos dependem da configuração e política da assinatura Azure.

## Testes

`npm test` inclui testes simulados. `tests/recovery-postgres.cjs` exige um PostgreSQL local descartável, vazio e isolado, com `RECOVERY_TEST_PORT` definido; ele cria tabelas e dados de teste. Nunca o execute em uma base com dados. A integração ACS real deve ser verificada separadamente no beta.
