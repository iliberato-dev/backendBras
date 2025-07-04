// Carrega as variáveis de ambiente do arquivo .env (para desenvolvimento local)
// No Render, essas variáveis são injetadas diretamente no ambiente
require('dotenv').config();

const express = require('express');
const bodyParser = require('body-parser'); // Correção aqui: deve ser 'body-parser'
const cors = require('cors');
const fetch = require('node-fetch'); // Importar node-fetch para ambientes CommonJS

const app = express();
const PORT = process.env.PORT || 3000;

// --- CONFIGURAÇÃO DE URLs E CORS ---
// A URL base do seu Google Apps Script Web App.
// É ESSENCIAL que esta URL venha de uma variável de ambiente no Render (ex: APPS_SCRIPT_URL).
const APPS_SCRIPT_URL = process.env.APPS_SCRIPT_URL;

// A URL do seu frontend hospedado no Vercel.
// ESSENCIAL para a segurança do CORS. Deve vir de uma variável de ambiente no Render.
// Em desenvolvimento local, você pode adicionar 'http://localhost:PORTA_DO_SEU_LIVE_SERVER'.
const FRONTEND_URL = process.env.FRONTEND_URL;

// Configuração do CORS: Permite requisições APENAS da URL do seu frontend (Vercel) e de origens locais.
app.use(cors({
    origin: FRONTEND_URL, // Permite requisições APENAS do seu frontend Vercel
    methods: ['GET', 'POST', 'PUT', 'DELETE'], // Métodos HTTP permitidos
    allowedHeaders: ['Content-Type', 'Authorization'], // Cabeçalhos permitidos
}));

// Middleware para parsear o corpo das requisições JSON
app.use(bodyParser.json());

// --- FUNÇÃO UTILITÁRIA PARA REQUISIÇÕES AO APPS SCRIPT ---
// Centraliza a lógica de chamada ao Apps Script e tratamento de erros
async function fetchFromAppsScript(actionType, method = 'GET', body = null) {
    if (!APPS_SCRIPT_URL) {
        throw new Error('Erro de configuração do servidor: URL do Apps Script não definida na variável de ambiente APPS_SCRIPT_URL.');
    }

    // Usamos 'tipo' no Apps Script, conforme seu código. Se mudar para 'action', ajuste aqui.
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
    const responseText = await response.text(); // Sempre leia o texto primeiro

    let responseData;
    try {
        responseData = JSON.parse(responseText);
    } catch (e) {
        // Se não for JSON, trata como uma mensagem de texto simples (ex: "OK" ou erro formatado pelo Apps Script)
        responseData = { message: responseText };
    }

    // Verifica se a resposta HTTP não foi OK ou se o Apps Script retornou um erro específico no JSON
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
        const data = await fetchFromAppsScript('getMembros'); // Chama a função utilitária
        res.status(200).json(data);
    } catch (error) {
        console.error('Erro no backend ao obter membros:', error);
        res.status(500).json({ success: false, message: 'Erro ao obter dados de membros.', details: error.message });
    }
});

// Rota para registrar a presença
app.post('/presenca', async (req, res) => {
    const { nome, data, hora, sheet } = req.body;
    if (!nome || !data || !hora || !sheet) { // 'sheet' pode ser o nome da aba PRESENCAS se precisar
        return res.status(400).json({ success: false, message: 'Dados incompletos para registrar presença.' });
    }
    try {
        // O Apps Script doPost não usa 'tipo', mas espera o corpo JSON diretamente para registrar a presença
        const responseData = await fetchFromAppsScript('registrarPresenca', 'POST', { nome, data, hora, sheet });
        res.status(200).json(responseData);
    } catch (error) {
        console.error('Erro no backend ao registrar presença:', error);
        res.status(500).json({ success: false, message: 'Erro ao registrar presença.', details: error.message });
    }
});

// Rota para obter as presenças totais (do Apps Script)
app.get('/get-presencas-total', async (req, res) => {
    try {
        const data = await fetchFromAppsScript('presencasTotal'); // Nome da função no Apps Script
        res.status(200).json(data);
    } catch (error) {
        console.error('Erro no backend ao obter presenças totais:', error);
        res.status(500).json({ success: false, message: 'Erro ao obter presenças totais.', details: error.message });
    }
});

// Rota de Autenticação (LOGIN)
app.post("/login", async (req, res) => {
    const { username, password } = req.body;
    console.log(`Backend: Tentativa de login para usuário: "${username}" com senha: "${password}"`);

    // --- 1. Tentar Login como Usuário Master (admin) ---
    // Defina ADMIN_USERNAME e ADMIN_RI como variáveis de ambiente no Render por segurança!
    const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
    const ADMIN_RI = process.env.ADMIN_RI || 'admin'; // CUIDADO: Mude 'admin' para o RI real do admin!

    if (username.toLowerCase() === ADMIN_USERNAME.toLowerCase() && password === ADMIN_RI) {
        console.log(`Backend: Login bem-sucedido para usuário master: ${username}`);
        return res.status(200).json({ success: true, message: 'Login bem-sucedido como Administrador!' });
    }

    // --- 2. Tentar Login como Líder da Planilha ---
    try {
        const responseData = await fetchFromAppsScript('getMembros'); // Chama a função utilitária
        const membros = responseData.membros || responseData.data; // Apps Script deve retornar { membros: [...] }

        if (!membros || !Array.isArray(membros) || membros.length === 0) {
            console.warn("Backend: Nenhuma lista de membros válida retornada do Apps Script ou a lista está vazia.");
            return res.status(404).json({ success: false, message: 'Erro: Não foi possível carregar os dados de membros ou a lista está vazia para autenticação.' });
        }

        // --- Logs para Depuração (descomente se precisar) ---
        // console.log("Backend: Membros recebidos do Apps Script (primeiro):", membros[0]);
        // console.log("Backend: Membros recebidos do Apps Script (último):", membros[membros.length - 1]);
        // console.log("Backend: Tipo de 'membros':", typeof membros, "É array?", Array.isArray(membros));
        // console.log("Backend: Total de membros:", membros.length);

        const liderEncontrado = membros.find(membro => {
            const liderNaPlanilha = String(membro.Lider || '').toLowerCase().trim(); // Trim também
            const usernameDigitado = String(username || '').toLowerCase().trim();   // Trim também

            // console.log(`Comparando: '${usernameDigitado}' com '${liderNaPlanilha}'`);
            return liderNaPlanilha === usernameDigitado;
        });

        if (liderEncontrado) {
            // console.log("Líder encontrado:", liderEncontrado);
            // console.log("RI da Planilha:", String(liderEncontrado.RI), "Senha digitada:", String(password));

            if (String(liderEncontrado.RI).trim() === String(password).trim()) { // Trim nos RIs também
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
