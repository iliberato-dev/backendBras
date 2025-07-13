// ------------------------------------------------------
// Backend Node.js (server.js) - Versão com Login COMPLETO e CORRETO
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
        const data = await response.json();
        if (!response.ok || data.success === false) {
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

// ROTA DE LOGIN COM LÓGICA COMPLETA RESTAURADA
app.post("/login", async (req, res) => {
    const { username, password } = req.body;
    console.log(`Backend: Tentativa de login para usuário: "${username}"`);

    // 1. Autenticação do Administrador Master
    if (ADMIN_USERNAME && ADMIN_RI && 
        normalizeString(username) === normalizeString(ADMIN_USERNAME) && 
        password === ADMIN_RI) {
        console.log(`Backend: Login bem-sucedido para usuário master: ${username}`);
        return res.status(200).json({ success: true, message: 'Login bem-sucedido como Administrador!', leaderName: 'admin' });
    }

    // 2. Autenticação de Líder
    try {
        const responseData = await getMembrosWithCache();
        const membros = responseData.membros || [];
        
        if (membros.length === 0) {
            return res.status(404).json({ success: false, message: 'Erro: Não foi possível carregar os dados de membros.' });
        }

        const usernameNormalized = normalizeString(username);
        const passwordDigitado = String(password || '').trim();

        const membroEncontrado = membros.find(membro => 
            normalizeString(membro.Nome || '').includes(usernameNormalized)
        );

        if (membroEncontrado) {
            console.log(`Backend Login: Membro encontrado: ${membroEncontrado.Nome}`);

            // Verifica a senha (RI)
            if (String(membroEncontrado.RI || '').trim() === passwordDigitado) {
                
                // --- INÍCIO DA VERIFICAÇÃO DE LIDERANÇA FLEXÍVEL ---
                let isLeader = false;
                const cargoMembro = normalizeString(membroEncontrado.Cargo || '');
                const statusMembro = normalizeString(membroEncontrado.Status || '');

                // Verificação 1: Pelo cargo ou status do próprio membro
                if (cargoMembro.includes('lider') || statusMembro.includes('lider')) {
                    isLeader = true;
                    console.log(`Backend: ${membroEncontrado.Nome} é líder por cargo/status.`);
                }

                // Verificação 2: Se não for líder pelo cargo, verifica se é líder de algum grupo
                if (!isLeader) {
                    const nomeDoMembroLogando = normalizeString(membroEncontrado.Nome);
                    isLeader = membros.some(outroMembro => {
                        const liderDoOutroMembro = normalizeString(outroMembro.Lider || '');
                        // Verifica se o nome da pessoa que está logando aparece na coluna de líder de alguém
                        return liderDoOutroMembro.includes(nomeDoMembroLogando);
                    });
                    if(isLeader) console.log(`Backend: ${membroEncontrado.Nome} é líder por estar na coluna 'Grupo Líder' de outro membro.`);
                }
                // --- FIM DA VERIFICAÇÃO DE LIDERANÇA FLEXÍVEL ---

                if (isLeader) {
                    console.log(`Backend: Login bem-sucedido para o líder: ${membroEncontrado.Nome}`);
                    return res.status(200).json({ success: true, message: `Login bem-sucedido, ${membroEncontrado.Nome}!`, leaderName: membroEncontrado.Nome });
                } else {
                    console.log(`Backend: Usuário '${username}' encontrado, mas não possui permissão de líder.`);
                    return res.status(401).json({ success: false, message: 'Usuário não possui permissão de líder.' });
                }

            } else {
                console.log(`Backend: Senha (RI) inválida para o usuário: ${username}`);
                return res.status(401).json({ success: false, message: 'Senha (RI) inválida.' });
            }
        } else {
            console.log(`Backend: Usuário '${username}' não encontrado.`);
            return res.status(401).json({ success: false, message: 'Usuário não encontrado.' });
        }

    } catch (error) {
        console.error("Backend: Erro fatal ao autenticar:", error.message);
        return res.status(500).json({ success: false, message: 'Erro interno do servidor ao autenticar.' });
    }
});

app.get('/status', (req, res) => {
    res.status(200).json({ status: 'API Online' });
});

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
