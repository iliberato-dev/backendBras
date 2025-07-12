require('dotenv').config(); // Garante que as variáveis de ambiente do .env sejam carregadas

const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const fetch = require('node-fetch'); // Certifique-se de que 'node-fetch' está instalado: npm install node-fetch

const app = express();
const PORT = process.env.PORT || 3000;

// --- CONFIGURAÇÃO DE URLs E CORS ---
// Puxe as variáveis de ambiente
const APPS_SCRIPT_URL = process.env.APPS_SCRIPT_URL;
const FRONTEND_URL = process.env.FRONTEND_URL;
const APPS_SCRIPT_AUTH_TOKEN = process.env.APPS_SCRIPT_AUTH_TOKEN;

// Variáveis para login do administrador
const ADMIN_USERNAME = process.env.ADMIN_USERNAME;
const ADMIN_RI = process.env.ADMIN_RI; // RI para login do administrador

// Configuração do CORS para permitir requisições apenas do seu frontend
app.use(cors({
    origin: FRONTEND_URL,
    methods: ['GET', 'POST', 'PUT', 'DELETE'],
    allowedHeaders: ['Content-Type', 'Authorization'],
}));

// Middleware para parsear o corpo das requisições como JSON
app.use(bodyParser.json());

// --- CACHE DE MEMBROS ---
// Cache para armazenar os dados dos membros e evitar requisições excessivas ao Apps Script
let cachedMembros = null;
let lastMembrosFetchTime = 0;
const MEMBERS_CACHE_TTL = 5 * 60 * 1000; // Cache de 5 minutos (em milissegundos)

// --- FUNÇÃO UTILITÁRIA PARA REQUISIÇÕES AO APPS SCRIPT ---
/**
 * Realiza uma requisição ao Google Apps Script.
 * @param {string} actionType - O tipo de ação/função a ser chamada no Apps Script (usado como 'tipo' em GET, ou para contexto em POST).
 * @param {string} method - O método HTTP ('GET' ou 'POST').
 * @param {object} body - O corpo da requisição para métodos POST.
 * @param {object} queryParams - Parâmetros de query para métodos GET.
 * @returns {Promise<object>} - A resposta JSON do Apps Script.
 */
async function fetchFromAppsScript(actionType, method = 'GET', body = null, queryParams = {}) {
    // Validação inicial das variáveis de ambiente
    if (!APPS_SCRIPT_URL) {
        console.error('Backend: Erro de configuração: Variável de ambiente APPS_SCRIPT_URL não definida.');
        throw new Error('Erro de configuração do servidor: URL do Apps Script não definida.');
    }
    if (!APPS_SCRIPT_AUTH_TOKEN) {
        console.error('Backend: Erro de configuração: Variável de ambiente APPS_SCRIPT_AUTH_TOKEN não definida.');
        throw new Error('Erro de configuração do servidor: Token de autenticação do Apps Script não definido.');
    }

    let url = APPS_SCRIPT_URL;
    const urlParams = new URLSearchParams();
    const options = {
        method: method,
        headers: { 'Content-Type': 'application/json' },
    };

    if (method === 'GET') {
        urlParams.append('tipo', actionType); // O Apps Script usa 'tipo' para rotear a requisição GET
        urlParams.append('auth_token', APPS_SCRIPT_AUTH_TOKEN); // Token para autenticação no Apps Script
        
        // Adiciona outros parâmetros de query à URL
        for (const key in queryParams) {
            if (queryParams.hasOwnProperty(key) && queryParams[key]) {
                urlParams.append(key, queryParams[key]);
            }
        }
        url = `${APPS_SCRIPT_URL}?${urlParams.toString()}`;
    } else if (method === 'POST') {
        // Para POST, o token é incluído no corpo do JSON, junto com os dados da requisição
        const postBody = { ...body, auth_token: APPS_SCRIPT_AUTH_TOKEN };
        options.body = JSON.stringify(postBody);
    } else {
        throw new Error(`Método HTTP não suportado: ${method}`);
    }
    
    console.log(`Backend: Encaminhando ${method} para Apps Script: ${url}`);
    
    // Realiza a requisição ao Google Apps Script
    const response = await fetch(url, options);
    const responseText = await response.text(); // Lê a resposta como texto primeiro

    let responseData;
    try {
        responseData = JSON.parse(responseText); // Tenta parsear como JSON
    } catch (e) {
        // Loga o erro se a resposta não for um JSON válido
        console.error(`Backend: Erro ao parsear JSON do Apps Script: ${e.message}. Resposta bruta (primeiros 500 chars): ${responseText.substring(0, 500)}...`);
        throw new Error(`Resposta inválida do Apps Script: ${responseText.substring(0, 100)}...`);
    }

    // Lança um erro se a requisição não foi bem-sucedida ou se o Apps Script indicou falha
    if (!response.ok || responseData.success === false) {
        console.error(`Backend: Erro lógico/HTTP do Apps Script (${actionType} ${method}): Status ${response.status} - Resposta: ${JSON.stringify(responseData)}`);
        const errorMessage = responseData.message || 'Erro desconhecido do Apps Script.';
        const error = new Error(errorMessage);
        // Propaga informações adicionais de erro (como 'alreadyExists' para presenças duplicadas)
        if (responseData.alreadyExists) {
            error.alreadyExists = true;
            error.lastPresence = responseData.lastPresence;
        }
        throw error;
    }
    
    console.log(`Backend: Resposta bem-sucedida do Apps Script (${actionType} ${method}): ${JSON.stringify(responseData)}`);
    return responseData; // Retorna os dados da resposta do Apps Script
}

/**
 * Função para obter membros, utilizando o cache.
 * Busca do Apps Script apenas se o cache estiver expirado ou vazio.
 */
async function getMembrosWithCache() {
    // Verifica se o cache é válido (não nulo e dentro do TTL)
    if (cachedMembros && (Date.now() - lastMembrosFetchTime < MEMBERS_CACHE_TTL)) {
        console.log("Backend: Retornando membros do cache.");
        return { success: true, membros: cachedMembros };
    }

    console.log("Backend: Buscando membros do Apps Script (cache expirado ou vazio).");
    // Faz a requisição ao Apps Script para obter os membros
    const data = await fetchFromAppsScript('getMembros'); // Chama a função 'getMembros' no Apps Script
    
    if (data.success) {
        // Atualiza o cache se a requisição foi bem-sucedida
        cachedMembros = data.membros;
        lastMembrosFetchTime = Date.now();
        console.log(`Backend: Membros cacheados. Total: ${cachedMembros.length}`);
    } else {
        console.warn("Backend: Falha ao buscar membros do Apps Script para cache:", data.message);
    }
    return data;
}

// Helper para normalizar strings para comparação (removendo acentos, caracteres especiais, e convertendo para minúsculas)
function normalizeString(str) {
    if (typeof str !== 'string') {
        return '';
    }
    return str.toLowerCase()
              .normalize("NFD") // Normaliza para decompor caracteres acentuados
              .replace(/[\u0300-\u036f]/g, "") // Remove os diacríticos (acentos)
              .replace(/[^a-z0-9\s]/g, '') // Remove caracteres não alfanuméricos (mantém espaços)
              .trim();
}

---

### Rotas da API

```javascript
// Rota para obter membros (com cache)
app.get('/get-membros', async (req, res) => {
    try {
        // Tenta obter membros do cache ou do Apps Script
        const data = await getMembrosWithCache();
        
        // Se houver filtros na query, aplica-os localmente
        const { nome, periodo, lider, gape } = req.query;
        let filteredMembros = data.membros || [];

        if (nome) {
            const normalizedNameFilter = normalizeString(nome);
            filteredMembros = filteredMembros.filter(m => 
                normalizeString(m.Nome || '').includes(normalizedNameFilter)
            );
        }
        if (periodo) {
            filteredMembros = filteredMembros.filter(m => 
                normalizeString(m.Periodo || '') === normalizeString(periodo)
            );
        }
        if (lider) {
            const normalizedLiderFilter = normalizeString(lider);
            filteredMembros = filteredMembros.filter(m => {
                const liderCompleto = String(m.Lider || '').trim();
                let nomeLiderExtraido = liderCompleto;
                // Tenta extrair o nome do líder se houver prefixo de congregação
                if (m.Congregacao && liderCompleto.startsWith(`${m.Congregacao} | `)) {
                    nomeLiderExtraido = liderCompleto.substring(`${m.Congregacao} | `.length).trim();
                }
                return normalizeString(nomeLiderExtraido).includes(normalizedLiderFilter);
            });
        }
        if (gape) {
            filteredMembros = filteredMembros.filter(m => 
                normalizeString(m.Congregacao || '') === normalizeString(gape)
            );
        }

        // Retorna os membros filtrados
        res.status(200).json({ success: true, membros: filteredMembros });
    } catch (error) {
        console.error('Erro no backend ao obter membros (via cache ou Apps Script):', error.message);
        res.status(500).json({ success: false, message: 'Erro ao obter dados de membros.', details: error.message });
    }
});

// Rota para registrar presença (POST)
app.post('/presenca', async (req, res) => {
    // Captura todos os dados enviados pelo frontend
    const { memberId, memberName, leaderName, gapeName, periodo, presenceDate } = req.body;

    // Adiciona validação para todos os campos essenciais
    if (!memberId || !memberName || !leaderName || !gapeName || !periodo || !presenceDate) {
        return res.status(400).json({ success: false, message: 'Dados incompletos para registrar presença.' });
    }

    try {
        // Envia TODOS os dados relevantes para o Apps Script via POST
        // O Apps Script `doPost` precisará ser adaptado para processar esses campos
        const responseData = await fetchFromAppsScript(
            'registerMemberPresence', // Este é um rótulo; o Apps Script via `doPost` lerá o corpo
            'POST', 
            { memberId, memberName, leaderName, gapeName, periodo, presenceDate } // Objeto a ser JSON.stringify-ado e enviado
        );
        
        res.status(200).json(responseData);
    } catch (error) {
        console.error('Erro no backend ao registrar presença:', error.message);

        // Lida com erro de presença já existente
        if (error.alreadyExists) {
            return res.status(409).json({
                success: false,
                message: error.message,
                lastPresence: error.lastPresence || null
            });
        }
        
        res.status(500).json({ success: false, message: 'Erro ao registrar presença.', details: error.message });
    }
});

// Rota para obter o resumo total de presenças
app.get('/get-presencas-total', async (req, res) => {
    try {
        // req.query já contém os parâmetros de filtro como startDate, endDate, lider, gape etc.
        // O `actionType` 'getMonthlySummary' deve corresponder a uma função no seu Apps Script
        const data = await fetchFromAppsScript('getMonthlySummary', 'GET', null, req.query);
        // O Apps Script deve retornar { success: true, totalPresences: X, totalAbsences: Y, memberCounts: {...} }
        // Retorne o objeto 'data' completo, que já inclui 'success'
        res.status(200).json(data); 
    } catch (error) {
        console.error('Erro no backend ao obter presenças totais:', error.message);
        res.status(500).json({ success: false, message: 'Erro ao obter presenças totais.', details: error.message });
    }
});

// Rota para obter as últimas presenças de todos os membros
app.get('/get-all-last-presences', async (req, res) => {
    try {
        const data = await fetchFromAppsScript('getLastPresencesForAllMembers');
        // O Apps Script deve retornar { success: true, data: { ... } }
        // Retorne o objeto 'data' completo
        res.status(200).json(data); 
    } catch (error) {
        console.error('Erro no backend ao obter todas as últimas presenças:', error.message);
        res.status(500).json({ success: false, message: 'Erro ao obter últimas presenças de todos os membros.', details: error.message });
    }
});

// Rota de Autenticação (LOGIN)
app.post("/login", async (req, res) => {
    const { username, password } = req.body;
    console.log(`Backend: Tentativa de login para usuário: "${username}"`);

    // 1. Tenta autenticar como administrador master (credenciais hardcoded via .env)
    if (ADMIN_USERNAME && ADMIN_RI && 
        normalizeString(username) === normalizeString(ADMIN_USERNAME) && 
        password === ADMIN_RI) { // RI do admin deve ser exato
        console.log(`Backend: Login bem-sucedido para usuário master: ${username}`);
        return res.status(200).json({ success: true, message: 'Login bem-sucedido como Administrador!', leaderName: username, role: 'admin' });
    }

    // 2. Se não for administrador, tenta autenticar como líder (usando dados cacheados)
    try {
        const responseData = await getMembrosWithCache();
        const membros = responseData.membros || [];
        
        if (!membros || !Array.isArray(membros) || membros.length === 0) {
            console.warn("Backend: Nenhuma lista de membros válida retornada ou a lista está vazia para autenticação.");
            return res.status(404).json({ success: false, message: 'Erro: Não foi possível carregar os dados de membros ou a lista está vazia para autenticação.' });
        }

        const usernameDigitadoNormalized = normalizeString(username);
        const passwordDigitado = String(password || '').trim(); // RI do usuário deve ser exato

        let membroEncontradoPeloNome = null;

        // Lógica aprimorada para encontrar o membro pelo nome (correspondência flexível)
        // Prioriza correspondência exata, depois início da string, depois palavras contidas.
        membroEncontradoPeloNome = membros.find(membro => 
            normalizeString(membro.Nome || '') === usernameDigitadoNormalized
        );

        if (!membroEncontradoPeloNome) {
            membroEncontradoPeloNome = membros.find(membro =>
                normalizeString(membro.Nome || '').startsWith(usernameDigitadoNormalized)
            );
        }

        if (!membroEncontradoPeloNome) {
            membroEncontradoPeloNome = membros.find(membro => {
                const nomeMembroNaPlanilhaNormalized = normalizeString(membro.Nome || '');
                const usernameWords = usernameDigitadoNormalized.split(' ').filter(w => w.length > 0);
                return usernameWords.every(word => nomeMembroNaPlanilhaNormalized.includes(word));
            });
        }
        
        if (membroEncontradoPeloNome) {
            console.log(`Backend Login: Membro encontrado pelo nome flexível: ${membroEncontradoPeloNome.Nome}`);
            
            // **Verifica a senha (RI) - DEVE SER EXATO**
            if (String(membroEncontradoPeloNome.RI || '').trim() === passwordDigitado) {
                console.log(`Backend Login: Senha (RI) correta para ${membroEncontradoPeloNome.Nome}.`);
                
                const cargoMembroNormalized = normalizeString(membroEncontradoPeloNome.Cargo || '');
                const statusMembroNormalized = normalizeString(membroEncontradoPeloNome.Status || '');
                
                let isLeaderByRole = false;

                // 1. Verifica se o Cargo ou Status do próprio membro indica liderança
                if (cargoMembroNormalized.includes('lider') || statusMembroNormalized.includes('lider')) {
                    isLeaderByRole = true;
                    console.log(`Backend Login: Membro '${membroEncontradoPeloNome.Nome}' é líder por Cargo/Status.`);
                }

                // 2. Verificação adicional: Se o membro não foi identificado como líder por Cargo/Status,
                // verifica se o nome do membro aparece como líder em qualquer 'Grupo Líder'
                if (!isLeaderByRole) { 
                    const nomeDoMembroLogandoNormalized = normalizeString(membroEncontradoPeloNome.Nome || '');
                    console.log(`Backend Login: Verificando se '${nomeDoMembroLogandoNormalized}' aparece como líder em algum grupo...`);

                    isLeaderByRole = membros.some(anyMember => {
                        const liderNaPlanilhaCompleto = String(anyMember.Lider || '').trim();
                        const congregacaoAnyMember = String(anyMember.Congregacao || '').trim();

                        let nomeLiderExtraidoDoGrupo = '';
                        const dynamicPrefix = congregacaoAnyMember ? `${congregacaoAnyMember} | ` : '';

                        if (dynamicPrefix && liderNaPlanilhaCompleto.startsWith(dynamicPrefix)) {
                            nomeLiderExtraidoDoGrupo = liderNaPlanilhaCompleto.substring(dynamicPrefix.length).trim();
                        } else {
                            nomeLiderExtraidoDoGrupo = liderNaPlanilhaCompleto;
                        }

                        // Compara o nome normalizado do membro que está logando com o nome do líder extraído (também normalizado)
                        return normalizeString(nomeLiderExtraidoDoGrupo) === nomeDoMembroLogandoNormalized;
                    });
                }
                
                console.log(`Backend Login: Resultado final - É líder? ${isLeaderByRole}`);

                if (isLeaderByRole) {
                    console.log(`Backend: Login bem-sucedido para o líder: ${membroEncontradoPeloNome.Nome}`);
                    return res.status(200).json({ success: true, message: `Login bem-sucedido, ${membroEncontradoPeloNome.Nome}!`, leaderName: membroEncontradoPeloNome.Nome, role: 'leader' });
                } else {
                    console.log(`Backend: Usuário '${username}' encontrado e senha correta, mas não tem o cargo/status de Líder ou não é líder de grupo.`);
                    return res.status(401).json({ success: false, message: 'Credenciais inválidas: Usuário não é um líder.', role: 'member' });
                }
            } else {
                console.log(`Backend: Senha inválida para o usuário: ${username}`);
                return res.status(401).json({ success: false, message: 'Senha inválida.' });
            }
        } else {
            console.log(`Backend: Usuário '${username}' não encontrado na lista de membros.`);
            return res.status(401).json({ success: false, message: 'Usuário não encontrado ou credenciais inválidas.' });
        }

    } catch (error) {
        console.error("Backend: Erro FATAL ao tentar autenticar líder com Apps Script:", error.message);
        return res.status(500).json({ success: false, message: 'Erro interno do servidor ao autenticar.', details: error.message });
    }
});

// Rota de status para verificar se o servidor está online
app.get('/status', (req, res) => {
    res.status(200).json({ status: 'API está online e funcionando!', timestamp: new Date().toISOString() });
});

// Rota para obter o resumo detalhado (faltas/presenças por período/membro)
app.get('/get-faltas', async (req, res) => {
    try {
        // req.query passará os parâmetros (startDate, endDate, memberId, lider, gape) para o Apps Script
        // O `actionType` 'getDetailedSummary' deve corresponder a uma função no seu Apps Script
        const data = await fetchFromAppsScript('getDetailedSummary', 'GET', null, req.query);
        // O Apps Script deve retornar um objeto com { success: true, ...dadosDoResumo }
        res.status(200).json(data); 
    } catch (error) {
        console.error('Erro no backend ao obter faltas/resumo detalhado:', error.message);
        res.status(500).json({ success: false, message: 'Erro ao obter resumo detalhado.', details: error.message });
    }
});

// Rota de Logout (simples, apenas para o frontend saber que o logout foi processado)
app.post('/logout', (req, res) => {
    console.log("Backend: Rota de logout chamada. Nenhuma lógica de sessão complexa aqui.");
    res.status(200).json({ success: true, message: 'Logout bem-sucedido.' });
});

// Inicia o servidor Node.js
app.listen(PORT, () => {
    console.log(`Servidor rodando na porta ${PORT}`);
    console.log(`CORS configurado para permitir requisições de: ${FRONTEND_URL}`);
    // Tenta pré-carregar o cache de membros na inicialização para agilizar as primeiras requisições
    getMembrosWithCache().catch(err => console.error("Erro ao pré-carregar cache de membros na inicialização:", err.message));
});
