// ------------------------------------------------------
// Backend Node.js (server.js)
// ------------------------------------------------------
// Carrega as variáveis de ambiente do arquivo .env (para desenvolvimento local)
// No Render, essas variáveis são injetadas diretamente no ambiente
require('dotenv').config();

const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const fetch = require('node-fetch'); 

const app = express();
const PORT = process.env.PORT || 3000;

// --- CONFIGURAÇÃO DE URLs E CORS ---
// A URL base do seu Google Apps Script Web App.
// É ESSENCIAL que esta URL venha de uma variável de ambiente no Render (ex: APPS_SCRIPT_URL).
const APPS_SCRIPT_URL = process.env.APPS_SCRIPT_URL;

// A URL do seu frontend hospedado no Vercel.
// ESSENCIAL para a segurança do CORS. Deve vir de uma variável de ambiente no Render.
const FRONTEND_URL = process.env.FRONTEND_URL;

// Configuração do CORS: Permite requisições APENAS da URL do seu frontend (Vercel) e de origens locais.
app.use(cors({
    origin: FRONTEND_URL, 
    methods: ['GET', 'POST', 'PUT', 'DELETE'], 
    allowedHeaders: ['Content-Type', 'Authorization'], 
}));

// Middleware para parsear o corpo das requisições JSON
app.use(bodyParser.json());

// --- FUNÇÃO UTILITÁRIA PARA REQUISIÇÕES AO APPS SCRIPT ---
// Centraliza a lógica de chamada ao Apps Script e tratamento de erros
async function fetchFromAppsScript(actionType, method = 'GET', body = null) {
    if (!APPS_SCRIPT_URL) {
        throw new Error('Erro de configuração do servidor: URL do Apps Script não definida na variável de ambiente APPS_SCRIPT_URL.');
    }

    const url = `${APPS_SCRIPT_URL}?tipo=${actionType}`;
    
    const options = {
        method: method,
        headers: { 'Content-Type': 'application/json' },
    };
    if (body) {
        options.body = JSON.stringify(body);
    }

    console.log(`Backend: Encaminhando ${method} para Apps Script: ${url}`);
    
    const response = await fetch(url, options);
    const responseText = await response.text(); 

    let responseData;
    try {
        responseData = JSON.parse(responseText);
    } catch (e) {
        responseData = { message: responseText };
    }

    if (!response.ok || (responseData.error && responseData.message?.startsWith('Erro:'))) {
        console.error(`Erro do Apps Script (${actionType} ${method}): ${response.status} - ${JSON.stringify(responseData)}`);
        throw new Error(`Erro Apps Script: ${responseData.message || responseData.error || responseText}`);
    }
    return responseData;
}

// --- ROTAS DA API ---

// Rota para obter a lista de membros
app.get('/get-membros', async (req, res) => {
    try {
        const data = await fetchFromAppsScript('getMembros'); 
        res.status(200).json(data);
    } catch (error) {
        console.error('Erro no backend ao obter membros:', error);
        res.status(500).json({ success: false, message: 'Erro ao obter dados de membros.', details: error.message });
    }
});

// Rota para registrar a presença
app.post('/presenca', async (req, res) => {
    const { nome, data, hora, sheet } = req.body;
    if (!nome || !data || !hora || !sheet) { 
        return res.status(400).json({ success: false, message: 'Dados incompletos para registrar presença.' });
    }
    try {
        const responseData = await fetchFromAppsScript('doPost', 'POST', { nome, data, hora, sheet }); // O Apps Script doPost espera a action diretamente
        res.status(200).json(responseData); 
    } catch (error) {
        console.error('Erro no backend ao registrar presença:', error);
        res.status(500).json({ success: false, message: 'Erro ao registrar presença.', details: error.message });
    }
});

// Rota para obter as presenças totais (do Apps Script)
app.get('/get-presencas-total', async (req, res) => {
    try {
        const data = await fetchFromAppsScript('presencasTotal'); 
        res.status(200).json(data);
    } catch (error) {
        console.error('Erro no backend ao obter presenças totais:', error);
        res.status(500).json({ success: false, message: 'Erro ao obter presenças totais.', details: error.message });
    }
});

// --- NOVA ROTA: Obter a última presença para TODOS os membros ---
app.get('/get-all-last-presences', async (req, res) => {
    try {
        const data = await fetchFromAppsScript('getAllLastPresences'); // Chama a nova função do Apps Script
        res.status(200).json(data); 
    } catch (error) {
        console.error('Erro no backend ao obter todas as últimas presenças:', error);
        res.status(500).json({ success: false, message: 'Erro ao obter últimas presenças de todos os membros.', details: error.message });
    }
});

// Rota de Autenticação (LOGIN)
app.post("/login", async (req, res) => {
    const { username, password } = req.body;
    console.log(`Backend: Tentativa de login para usuário: "${username}" com senha: "${password}"`);

    const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
    const ADMIN_RI = process.env.ADMIN_RI || 'admin'; 

    if (username.toLowerCase() === ADMIN_USERNAME.toLowerCase() && password === ADMIN_RI) {
        console.log(`Backend: Login bem-sucedido para usuário master: ${username}`);
        return res.status(200).json({ success: true, message: 'Login bem-sucedido como Administrador!' });
    }

    try {
        const responseData = await fetchFromAppsScript('getMembros'); 
        const membros = responseData.membros || responseData.data; 

        if (!membros || !Array.isArray(membros) || membros.length === 0) {
            console.warn("Backend: Nenhuma lista de membros válida retornada do Apps Script ou a lista está vazia.");
            return res.status(404).json({ success: false, message: 'Erro: Não foi possível carregar os dados de membros ou a lista está vazia para autenticação.' });
        }

        const liderEncontrado = membros.find(membro => {
            const liderNaPlanilha = String(membro.Lider || '').toLowerCase().trim(); 
            const usernameDigitado = String(username || '').toLowerCase().trim();
            return liderNaPlanilha === usernameDigitado;
        });

        if (liderEncontrado) {
            if (String(liderEncontrado.RI).trim() === String(password).trim()) { 
                console.log(`Backend: Login bem-sucedido para o líder: ${liderEncontrado.Lider}`);
                return res.status(200).json({ success: true, message: `Login bem-sucedido, ${liderEncontrado.Lider}!` });
            } else {
                console.log(`Backend: Senha inválida para o líder: ${username}`);
                return res.status(401).json({ success: false, message: 'Senha inválida para o líder fornecido.' });
            }
        } else {
            console.log(`Backend: Usuário (Líder) não encontrado na lista: ${username}`);
            return res.status(401).json({ success: false, message: 'Usuário (Líder) não encontrado ou credenciais inválidas.' });
        }

    } catch (error) {
        console.error("Backend: Erro FATAL ao tentar autenticar líder com Apps Script:", error);
        return res.status(500).json({ success: false, message: 'Erro interno do servidor ao autenticar.', details: error.message });
    }
});

// Rota simples para verificar se a API está no ar
app.get('/status', (req, res) => {
    res.status(200).json({ status: 'API está online e funcionando!', timestamp: new Date().toISOString() });
});

// Inicia o servidor
app.listen(PORT, () => {
    console.log(`Servidor rodando na porta ${PORT}`);
    console.log(`CORS configurado para permitir requisições de: ${FRONTEND_URL}`);
});
