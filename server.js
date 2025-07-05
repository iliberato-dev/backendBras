// ------------------------------------------------------
// Backend Node.js (server.js)
// ------------------------------------------------------
// Carrega as variáveis de ambiente do arquivo .env (para desenvolvimento local)
// No Render, essas variáveis são injetadas diretamente no ambiente
require('dotenv').config();

const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const fetch = require('node-fetch'); // Certifique-se de que 'node-fetch' está instalado (npm install node-fetch)

const app = express();
const PORT = process.env.PORT || 3000;

// --- CONFIGURAÇÃO DE URLs E CORS ---
// A URL base do seu Google Apps Script Web App.
// É ESSENCIAL que esta URL venha de uma variável de ambiente no Render (ex: APPS_SCRIPT_URL).
// Ex: https://script.google.com/macros/s/AKfycbyTmDpB4RGxJ6whSuoydK-PiQ0jOjzvHHXPeVO9Us8587Ldg5NmyZLhykQTLenbGjnA/exec
const APPS_SCRIPT_URL = process.env.APPS_SCRIPT_URL;

// A URL do seu frontend hospedado no Vercel.
// ESSENCIAL para a segurança do CORS. Deve vir de uma variável de ambiente no Render.
// Ex: https://seu-frontend.vercel.app
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
// 'path' é o nome da rota esperada pelo Apps Script (ex: 'get-membros', 'get-presencas-total')
// 'method' é o método HTTP (GET, POST)
// 'body' é o corpo da requisição para POST
// 'queryParams' são os parâmetros de consulta para GET (ex: { periodo: 'Manhã' })
async function fetchFromAppsScript(path, method = 'GET', body = null, queryParams = {}) {
    if (!APPS_SCRIPT_URL) {
        console.error('Erro de configuração: Variável de ambiente APPS_SCRIPT_URL não definida.');
        throw new Error('Erro de configuração do servidor: URL do Apps Script não definida.');
    }

    let url = APPS_SCRIPT_URL;

    // CORREÇÃO AQUI: Para requisições GET, anexamos o 'path' diretamente à URL base.
    // Para POSTs (como o `doPost` que não usa pathInfo), a URL base é suficiente.
    if (method === 'GET' && path) {
        url = `${APPS_SCRIPT_URL}/${path}`;
    }
    // Se for POST e tiver um path (embora seu doPost não use pathInfo), você pode ajustar se necessário.
    // Atualmente, seu doPost no Apps Script não lê e.pathInfo, só e.postData.contents.
    // Então, para doPost, a URL base é correta.

    // Adiciona parâmetros de consulta, se houver
    const params = new URLSearchParams(queryParams).toString();
    if (params) {
        url += `?${params}`;
    }
    
    console.log(`Backend: Encaminhando ${method} para Apps Script: ${url}`); // Log da URL completa
    
    const options = {
        method: method,
        headers: { 'Content-Type': 'application/json' },
    };
    if (body) {
        options.body = JSON.stringify(body);
    }

    const response = await fetch(url, options);
    const responseText = await response.text();

    let responseData;
    try {
        responseData = JSON.parse(responseText);
    } catch (e) {
        console.error(`Backend: Erro ao parsear JSON do Apps Script: ${e.message}. Resposta bruta: ${responseText}`);
        responseData = { success: false, message: `Resposta inválida do Apps Script: ${responseText.substring(0, 100)}...`, details: e.message };
    }

    if (!response.ok || responseData.success === false) {
        console.error(`Backend: Erro lógico/HTTP do Apps Script (${path || 'doPost'} ${method}): Status ${response.status} - Resposta: ${JSON.stringify(responseData)}`);
        throw new Error(responseData.message || 'Erro desconhecido do Apps Script.');
    }
    
    console.log(`Backend: Resposta bem-sucedida do Apps Script (${path || 'doPost'} ${method}): ${JSON.stringify(responseData)}`);
    return responseData;
}

// --- ROTAS DA API ---

// Rota para obter a lista de membros
app.get('/get-membros', async (req, res) => {
    try {
        // Alinhado com o 'case 'get-membros':' no Apps Script doGet
        const data = await fetchFromAppsScript('get-membros'); // CORREÇÃO: Passa o path como primeiro argumento
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
        // Para POST, 'doPost' é o path lógico, mas a URL não usa pathInfo no Apps Script
        const responseData = await fetchFromAppsScript('doPost', 'POST', { nome, data, hora, sheet });
        
        res.status(200).json(responseData);
    } catch (error) {
        console.error('Erro no backend ao registrar presença:', error);

        if (error.message && error.message.includes("já foi registrada")) {
            return res.status(200).json({
                success: false,
                message: error.message,
                lastPresence: { data: data, hora: hora } // Placeholder
            });
        }
        
        res.status(500).json({ success: false, message: 'Erro ao registrar presença.', details: error.message });
    }
});

// Rota para obter as presenças totais (do Apps Script)
app.get('/get-presencas-total', async (req, res) => {
    try {
        // req.query contém os filtros (periodo, lider, gape)
        // Alinhado com o 'case 'get-presencas-total':' no Apps Script doGet
        const data = await fetchFromAppsScript('get-presencas-total', 'GET', null, req.query); // CORREÇÃO: Passa o path e queryParams
        res.status(200).json(data.data || {}); // Apps Script retorna { success: true, data: {...} }
    } catch (error) {
        console.error('Erro no backend ao obter presenças totais:', error);
        res.status(500).json({ success: false, message: 'Erro ao obter presenças totais.', details: error.message });
    }
});

// --- NOVA ROTA: Obter a última presença para TODOS os membros ---
app.get('/get-all-last-presences', async (req, res) => {
    try {
        // Alinhado com o 'case 'get-all-last-presences':' no Apps Script doGet
        const data = await fetchFromAppsScript('get-all-last-presences'); // CORREÇÃO: Passa o path
        res.status(200).json(data.data || {}); // Apps Script retorna { success: true, data: {...} }
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
        // Alinhado com o 'case 'get-membros':' no Apps Script doGet
        const responseData = await fetchFromAppsScript('get-membros'); // CORREÇÃO: Passa o path
        const membros = responseData.membros || [];

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
