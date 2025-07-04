// Carrega as variáveis de ambiente do arquivo .env
require('dotenv').config();

const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors'); // Necessário para comunicação entre domínios diferentes

const app = express();
// Render usa a variável de ambiente PORT para a porta do seu serviço
const PORT = process.env.PORT || 3000;

// Configuração do CORS: MUITO IMPORTANTE!
// Permita apenas a URL do seu frontend no Vercel.
// Em desenvolvimento, você pode usar '*', mas em produção, seja específico.
// Exemplo: 

const FRONTEND_URL = process.env.FRONTEND_URL; // Usar uma variável de ambiente para isso é o ideal

app.use(cors({
    origin: FRONTEND_URL, // Permite requisições APENAS do seu frontend Vercel
    methods: ['GET', 'POST', 'PUT', 'DELETE'], // Métodos HTTP permitidos
    allowedHeaders: ['Content-Type', 'Authorization'], // Cabeçalhos permitidos
}));

// Middleware para parsear o corpo das requisições JSON
app.use(bodyParser.json());

// URL base do seu Google Apps Script (obtida do .env ou das variáveis de ambiente do Render)
const APPS_SCRIPT_BASE_URL = process.env.APPS_SCRIPT_BASE_URL;

// --- ROTAS DA API ---

// Rota para obter a lista de membros
app.get('/get-membros', async (req, res) => {
    if (!APPS_SCRIPT_BASE_URL) {
        console.error('APPS_SCRIPT_BASE_URL não configurada.');
        return res.status(500).json({ success: false, message: 'Erro de configuração do servidor: URL do Apps Script não definida.' });
    }
    const appsScriptUrl = `${APPS_SCRIPT_BASE_URL}?action=getMembros`;
    try {
        console.log(`Fetching members from Apps Script: ${appsScriptUrl}`);
        const response = await fetch(appsScriptUrl);
        if (!response.ok) {
            const errorText = await response.text();
            console.error(`Erro ao buscar membros do Apps Script: ${response.status} - ${errorText}`);
            throw new Error(`Erro HTTP ${response.status}: ${errorText}`);
        }
        const data = await response.json();
        res.json(data);
    } catch (error) {
        console.error('Erro no backend ao obter membros:', error);
        res.status(500).json({ success: false, message: 'Erro ao obter dados de membros.', details: error.message });
    }
});

// Rota para registrar a presença
app.post('/presenca', async (req, res) => {
    if (!APPS_SCRIPT_BASE_URL) {
        console.error('APPS_SCRIPT_BASE_URL não configurada.');
        return res.status(500).json({ success: false, message: 'Erro de configuração do servidor: URL do Apps Script não definida.' });
    }
    const { nome, data, hora, sheet } = req.body;
    if (!nome || !data || !hora || !sheet) {
        return res.status(400).json({ success: false, message: 'Dados incompletos para registrar presença.' });
    }

    const appsScriptUrl = `${APPS_SCRIPT_BASE_URL}?action=registrarPresenca`;
    try {
        console.log(`Sending attendance for ${nome} to Apps Script: ${appsScriptUrl}`);
        const response = await fetch(appsScriptUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ nome, data, hora, sheet }),
        });

        if (!response.ok) {
            const errorText = await response.text();
            console.error(`Erro ao registrar presença no Apps Script: ${response.status} - ${errorText}`);
            throw new Error(`Erro HTTP ${response.status}: ${errorText}`);
        }
        const responseData = await response.json();
        res.json(responseData);
    } catch (error) {
        console.error('Erro no backend ao registrar presença:', error);
        res.status(500).json({ success: false, message: 'Erro ao registrar presença.', details: error.message });
    }
});

// Rota para obter as presenças totais
app.get('/get-presencas-total', async (req, res) => {
    if (!APPS_SCRIPT_BASE_URL) {
        console.error('APPS_SCRIPT_BASE_URL não configurada.');
        return res.status(500).json({ success: false, message: 'Erro de configuração do servidor: URL do Apps Script não definida.' });
    }
    const appsScriptUrl = `${APPS_SCRIPT_BASE_URL}?action=getPresencasTotal`;
    try {
        console.log(`Fetching total attendances from Apps Script: ${appsScriptUrl}`);
        const response = await fetch(appsScriptUrl);
        if (!response.ok) {
            const errorText = await response.text();
            console.error(`Erro ao buscar presenças totais do Apps Script: ${response.status} - ${errorText}`);
            throw new Error(`Erro HTTP ${response.status}: ${errorText}`);
        }
        const data = await response.json();
        res.json(data);
    } catch (error) {
        console.error('Erro no backend ao obter presenças totais:', error);
        res.status(500).json({ success: false, message: 'Erro ao obter presenças totais.', details: error.message });
    }
});

// Rota para a autenticação (simulada ou real, dependendo da sua lógica)
app.post('/login', (req, res) => {
    const { username, password } = req.body;
    // Autenticação simples (APENAS PARA DEMONSTRAÇÃO)
    // Em um sistema real, você faria uma consulta a um banco de dados
    if (username === 'admin' && password === 'admin') {
        // Em um sistema real, você geraria um token JWT aqui e o enviaria de volta
        res.json({ success: true, message: 'Login bem-sucedido!' });
    } else {
        res.status(401).json({ success: false, message: 'Credenciais inválidas.' });
    }
});


// Rota simples para verificar se a API está no ar
app.get('/status', (req, res) => {
    res.json({ status: 'API está online e funcionando!', timestamp: new Date().toISOString() });
});


// Inicia o servidor
app.listen(PORT, () => {
    console.log(`Servidor rodando na porta ${PORT}`);
    console.log(`CORS configurado para permitir requisições de: ${FRONTEND_URL}`)
    
});