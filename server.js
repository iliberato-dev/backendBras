// ------------------------------------------------------
// Backend Node.js (server.js) - ATUALIZADO (v2)
// Foco na delegação de autenticação de líderes para o Apps Script
// e melhoria da função de comunicação.
// ------------------------------------------------------
require('dotenv').config();

const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const fetch = require('node-fetch'); // Certifique-se de que 'node-fetch' está instalado (npm install node-fetch@2)

const app = express();
const PORT = process.env.PORT || 3000;

// --- CONFIGURAÇÃO DE URLs E CORS ---
const APPS_SCRIPT_URL = process.env.APPS_SCRIPT_URL;
const FRONTEND_URL = process.env.FRONTEND_URL;

// Configuração do CORS para permitir requisições do seu frontend
app.use(cors({
    origin: FRONTEND_URL,
    methods: ['GET', 'POST', 'PUT', 'DELETE'],
    allowedHeaders: ['Content-Type', 'Authorization'],
}));

// Middleware para parsear o corpo das requisições JSON
app.use(bodyParser.json());

// --- FUNÇÃO UTILITÁRIA PARA REQUISIÇÕES AO APPS SCRIPT (REVISADA) ---
/**
 * Encaminha uma requisição para o Google Apps Script.
 * @param {string} action O nome da ação a ser executada no Apps Script (ex: 'getMembros', 'registerPresence', 'login').
 * @param {string} method O método HTTP ('GET' ou 'POST').
 * @param {Object} [body] O corpo da requisição para métodos POST.
 * @param {Object} [queryParams] Parâmetros de query para métodos GET.
 * @returns {Promise<Object>} A resposta JSON do Apps Script.
 * @throws {Error} Se houver erro de configuração, comunicação ou erro lógico do Apps Script.
 */
async function fetchFromAppsScript(action, method = 'GET', body = null, queryParams = {}) {
    if (!APPS_SCRIPT_URL) {
        console.error('Erro de configuração: Variável de ambiente APPS_SCRIPT_URL não definida.');
        throw new Error('Erro de configuração do servidor: URL do Apps Script não definida.');
    }

    let url = new URL(APPS_SCRIPT_URL); // Usa o construtor URL para melhor manipulação

    if (method === 'GET') {
        url.searchParams.append('tipo', action); // Adiciona 'tipo' para GET
        for (const key in queryParams) {
            if (Object.hasOwnProperty.call(queryParams, key) && queryParams[key] !== undefined && queryParams[key] !== null) {
                url.searchParams.append(key, queryParams[key]);
            }
        }
    } 
    // Para POST, o 'action' é enviado no corpo (como 'action' ou implícito pelo contexto da rota),
    // e o Apps Script decide o que fazer via `postData.action`.
    // Não precisamos adicionar 'tipo' na URL para POSTs, a menos que o Apps Script explicitamente espere.
    // Com o `doPost` do Apps Script lendo `postData.action`, a URL base é suficiente para POSTs.

    const options = {
        method: method,
        headers: { 'Content-Type': 'application/json' },
    };

    // Para requisições POST, o body precisa incluir a 'action' que o Apps Script espera
    if (method === 'POST') {
        options.body = JSON.stringify({ ...body, action: action }); // Adiciona a ação ao corpo
    }

    console.log(`Backend: Encaminhando ${method} para Apps Script (Action: ${action}): ${url.toString()}`);
    
    const response = await fetch(url.toString(), options); // Usa url.toString()

    const responseText = await response.text();

    let responseData;
    try {
        responseData = JSON.parse(responseText);
    } catch (e) {
        console.error(`Backend: Erro ao parsear JSON do Apps Script: ${e.message}. Resposta bruta: ${responseText}`);
        // Lança um erro padronizado para o consumidor do fetchFromAppsScript
        throw new Error(`Resposta inválida do Apps Script: ${responseText.substring(0, Math.min(responseText.length, 200))}... (Não é JSON válido)`);
    }

    if (!response.ok || responseData.success === false) {
        console.error(`Backend: Erro lógico/HTTP do Apps Script (Action: ${action}, Method: ${method}): Status ${response.status} - Resposta: ${JSON.stringify(responseData)}`);
        // Lança o erro para ser pego pelo catch da rota
        throw new Error(responseData.message || `Erro desconhecido do Apps Script para ação ${action}.`);
    }
    
    console.log(`Backend: Resposta bem-sucedida do Apps Script (Action: ${action}, Method: ${method}): ${JSON.stringify(responseData)}`);
    return responseData;
}

// --- ROTAS DA API ---

app.get('/get-membros', async (req, res) => {
    try {
        // O Apps Script retorna { success: true, data: { membros: [...] } }
        const data = await fetchFromAppsScript('getMembros');
        res.status(200).json(data); // Retorna a resposta completa do Apps Script
    } catch (error) {
        console.error('Erro no backend ao obter membros:', error);
        res.status(500).json({ success: false, message: 'Erro ao obter dados de membros.', details: error.message });
    }
});

app.post('/presenca', async (req, res) => {
    const { nome, data, hora, sheet } = req.body;
    if (!nome || !data || !hora || !sheet) {
        return res.status(400).json({ success: false, message: 'Dados incompletos para registrar presença.' });
    }
    try {
        // A action 'registerPresence' é enviada no corpo da requisição POST para o Apps Script
        const responseData = await fetchFromAppsScript('registerPresence', 'POST', { nome, data, hora, sheet });
        res.status(200).json(responseData);
    } catch (error) {
        console.error('Erro no backend ao registrar presença:', error);
        // Tratamento específico para presença já registrada
        if (error.message && error.message.includes("já foi registrada")) {
            return res.status(200).json({ // Status 200 porque é uma validação de negócio, não um erro de servidor
                success: false,
                message: error.message,
                lastPresence: { data: data, hora: hora } // Opcional, se o frontend precisar
            });
        }
        res.status(500).json({ success: false, message: 'Erro ao registrar presença.', details: error.message });
    }
});

app.get('/get-presencas-total', async (req, res) => {
    try {
        // req.query contém os filtros (periodo, lider, gape, monthYear)
        const data = await fetchFromAppsScript('presencasTotal', 'GET', null, req.query);
        res.status(200).json(data.data || {}); // Apps Script retorna { success: true, data: { totalPresences, generalTotal } }
    } catch (error) {
        console.error('Erro no backend ao obter presenças totais:', error);
        res.status(500).json({ success: false, message: 'Erro ao obter presenças totais.', details: error.message });
    }
});

app.get('/get-all-last-presences', async (req, res) => {
    try {
        // Apps Script retorna { success: true, data: { [memberName]: { data, hora } } }
        const data = await fetchFromAppsScript('getLastPresencesForAllMembers');
        res.status(200).json(data.data || {});
    } catch (error) {
        console.error('Erro no backend ao obter todas as últimas presenças:', error);
        res.status(500).json({ success: false, message: 'Erro ao obter últimas presenças de todos os membros.', details: error.message });
    }
});

app.get('/get-detailed-presences', async (req, res) => {
    try {
        // req.query contém todos os filtros necessários para esta requisição
        // Apps Script retorna { success: true, data: { detailedPresences, attendanceByPeriod, memberAttendanceCounts } }
        const data = await fetchFromAppsScript('getDetailedPresences', 'GET', null, req.query);
        res.status(200).json(data.data || {});
    } catch (error) {
        console.error('Erro no backend ao obter presenças detalhadas:', error);
        res.status(500).json({ success: false, message: 'Erro ao obter presenças detalhadas.', details: error.message });
    }
});

// --- Rota de Autenticação de Usuário (Líder ou Admin) ---
app.post("/login", async (req, res) => {
    const { username, password } = req.body;
    console.log(`Backend: Tentativa de login para usuário: "${username}"`);

    const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
    const ADMIN_RI = process.env.ADMIN_RI || 'admin';

    // 1. Tenta login como Administrador local (hardcoded ou via .env)
    if (username.toLowerCase() === ADMIN_USERNAME.toLowerCase() && password === ADMIN_RI) {
        console.log(`Backend: Login bem-sucedido para usuário master: ${username}`);
        return res.status(200).json({ success: true, message: 'Login bem-sucedido como Administrador!', leaderName: username, role: 'admin' });
    }

    try {
        // 2. Tenta login via Google Apps Script (delegando a lógica de autenticação de líder para o Apps Script)
        // A função 'loginLeader' no Apps Script é chamada com 'usuario' e 'senha'.
        // O Apps Script verifica a planilha 'Login' e a regra de liderança.
        const responseData = await fetchFromAppsScript('loginLeader', 'POST', { usuario: username, senha: password });
        
        // Se o Apps Script retornou sucesso, o líder foi autenticado lá.
        console.log(`Backend: Login bem-sucedido via Apps Script para líder: ${responseData.data.leaderName}`);
        return res.status(200).json({ 
            success: true, 
            message: responseData.message || `Login bem-sucedido, ${responseData.data.leaderName}!`, 
            leaderName: responseData.data.leaderName,
            role: 'leader' // Atribui o papel de 'leader' para o frontend
        });

    } catch (error) {
        console.error("Backend: Erro ao tentar autenticar líder com Apps Script:", error);
        // O Apps Script já deve estar retornando mensagens específicas (ex: "Credenciais inválidas")
        const statusCode = error.message.includes('Credenciais inválidas') || error.message.includes('não encontrado') || error.message.includes('Usuário não é um líder') ? 401 : 500;
        return res.status(statusCode).json({ 
            success: false, 
            message: error.message || 'Erro interno do servidor ao autenticar.', 
            details: error.message 
        });
    }
});

// Rota de status para verificar se o servidor está online
app.get('/status', (req, res) => {
    res.status(200).json({ status: 'API está online e funcionando!', timestamp: new Date().toISOString() });
});

// Inicia o servidor
app.listen(PORT, () => {
    console.log(`Servidor rodando na porta ${PORT}`);
    console.log(`CORS configurado para permitir requisições de: ${FRONTEND_URL}`);
    console.log(`URL do Google Apps Script: ${APPS_SCRIPT_URL ? APPS_SCRIPT_URL.substring(0, 40) + '...' : 'NÃO DEFINIDA'}`);
});
