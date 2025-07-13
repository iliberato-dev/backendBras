// ------------------------------------------------------
// Backend Node.js (server.js) - Versão com LOG DE ERRO DETALHADO
// ------------------------------------------------------
require('dotenv').config();

const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const fetch = require('node-fetch');

const app = express();
const PORT = process.env.PORT || 3000;

const APPS_SCRIPT_URL = process.env.APPS_SCRIPT_URL;
const FRONTEND_URL = process.env.FRONTEND_URL;
const APPS_SCRIPT_AUTH_TOKEN = process.env.APPS_SCRIPT_AUTH_TOKEN;
const ADMIN_USERNAME = process.env.ADMIN_USERNAME;
const ADMIN_RI = process.env.ADMIN_RI;

app.use(cors({ origin: FRONTEND_URL }));
app.use(bodyParser.json());

let cachedMembros = null;
let lastMembrosFetchTime = 0;
const MEMBERS_CACHE_TTL = 5 * 60 * 1000;

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
        console.error(`Erro ao comunicar com Apps Script: ${error.message}`);
        if (error.name === 'FetchError' || error.message.includes('invalid json')) {
             throw new Error('Resposta inválida do Apps Script. O script pode ter travado.');
        }
        throw error;
    }
}

async function getMembrosWithCache() {
    if (cachedMembros && (Date.now() - lastMembrosFetchTime < MEMBERS_CACHE_TTL)) {
        return { success: true, membros: cachedMembros };
    }
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
// ... (outras rotas GET e POST aqui, elas não mudam)

// ROTA DE LOGIN COM A LÓGICA DE LOG DE ERRO MELHORADA
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
        // --- MUDANÇA IMPORTANTE AQUI ---
        // Agora vamos registrar o erro completo para depuração.
        console.error("==============================================");
        console.error("ERRO FATAL NA ROTA DE LOGIN:", error); // Loga o objeto de erro completo (com stack trace)
        console.error("==============================================");
        return res.status(500).json({ success: false, message: 'Erro interno do servidor ao autenticar.' });
    }
});


app.listen(PORT, () => {
    console.log(`Servidor rodando na porta ${PORT}`);
    getMembrosWithCache().catch(err => console.error("Erro ao pré-carregar cache de membros:", err.message));
});
