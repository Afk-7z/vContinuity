# vContinuity

[English](README.md) · **Português (Brasil)**

O vContinuity é uma ponte MCP local que permite a um cliente de IA na web, após autorização, trabalhar no seu computador e compartilhar o contexto de um projeto com agentes locais. Ele funciona sem depender de um fornecedor de modelos ou de um agente específico.

**Versão 0.7.0 (prévia).** O Windows é o ambiente principal de teste. Controle de mouse e teclado e automação visual da interface estão fora do escopo desta versão.

Por exemplo: um cliente web pode editar um projeto, rodar testes e salvar um checkpoint com o resultado e o próximo passo. Depois, um agente local retoma esse contexto e continua usando seu próprio editor e terminal. O painel local permite consultar e atualizar o mesmo registro.

## Instalação e primeiro acesso

Você precisa de Node.js 22 ou superior, npm e Git. Instale também o ripgrep (`rg`) para usar a busca em arquivos.

```powershell
git clone https://github.com/Afk-7z/vContinuity.git
cd vContinuity
npm ci
Copy-Item .\vcontinuity.config.example.json .\vcontinuity.config.json
```

O exemplo limita as operações de arquivos à pasta do repositório quando o serviço é iniciado nela. Edite `workspaceRoots` para incluir as pastas de projeto que deseja disponibilizar. Sem esse arquivo, o padrão inclui a pasta do vContinuity e as pastas Documentos, Projects, Downloads e Área de Trabalho da conta atual.

Para usar o painel e o MCP local, configure uma origem HTTPS de exemplo. Isso permite iniciar o serviço sem túnel e sem expô-lo à internet:

```powershell
$env:VCONTINUITY_PUBLIC_ORIGIN = "https://vcontinuity.example.test"
npm start
```

| Endereço padrão | Uso |
| --- | --- |
| [127.0.0.1:7783](http://127.0.0.1:7783/) | Painel local, checkpoints, jobs, transferências e aprovações OAuth |
| `http://127.0.0.1:7781/mcp/agent` | MCP para agentes locais, com uma ferramenta: `vcontinuity.work` |
| `http://127.0.0.1:7781/mcp/web` | MCP Web local, com 13 ferramentas; `/mcp` é um alias local |
| `http://127.0.0.1:7791` | Gateway Web com OAuth, destinado a receber o tráfego do proxy HTTPS |
| [127.0.0.1:7781/healthz](http://127.0.0.1:7781/healthz) | Estado do serviço |

## Continuidade de um projeto

1. Na aba **Continuidade** do painel, consulte a pasta do projeto. A pasta pode estar acessível sem ter um contexto cadastrado. A consulta não cria um registro.
2. Cadastre o trabalho se ainda não existir ou retome o trabalho existente. Pelo MCP local, use `vcontinuity.work` com `action: "list"` e o caminho da pasta em `root`, seguido de `create` ou `resume`.
3. Após uma mudança relevante, salve um checkpoint com o estado atual, testes realizados, pendências e próximos passos. Ao gravar pelo MCP, envie o `workId` e a revisão atual em `expectedRevision` para detectar alterações de outro cliente.

O painel recomenda revisar o checkpoint após atividade registrada além do resumo mais recente ou sete dias sem atualização. Ao retomar, o vContinuity escolhe o resumo mais recente e mostra a atividade posterior a ele. O painel preserva rascunhos ao alternar entre trabalhos e permite comparar checkpoints salvos.

Cada conexão OAuth tem sua própria seleção de trabalho ativo. Clientes MCP que enviam um identificador de sessão também podem separar a seleção entre sessões. O contexto em si continua compartilhado. Guarde apenas informações operacionais, sem credenciais ou raciocínio privado.

O painel também pré-visualiza a limpeza antes de aplicá-la. Jobs finalizados podem ser arquivados com seus logs e restaurados pelo ID do arquivo. A limpeza OAuth remove registros revogados ou expirados que se qualificam, preservando cadastros de clientes e autorizações em andamento.

## Acesso por um cliente web remoto (opcional)

1. Configure um proxy reverso ou túnel HTTPS apontando **somente** para `127.0.0.1:7791`. Mantenha as portas `7781` e `7783` locais.
2. Defina a origem HTTPS real em `VCONTINUITY_PUBLIC_ORIGIN` ou copie [oauth.config.example.json](oauth.config.example.json) para `data/oauth/config.json` e edite `publicOrigin`. A variável de ambiente tem precedência sobre o arquivo; se tiver definido a origem de exemplo, remova-a da sessão antes de usar o arquivo.
3. Reinicie o serviço e configure o cliente MCP para acessar `https://seu-host.example.com/mcp/web`. Abra o painel local, confira o cliente e aprove apenas os escopos necessários. Volte ao cliente para concluir a autorização. Você pode revogar a conexão pelo painel.

O MCP Web oferece consulta de projeto e saúde, operações de arquivo, execução de comandos, jobs, Git, transferências e contexto compartilhado. A [lista completa das ferramentas](README.md#web-mcp-tools) detalha cada uma. O MCP de agente local oferece apenas `vcontinuity.work`.

| Escopo OAuth | Permissão |
| --- | --- |
| `read` | Consultar informações do projeto e do serviço |
| `files:read` / `files:write` | Consultar ou modificar arquivos e usar as operações de transferência correspondentes |
| `commands:run` | Executar comandos e gerenciar jobs |
| `works:read` / `works:write` | Consultar ou atualizar contextos de trabalho |
| `git:read` / `git:write` | Consultar ou alterar branches e worktrees via Git |

**Atenção:** `commands:run` permite executar processos com as permissões da conta do sistema que roda o vContinuity. As pastas autorizadas limitam as ferramentas de arquivos, mas não isolam comandos no sistema operacional. Conceda esse escopo apenas a clientes confiáveis. Trate links temporários de transferência como sensíveis. Consulte a [política de segurança](SECURITY.md).

## Diagnóstico e testes

`npm run doctor` diagnostica ferramentas, configuração e portas sem alterar a instalação. Os testes abaixo usam dados temporários e não dependem de um túnel ou de uma conta OAuth real:

```powershell
npm run check
npm test
npm run verify:surface
npm run verify:agent
npm run verify:parity
npm run verify:oauth
npm run verify:oauth:security
npm run test:browser
npm run audit:public
```

Os testes de navegador usam Chromium, Chrome ou Edge. Se necessário, instale o Chromium de teste com `npx playwright-core install chromium`.

## Dados locais e licença

`data/` guarda os contextos de trabalho, jobs e o estado OAuth. Ele fica fora do Git, assim como `vcontinuity.config.json`, as dependências instaladas, arquivos de ambiente e logs. Antes de publicar alterações, rode `npm run audit:public`.

Licença Apache 2.0. Veja [LICENSE](LICENSE) e [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
