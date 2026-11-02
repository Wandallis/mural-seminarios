# Mural de Seminarios

Aplicacao web para cadastrar seminarios, anexar slides em PDF e registrar a presenca de cada apresentador. O mesmo codigo pode ser implantado em AWS, Google Cloud ou Azure; mudam os recursos e as credenciais de cada destino.

## Arquitetura

| Parte | Tecnologia | Localmente | Na nuvem |
| --- | --- | --- | --- |
| Site | React + Vite, arquivos estaticos | Container Nginx em `http://localhost:5173` | AWS S3 + CloudFront, Firebase Hosting ou Azure Static Web Apps |
| API | Node.js + Express, imagem Docker | Container em `http://localhost:3000` | AWS Lambda + API Gateway, Google Cloud Run ou Azure Container Apps |
| Banco | PostgreSQL | Container com volume persistente | RDS, Cloud SQL ou Azure Database for PostgreSQL |
| Slides | Storage de objetos privado | Volume Docker | S3, Google Cloud Storage ou Azure Blob Storage |

O site e a API sao servicos separados. `VITE_API_URL` e definido no momento em que o React e compilado; o deploy tambem configura `CORS_ORIGIN` na API para aceitar o dominio do site. A imagem Docker contem somente a API.

## Executar localmente

Na pasta `mural-seminarios`, execute:

```sh
docker compose up --build
```

Abra `http://localhost:5173`. O Compose inicia PostgreSQL, API e site em containers separados. A API fica em `http://localhost:3000`; o PostgreSQL e os slides continuam em volumes Docker.

Para encerrar, use `Ctrl+C` e depois `docker compose down`. Isso preserva os volumes. **Nao use `docker compose down -v`** se quiser manter os dados locais.

Para rodar sem Docker, inicie PostgreSQL, configure `backend/.env` a partir de `backend/.env.example`, instale as dependencias e inicie a API:

```sh
cd backend
npm ci
npm run dev
```

Em outro terminal, inicie o site:

```sh
cd frontend
npm ci
npm run dev
```

Abra `http://localhost:5173`. `frontend/.env.example` mostra a configuracao local de `VITE_API_URL`.

## Funcionalidades e API

- `GET /health`: confirma que API e PostgreSQL estao disponiveis.
- `GET /api/seminars`: lista seminarios e apresentadores.
- `POST /api/slides/uploads`: no destino AWS, cria um formulario de upload temporario para enviar PDF diretamente ao S3.
- `POST /api/seminars`: cadastra seminario com 1 a 10 apresentadores e, opcionalmente, um PDF no campo multipart `slides`.
- `GET /api/seminars/:id/slides`: baixa o PDF do seminario.
- `GET /api/seminars/:id/presenters`: lista os apresentadores e a situacao de presenca.
- `PATCH /api/seminars/:id/presenters/:presenterId`: marca o apresentador como presente ou ausente.
- `DELETE /api/seminars/:id`: apaga o seminario e remove os slides do armazenamento.

Os PDFs sao validados por tipo e assinatura e tem limite padrao de 10 MB (`MAX_UPLOAD_SIZE_BYTES`). A API cria/atualiza as tabelas necessarias ao iniciar.

**Nao ha login, conforme solicitado para o trabalho academico.** Isso significa que qualquer pessoa que consiga acessar a URL publica pode cadastrar e excluir seminarios, baixar slides e alterar presencas. Nao use com dados pessoais ou para uma turma que precise de controle de acesso.

## Pipeline: do commit a verificacao

O workflow [.github/workflows/deploy.yml](./.github/workflows/deploy.yml) executa:

1. **Commit/push:** um push para `main` inicia o pipeline; pull requests executam validacao e build, sem publicar nem implantar.
2. **Build e testes:** testa a API com PostgreSQL, compila o site e cria uma imagem Docker contendo somente a API.
3. **Publicacao e deploy:** publica a imagem no GitHub Container Registry e a copia para o registry nativo escolhido. Atualiza a API e publica o site estatico separadamente.
4. **Verificacao:** testa a pagina publica, `/health` da API, a conexao com PostgreSQL e o cabecalho CORS. O resumo da execucao mostra as URLs; falhas incluem consulta aos logs do servico quando configurada.

O destino em pushes para `main` e escolhido pela variavel GitHub `DEPLOY_TARGET` (`aws`, `gcp` ou `azure`). Tambem e possivel escolher um destino em **Actions > Build, deploy e verificar > Run workflow**. O workflow implanta um destino por execucao; ele nao cria bancos, redes privadas, buckets, distribuicoes CDN ou servicos web.

### Criar o repositorio GitHub

Crie um repositorio vazio no GitHub e, na pasta do projeto, associe e envie o codigo:

```sh
git init -b main
git add .
git commit -m "feat: preparar deploy multi-cloud"
git remote add origin https://github.com/<usuario>/<repositorio>.git
git push -u origin main
```

Substitua a URL pelo repositorio real. Em **Settings > Actions > General > Workflow permissions**, permita que o `GITHUB_TOKEN` leia e publique packages. Cadastre valores em **Settings > Secrets and variables > Actions**. Use **Variables** para configuracoes nao sigilosas e **Secrets** para credenciais e strings de conexao. Nunca grave esses valores no codigo.

Depois que os recursos de uma nuvem estiverem prontos, defina `DEPLOY_TARGET` e os valores listados abaixo. A imagem GHCR pode permanecer privada: o workflow autentica para baixa-la e publica uma copia no registry nativo.

### AWS

| Servico | Recurso |
| --- | --- |
| API | Lambda (container no ECR) + API Gateway HTTP API |
| Site | Bucket S3 privado atras de uma distribuicao CloudFront |
| Banco | RDS PostgreSQL |
| Slides | Bucket S3 |

Lambda usa o AWS Lambda Web Adapter para executar o servidor Express. A API fica atras de um HTTP API do API Gateway. Os slides sao enviados diretamente do navegador ao S3 por um formulario presigned de curta duracao; a API valida o objeto, registra-o no PostgreSQL e usa links presigned curtos para download. Assim, os PDFs nao precisam atravessar os limites de payload de Lambda/API Gateway.

**Custo:** novas contas AWS podem ter um plano Free com creditos promocionais, mas isso nao torna toda a arquitetura gratuita nem garante que cada recurso/uso seja coberto. RDS, ECR, S3, API Gateway, CloudWatch e transferencia podem consumir creditos ou ser cobrados conforme o tipo de conta/regiao. Confira o [AWS Free Tier](https://aws.amazon.com/free/) da sua conta e configure um budget/alerta antes de criar recursos. Orcamento alerta, nao bloqueia gasto. Nao converta a conta para plano pago sem revisar os precos e limites.

Crie previamente: (1) VPC/subnets privadas, security group e RDS PostgreSQL; (2) endpoint Gateway para S3 associado as route tables usadas pela Lambda, para nao depender de NAT Gateway; (3) role de execucao Lambda; (4) bucket privado de slides com CORS permitindo `POST` apenas da origem CloudFront, e regra de lifecycle para apagar `pending/` apos 1 dia; (5) bucket privado do site e distribuicao CloudFront com Origin Access Control e `index.html` como documento raiz. Mantenha o RDS privado: a regra de entrada TCP 5432 deve permitir somente o security group da Lambda. O security group da Lambda precisa permitir conexoes de saida ao RDS e ao S3 pelo endpoint. Use nomes de bucket/registry dedicados ao projeto: o workflow configura a politica de retencao de imagens do ECR e sincroniza o bucket do site com `--delete`.

**Variables do repositorio GitHub:** `DEPLOY_TARGET=aws`, `AWS_REGION`, `AWS_ECR_REPOSITORY`, `AWS_LAMBDA_FUNCTION`, `AWS_LAMBDA_EXECUTION_ROLE_ARN`, `AWS_API_GATEWAY_NAME`, `AWS_LAMBDA_SUBNET_IDS` (IDs separados por virgula), `AWS_LAMBDA_SECURITY_GROUP_ID`, `AWS_S3_BUCKET`, `AWS_FRONTEND_BUCKET` e `AWS_CLOUDFRONT_DISTRIBUTION_ID`.

**Secrets:** `AWS_ROLE_TO_ASSUME` (role de deploy confiavel ao OIDC do GitHub) e `AWS_DATABASE_URL` (string PostgreSQL do RDS; codifique caracteres especiais do usuario/senha na URL). O workflow grava a string como variavel protegida na configuracao da Lambda; nao a imprima nem a coloque no codigo. A role de execucao da Lambda precisa de `AWSLambdaBasicExecutionRole`, `AWSLambdaVPCAccessExecutionRole` e permissao de leitura/escrita/exclusao somente nos objetos do bucket de slides. A role OIDC do GitHub precisa publicar imagens no ECR e configurar a retencao, criar/atualizar a funcao Lambda e sua concorrencia, passar a role de execucao, criar/atualizar API Gateway e permissao de invocacao, configurar/limitar logs, configurar CORS do bucket, publicar o site e invalidar o CloudFront.

O workflow limita a Lambda a 512 MB, 30 segundos e duas execucoes simultaneas, e limita o HTTP API a 2 requisicoes por segundo com burst 5. Esses limites reduzem risco de abuso, mas nao garantem custo zero. O Lambda precisa estar na VPC do RDS; sem endpoint Gateway para S3, nao coloque NAT Gateway apenas para este projeto, pois NAT pode gerar custo fixo relevante.

O navegador envia PDFs diretamente ao S3. No bucket de slides, configure CORS com a origem exata `https://<dominio-cloudfront>`, metodo `POST` e headers permitidos `*`. O bucket do site deve ser dedicado a este projeto porque o workflow sincroniza arquivos com `--delete`.

### Google Cloud

| Servico | Recurso |
| --- | --- |
| API | Cloud Run, imagem no Artifact Registry |
| Site | Firebase Hosting |
| Banco | Cloud SQL PostgreSQL |
| Slides | Google Cloud Storage |

Crie o projeto Firebase/Google Cloud, Cloud Run, Cloud SQL, bucket e service account de runtime. Atribua ao service account permissoes de acesso ao Cloud SQL, ao segredo no Secret Manager e ao bucket. O Cloud SQL deve estar conectado ao Cloud Run; o workflow configura `--add-cloudsql-instances`.

O segredo `GCP_DATABASE_SECRET` deve conter uma URL PostgreSQL que use o socket Cloud SQL, por exemplo `postgresql://USUARIO:SENHA@/BANCO?host=/cloudsql/PROJETO:REGIAO:INSTANCIA`. Codifique caracteres especiais de usuario/senha na URL. O trafego entre Cloud Run e Cloud SQL passa pelo conector gerenciado; o workflow desativa SSL do cliente PostgreSQL para essa conexao por socket.

**Variables:** `DEPLOY_TARGET=gcp`, `GCP_PROJECT_ID`, `GCP_REGION`, `GCP_ARTIFACT_REPOSITORY`, `GCP_RUN_SERVICE`, `GCP_RUNTIME_SERVICE_ACCOUNT`, `GCP_CLOUD_SQL_INSTANCE` (formato `projeto:regiao:instancia`), `GCS_BUCKET` e `GCP_DATABASE_SECRET` (nome do segredo no Secret Manager).

**Secrets:** `GCP_WORKLOAD_IDENTITY_PROVIDER` e `GCP_SERVICE_ACCOUNT`. Configure Workload Identity Federation para o repositorio GitHub. A identidade de deploy precisa administrar Artifact Registry e Cloud Run; a identidade de runtime precisa acessar Cloud SQL, Secret Manager e GCS. Habilite Firebase Hosting e conceda a permissao de deploy ao service account usado pelo workflow.

### Azure

| Servico | Recurso |
| --- | --- |
| API | Azure Container Apps, imagem no Azure Container Registry |
| Site | Azure Static Web Apps |
| Banco | Azure Database for PostgreSQL |
| Slides | Azure Blob Storage |

Crie previamente Container Apps no plano Consumption com ingress publico na porta 3000, minimo de 0 e maximo de 1 replica, um Azure Container Registry, Static Web Apps no plano Free, conta/container Blob Storage e PostgreSQL Flexible Server. A identidade de runtime do Container App precisa poder baixar do ACR; a rede/firewall do PostgreSQL deve aceitar conexoes do Container App. O workflow grava a URL do banco e a connection string do Blob como segredos do Container App e configura a escala entre 0 e 1 replica.

**Custo:** Container Apps Consumption pode escalar a zero; o workflow limita o maximo a uma replica. PostgreSQL Flexible Server cobra compute enquanto esta ativo, alem de armazenamento/backups. Para um teste curto, use uma configuracao pequena sem alta disponibilidade e exclua o grupo de recursos dedicado ao projeto assim que terminar. Creditos promocionais sao temporarios; nao migre para pagamento conforme o uso sem revisar os precos. Alertas de orcamento nao bloqueiam gastos. ACR e Blob Storage tambem podem consumir creditos.

**Variables:** `DEPLOY_TARGET=azure`, `AZURE_RESOURCE_GROUP`, `AZURE_CONTAINER_APP`, `AZURE_ACR_NAME`, `AZURE_STATIC_WEB_APP` e `AZURE_STORAGE_CONTAINER`.

**Secrets:** `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, `AZURE_SUBSCRIPTION_ID`, `AZURE_STATIC_WEB_APPS_API_TOKEN`, `AZURE_DATABASE_URL` e `AZURE_STORAGE_CONNECTION_STRING`. A identidade federada do GitHub precisa atualizar Container Apps, publicar no ACR e consultar os recursos; o token do Static Web Apps autoriza a publicacao do site.

## Variaveis da aplicacao

- `DATABASE_URL`: conexao PostgreSQL.
- `DB_SSL=true`: habilita TLS para conexoes TCP em nuvem; `DB_SSL=false` no Compose local e no socket Cloud SQL.
- `CORS_ORIGIN`: origem exata do site publicado. Pode aceitar varias origens separadas por virgula.
- `CLOUD_PROVIDER`: `local`, `aws`, `gcp` ou `azure`.
- `AWS_REGION` e `AWS_S3_BUCKET`, `GCS_BUCKET` ou `AZURE_STORAGE_CONTAINER`: configuracao do storage escolhido.
- `LOCAL_STORAGE_DIR`: diretorio local de slides no desenvolvimento.

## Construir a imagem da API

Na raiz do projeto:

```sh
docker build -t mural-seminarios-api .
```

A imagem expoe a porta 3000. Para uso local completo, prefira Docker Compose, que tambem configura o banco, o site e os volumes.
