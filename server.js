require('dotenv').config();

const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const fetch = require('node-fetch');

const app = express();
const PORT = process.env.PORT || 3000;

// --- CONFIGURAÇÃO DE URLs E CORS ---
const APPS_SCRIPT_URL = process.env.APPS_SCRIPT_URL;
const FRONTEND_URL = process.env.FRONTEND_URL;
const APPS_SCRIPT_AUTH_TOKEN = process.env.APPS_SCRIPT_AUTH_TOKEN;

const ADMIN_USERNAME = process.env.ADMIN_USERNAME;
const ADMIN_RI = process.env.ADMIN_RI;

app.use(cors({
    origin: FRONTEND_URL,
    methods: ['GET', 'POST', 'PUT', 'DELETE'],
    allowedHeaders: ['Content-Type', 'Authorization'],
}));

app.use(bodyParser.json());

// --- CACHE DE MEMBROS ---
let cachedMembros = null;
let lastMembrosFetchTime = 0;
const MEMBERS_CACHE_TTL = 5 * 60 * 1000;

// --- FUNÇÃO UTILITÁRIA PARA REQUISIÇÕES AO APPS SCRIPT ---
async function fetchFromAppsScript(actionType, method = 'GET', body = null, queryParams = {}) {
    if (!APPS_SCRIPT_URL) {
        console.error('Backend: Erro de configuração: Variável de ambiente APPS_SCRIPT_URL não definida.');
        throw new Error('Erro de configuração do servidor: URL do Apps Script não definida.');
    }
    if (!APPS_SCRIPT_AUTH_TOKEN) {
        console.error('Backend: Erro de configuração: Variável de ambiente APPS_SCRIPT_AUTH_TOKEN não definida.');
        throw new Error('Erro de configuração do servidor: Token de autenticação do Apps Script não definida.');
    }

    let url = APPS_SCRIPT_URL;
    const urlParams = new URLSearchParams();
    const options = {
        method: method,
        headers: { 'Content-Type': 'application/json' },
    };

    if (method === 'GET') {
        urlParams.append('tipo', actionType);
        urlParams.append('auth_token', APPS_SCRIPT_AUTH_TOKEN);
        
        for (const key in queryParams) {
            if (queryParams.hasOwnProperty(key) && queryParams[key]) {
                urlParams.append(key, queryParams[key]);
            }
        }
        url = `${APPS_SCRIPT_URL}?${urlParams.toString()}`;
    } else if (method === 'POST') {
        const postBody = { ...body, auth_token: APPS_SCRIPT_AUTH_TOKEN };
        options.body = JSON.stringify(postBody);
    } else {
        throw new Error(`Método HTTP não suportado: ${method}`);
    }
    
    console.log(`Backend: Encaminhando ${method} para Apps Script: ${url}`);
    
    const response = await fetch(url, options);
    const responseText = await response.text();

    let responseData;
    try {
        responseData = JSON.parse(responseText);
    } catch (e) {
        console.error(`Backend: Erro ao parsear JSON do Apps Script: ${e.message}. Resposta bruta (primeiros 500 chars): ${responseText.substring(0, 500)}...`);
        throw new Error(`Resposta inválida do Apps Script: ${responseText.substring(0, 100)}...`);
    }

    if (!response.ok || responseData.success === false) {
        console.error(`Backend: Erro lógico/HTTP do Apps Script (${actionType} ${method}): Status ${response.status} - Resposta: ${JSON.stringify(responseData)}`);
        const errorMessage = responseData.message || 'Erro desconhecido do Apps Script.';
        const error = new Error(errorMessage);
        if (responseData.alreadyExists) {
            error.alreadyExists = true;
            error.lastPresence = responseData.lastPresence;
        }
        throw error;
    }
    
    console.log(`Backend: Resposta bem-sucedida do Apps Script (${actionType} ${method}): ${JSON.stringify(responseData)}`);
    return responseData;
}

async function getMembrosWithCache() {
    if (cachedMembros && (Date.now() - lastMembrosFetchTime < MEMBERS_CACHE_TTL)) {
        console.log("Backend: Retornando membros do cache.");
        return { success: true, membros: cachedMembros };
    }

    console.log("Backend: Buscando membros do Apps Script (cache expirado ou vazio).");
    const data = await fetchFromAppsScript('getMembros');
    
    if (data.success) {
        cachedMembros = data.membros;
        lastMembrosFetchTime = Date.now();
        console.log(`Backend: Membros cacheados. Total: ${cachedMembros.length}`);
    } else {
        console.warn("Backend: Falha ao buscar membros do Apps Script para cache:", data.message);
    }
    return data;
}

function normalizeString(str) {
    if (typeof str !== 'string') {
        return '';
    }
    return str.toLowerCase()
              .normalize("NFD")
              .replace(/[\u0300-\u036f]/g, "")
              .replace(/[^a-z0-9\s]/g, '')
              .trim();
}

// Rotas da API
app.get('/get-membros', async (req, res) => {
    try {
        const data = await getMembrosWithCache();
        
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

        res.status(200).json({ success: true, membros: filteredMembros });
    } catch (error) {
        console.error('Erro no backend ao obter membros (via cache ou Apps Script):', error.message);
        res.status(500).json({ success: false, message: 'Erro ao obter dados de membros.', details: error.message });
    }
});

app.post('/presenca', async (req, res) => {
    const { memberId, memberName, leaderName, gapeName, periodo, presenceDate } = req.body;

    if (!memberId || !memberName || !leaderName || !gapeName || !periodo || !presenceDate) {
        return res.status(400).json({ success: false, message: 'Dados incompletos para registrar presença.' });
    }

    try {
        const responseData = await fetchFromAppsScript(
            'registerMemberPresence',
            'POST', 
            { memberId, memberName, leaderName, gapeName, periodo, presenceDate }
        );
        
        res.status(200).json(responseData);
    } catch (error) {
        console.error('Erro no backend ao registrar presença:', error.message);

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

app.get('/get-presencas-total', async (req, res) => {
    try {
        const data = await fetchFromAppsScript('getMonthlySummary', 'GET', null, req.query);
        res.status(200).json(data); 
    } catch (error) {
        console.error('Erro no backend ao obter presenças totais:', error.message);
        res.status(500).json({ success: false, message: 'Erro ao obter presenças totais.', details: error.message });
    }
});

app.get('/get-all-last-presences', async (req, res) => {
    try {
        const data = await fetchFromAppsScript('getLastPresencesForAllMembers');
        res.status(200).json(data); 
    } catch (error) {
        console.error('Erro no backend ao obter todas as últimas presenças:', error.message);
        res.status(500).json({ success: false, message: 'Erro ao obter últimas presenças de todos os membros.', details: error.message });
    }
});

app.post("/login", async (req, res) => {
    const { username, password } = req.body;
    console.log(`Backend: Tentativa de login para usuário: "${username}"`);

    if (ADMIN_USERNAME && ADMIN_RI && 
        normalizeString(username) === normalizeString(ADMIN_USERNAME) && 
        password === ADMIN_RI) {
        console.log(`Backend: Login bem-sucedido para usuário master: ${username}`);
        return res.status(200).json({ success: true, message: 'Login bem-sucedido como Administrador!', leaderName: username, role: 'admin' });
    }

    try {
        const responseData = await getMembrosWithCache();
        const membros = responseData.membros || [];
        
        if (!membros || !Array.isArray(membros) || membros.length === 0) {
            console.warn("Backend: Nenhuma lista de membros válida retornada ou a lista está vazia para autenticação.");
            return res.status(404).json({ success: false, message: 'Erro: Não foi possível carregar os dados de membros ou a lista está vazia para autenticação.' });
        }

        const usernameDigitadoNormalized = normalizeString(username);
        const passwordDigitado = String(password || '').trim();

        let membroEncontradoPeloNome = null;

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
            
            if (String(membroEncontradoPeloNome.RI || '').trim() === passwordDigitado) {
                console.log(`Backend Login: Senha (RI) correta para ${membroEncontradoPeloNome.Nome}.`);
                
                const cargoMembroNormalized = normalizeString(membroEncontradoPeloNome.Cargo || '');
                const statusMembroNormalized = normalizeString(membroEncontradoPeloNome.Status || '');
                
                let isLeaderByRole = false;

                if (cargoMembroNormalized.includes('lider') || statusMembroNormalized.includes('lider')) {
                    isLeaderByRole = true;
                    console.log(`Backend Login: Membro '${membroEncontradoPeloNome.Nome}' é líder por Cargo/Status.`);
                }

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

app.get('/status', (req, res) => {
    res.status(200).json({ status: 'API está online e funcionando!', timestamp: new Date().toISOString() });
});

app.get('/get-faltas', async (req, res) => {
    try {
        const data = await fetchFromAppsScript('getDetailedSummary', 'GET', null, req.query);
        res.status(200).json(data); 
    } catch (error) {
        console.error('Erro no backend ao obter faltas/resumo detalhado:', error.message);
        res.status(500).json({ success: false, message: 'Erro ao obter resumo detalhado.', details: error.message });
    }
});

app.post('/logout', (req, res) => {
    console.log("Backend: Rota de logout chamada. Nenhuma lógica de sessão complexa aqui.");
    res.status(200).json({ success: true, message: 'Logout bem-sucedido.' });
});

app.listen(PORT, () => {
    console.log(`Servidor rodando na porta ${PORT}`);
    console.log(`CORS configurado para permitir requisições de: ${FRONTEND_URL}`);
    getMembrosWithCache().catch(err => console.error("Erro ao pré-carregar cache de membros na inicialização:", err.message));
});
