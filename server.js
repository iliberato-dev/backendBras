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

// Função de fetch genérica
async function fetchFromAppsScript(queryParams = {}, method = 'GET', body = null) {
    const url = new URL(APPS_SCRIPT_URL);
    Object.keys(queryParams).forEach(key => url.searchParams.append(key, queryParams[key]));
    
    const options = {
        method: method,
        headers: { 'Content-Type': 'application/json' },
    };

    const requestBody = { ...body, auth_token: APPS_SCRIPT_AUTH_TOKEN };
    if (method !== 'GET') {
        options.body = JSON.stringify(requestBody);
    } else {
        url.searchParams.append('auth_token', APPS_SCRIPT_AUTH_TOKEN);
    }

    try {
        const response = await fetch(url.toString(), options);
        const data = await response.json();
        if (!response.ok || data.success === false) {
            throw new Error(data.message || 'Erro desconhecido do Apps Script.');
        }
        return data;
    } catch (error) {
        console.error(`Erro ao comunicar com Apps Script: ${error.message}`);
        throw new Error(`Falha na comunicação com o backend do Google: ${error.message}`);
    }
}

// Rotas existentes...
app.get('/get-membros', async (req, res) => {
    try {
        const data = await fetchFromAppsScript({ tipo: 'getMembros' });
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

// NOVO: Rota para buscar histórico de um membro
app.get('/presences/:memberName', async (req, res) => {
    try {
        const { memberName } = req.params;
        const data = await fetchFromAppsScript({ tipo: 'getPresencesByMember', nome: memberName });
        res.status(200).json(data);
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// Rota de presença agora lida com POST e DELETE (via POST com 'action')
app.post('/presenca', async (req, res) => {
    try {
        const responseData = await fetchFromAppsScript({}, 'POST', req.body);
        res.status(200).json(responseData);
    } catch (error) {
        // O Apps Script agora envia uma resposta com status 200 e success:false para erros de negócio
        // então o erro aqui é mais provável que seja de conexão ou configuração.
        res.status(500).json({ success: false, message: error.message });
    }
});


// Rotas de login e outras...
app.post("/login", async (req, res) => {
    // ... seu código de login existente ...
     res.status(401).json({ success: false, message: "Lógica de login não mostrada" });
});

app.get('/status', (req, res) => {
    res.status(200).json({ status: 'API Online' });
});


app.listen(PORT, () => {
    console.log(`Servidor rodando na porta ${PORT}`);
});
