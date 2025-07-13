// ------------------------------------------------------
// Backend Node.js (server.js) - Versão com Rota /get-presencas-total CORRIGIDA
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

// --- CACHE DE MEMBROS ---
let cachedMembros = null;
let lastMembrosFetchTime = 0;
const MEMBERS_CACHE_TTL = 5 * 60 * 1000; // Cache de 5 minutos

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
    };

    if (method !== 'GET') {
        options.body = JSON.stringify(requestBody);
    }

    try {
        const response = await fetch(url.toString(), options);
        // Lida com respostas que não são JSON (como páginas de erro do Google)
        const responseText = await response.text();
        if (!response.ok) {
            // Se o status não for OK, lança o erro com o texto da resposta
             throw new Error(`Erro do Apps Script (Status ${response.status}): ${responseText}`);
        }

        const data = JSON.parse(responseText);
        if (data.success === false) {
            throw new Error(data.message || 'Erro desconhecido retornado pelo Apps Script.');
        }
        return data;
    } catch (error) {
        console.error(`Erro ao comunicar com Apps Script: ${error.message}`);
        if (error.name === 'FetchError' || error.message.includes('invalid json')) {
             throw new Error('Resposta inválida do Apps Script. O script pode ter travado.');
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

app.get('/get-all-last-presences', async (req, res) => {
    try {
        const data = await fetchFromAppsScript({ tipo: 'getLastPresencesForAllMembers' });
        res.status(200).json(data);
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// ROTA RESTAURADA
app.get('/get-presencas-total', async (req, res) => {
    try {
        // Encaminha os parâmetros de query (periodo, lider, gape) para o Apps Script
        const data = await fetchFromAppsScript({ tipo: 'presencasTotal', ...req.query });
        res.status(200).json(data);
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

app.get('/presences/:memberName', async (req, res) => {
    try {
        const { memberName } = req.params;
        const data = await fetchFromAppsScript({ tipo: 'getPresencesByMember', nome: memberName });
        res.status(200).json(data);
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

app.post('/presenca', async (req, res) => {
    try {
        const responseData = await fetchFromAppsScript({}, 'POST', req.body);
        res.status(200).json(responseData);
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

app.post("/login", async (req, res) => {
    const { username, password } = req.body;
    console.log(`Backend: Tentativa de login para usuário: "${username}"`);

    if (ADMIN_USERNAME && ADMIN_RI && normalizeString(username) === normalizeString(ADMIN_USERNAME) && password === ADMIN_RI) {
        return res.status(200).json({ success: true, message: 'Login bem-sucedido como Administrador!', leaderName: 'admin' });
    }

    try {
        const responseData = await getMembrosWithCache();
        const membros = responseData.membros || [];
        if (membros.length === 0) return res.status(404).json({ success: false, message: 'Erro: Não foi possível carregar dados de membros.' });

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
                } else {
                    const nomeDoMembroLogando = normalizeString(membroEncontrado.Nome);
                    isLeader = membros.some(outroMembro => normalizeString(outroMembro.Lider || '').includes(nomeDoMembroLogando));
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
        console.error("Backend: Erro fatal ao autenticar:", error.message);
        return res.status(500).json({ success: false, message: 'Erro interno do servidor ao autenticar.' });
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

app.listen(PORT, () => {
    console.log(`Servidor rodando na porta ${PORT}`);
    console.log(`CORS configurado para: ${FRONTEND_URL}`);
    getMembrosWithCache().catch(err => console.error("Erro ao pré-carregar cache de membros:", err.message));
});
