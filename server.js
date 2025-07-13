// ------------------------------------------------------
// Backend Node.js (server.js) - VERSÃO ATUALIZADA COM OTIMIZAÇÃO DE CACHE
// ------------------------------------------------------
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

app.use(cors({ origin: FRONTEND_URL }));
app.use(bodyParser.json());

// --- LÓGICA DE CACHE ---
let cachedMembros = null;
let lastMembrosFetchTime = 0;
const MEMBERS_CACHE_TTL = 5 * 60 * 1000; // Cache de 5 minutos

// NOVO: Variáveis de cache para as últimas presenças
let cachedLastPresences = null;
let lastPresencesFetchTime = 0;
const LAST_PRESENCES_CACHE_TTL = 2 * 60 * 1000; // Cache de 2 minutos para dados que mudam mais rápido

// --- FUNÇÃO UTILITÁRIA PARA REQUISIÇÕES AO APPS SCRIPT ---
async function fetchFromAppsScript(queryParams = {}, method = 'GET', body = null) {
    if (!APPS_SCRIPT_URL || !APPS_SCRIPT_AUTH_TOKEN) {
        throw new Error('Erro de configuração do servidor: URL ou Token do Apps Script não definidos.');
    }

    const url = new URL(APPS_SCRIPT_URL);
    const requestBody = { ...body, auth_token: APPS_SCRIPT_AUTH_TOKEN };

    Object.keys(queryParams).forEach(key => url.searchParams.append(key, queryParams[key]));
    if (method === 'GET') {
        url.searchParams.append('auth_token', APPS_SCRIPT_AUTH_TOKEN);
    }
    
    const options = {
        method: method,
        headers: { 'Content-Type': 'application/json' },
        body: method !== 'GET' ? JSON.stringify(requestBody) : undefined,
    };

    try {
        const response = await fetch(url.toString(), options);
        const responseText = await response.text();
        if (!response.ok) {
             throw new Error(`Erro do Apps Script (Status ${response.status}): ${responseText}`);
        }

        const data = JSON.parse(responseText);
        if (data.success === false) {
            throw new Error(data.message || 'Erro desconhecido retornado pelo Apps Script.');
        }
        return data;
    } catch (error) {
        if (error instanceof SyntaxError) {
            throw new Error('Resposta inválida do Apps Script (não é JSON). O script pode ter travado.');
        }
        throw error;
    }
}

async function getMembrosWithCache() {
    if (cachedMembros && (Date.now() - lastMembrosFetchTime < MEMBERS_CACHE_TTL)) {
        console.log("Backend: Retornando membros do cache.");
        return { success: true, membros: cachedMembros };
    }
    console.log("Backend: Buscando membros do Apps Script.");
    const data = await fetchFromAppsScript({ tipo: 'getMembros' });
    if (data.success) {
        cachedMembros = data.membros;
        lastMembrosFetchTime = Date.now();
    }
    return data;
}

// NOVO: Função de cache para últimas presenças
async function getLastPresencesWithCache() {
    if (cachedLastPresences && (Date.now() - lastPresencesFetchTime < LAST_PRESENCES_CACHE_TTL)) {
        console.log("Backend: Retornando últimas presenças do cache.");
        return { success: true, data: cachedLastPresences };
    }
    console.log("Backend: Buscando últimas presenças do Apps Script.");
    const data = await fetchFromAppsScript({ tipo: 'getLastPresencesForAllMembers' });
    if (data.success) {
        cachedLastPresences = data.data;
        lastPresencesFetchTime = Date.now();
    }
    return data;
}

function normalizeString(str) {
    if (typeof str !== 'string') return '';
    return str.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim();
}

// --- ROTAS DA API ---

app.get('/get-membros', async (req, res) => {
    try {
        const data = await getMembrosWithCache();
        res.status(200).json(data);
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// ROTA ATUALIZADA para usar o novo cache
app.get('/get-all-last-presences', async (req, res) => {
    try {
        const data = await getLastPresencesWithCache();
        res.status(200).json(data);
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

app.get('/get-presencas-total', async (req, res) => {
    try {
        const data = await fetchFromAppsScript({ tipo: 'presencasTotal', ...req.query });
        res.status(200).json(data);
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

app.get('/presences/:memberName', async (req, res) => {
    try {
        const { memberName } = req.params;
        const data = await fetchFromAppsScript({ tipo: 'getPresencesByMember', nome: memberName, ...req.query });
        res.status(200).json(data);
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// ROTA ATUALIZADA para invalidar o cache
app.post('/presenca', async (req, res) => {
    try {
        // Invalida o cache de últimas presenças sempre que uma presença é adicionada ou removida.
        cachedLastPresences = null;
        lastPresencesFetchTime = 0;
        console.log("Backend: Cache de últimas presenças invalidado devido a uma nova ação.");

        const responseData = await fetchFromAppsScript({}, 'POST', req.body);
        res.status(200).json(responseData);
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

app.get('/status', (req, res) => res.status(200).json({ status: 'API Online' }));

app.get('/get-faltas', async (req, res) => {
    try {
        const data = await fetchFromAppsScript({ tipo: 'getFaltas', ...req.query });
        res.status(200).json(data);
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

app.post("/login", async (req, res) => {
    try {
        const { username, password } = req.body;
        
        if (ADMIN_USERNAME && ADMIN_RI && normalizeString(username) === normalizeString(ADMIN_USERNAME) && password === ADMIN_RI) {
            return res.status(200).json({ success: true, message: 'Login bem-sucedido como Administrador!', leaderName: 'admin' });
        }

        const responseData = await getMembrosWithCache();
        const membros = responseData.membros || [];
        if (membros.length === 0) return res.status(404).json({ success: false, message: 'Erro: Dados de membros não carregados.' });

        const usernameNormalized = normalizeString(username);
        const passwordDigitado = String(password || '').trim();
        
        const membroEncontrado = membros.find(m => normalizeString(m.Nome || '').includes(usernameNormalized));

        if (membroEncontrado) {
            if (String(membroEncontrado.RI || '').trim() === passwordDigitado) {
                let isLeader = false;
                const cargoMembro = normalizeString(membroEncontrado.Cargo || '');
                const statusMembro = normalizeString(membroEncontrado.Status || '');

                if (cargoMembro.includes('lider') || statusMembro.includes('lider')) {
                    isLeader = true;
                }

                if (!isLeader) {
                    const nomeDoMembroLogando = normalizeString(membroEncontrado.Nome);
                    isLeader = membros.some(outroMembro => {
                        const liderNaPlanilhaCompleto = String(outroMembro.Lider || '').trim();
                        const congregacaoOutroMembro = String(outroMembro.Congregacao || '').trim();
                        
                        let nomeLiderExtraido = liderNaPlanilhaCompleto;
                        const prefixo = congregacaoOutroMembro ? `${congregacaoOutroMembro} | ` : '';
                        if (prefixo && liderNaPlanilhaCompleto.toLowerCase().startsWith(prefixo.toLowerCase())) {
                            nomeLiderExtraido = liderNaPlanilhaCompleto.substring(prefixo.length).trim();
                        }
                        
                        const nomeLiderNormalizado = normalizeString(nomeLiderExtraido);
                        
                        return nomeDoMembroLogando.startsWith(nomeLiderNormalizado) || nomeLiderNormalizado.startsWith(nomeDoMembroLogando);
                    });
                }

                if (isLeader) {
                    return res.status(200).json({ success: true, message: `Login bem-sucedido, ${membroEncontrado.Nome}!`, leaderName: membroEncontrado.Nome });
                } else {
                    return res.status(401).json({ success: false, message: 'Usuário não possui permissão de líder.' });
                }
            } else {
                return res.status(401).json({ success: false, message: 'Senha (RI) inválida.' });
            }
        } else {
            return res.status(401).json({ success: false, message: 'Usuário não encontrado.' });
        }
    } catch (error) {
        console.error("ERRO FATAL NA ROTA DE LOGIN:", error);
        return res.status(500).json({ success: false, message: `Erro interno do servidor: ${error.message}` });
    }
});

app.listen(PORT, () => {
    console.log(`Servidor rodando na porta ${PORT}`);
    getMembrosWithCache().catch(err => console.error("Erro ao pré-carregar cache de membros:", err.message));
});
