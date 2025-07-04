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
// ROTA DE AUTENTICAÇÃO (LOGIN)
// ... (código anterior) ...

// ROTA DE AUTENTICAÇÃO (LOGIN)
app.post("/login", async (req, res) => {
    const { username, password } = req.body; // <-- O que exatamente está vindo aqui?
    console.log(`Backend: Tentativa de login para usuário: "${username}" com senha: "${password}"`); // Adicionei aspas para ver espaços

    // --- 1. Tentar Login como Usuário Master (admin) ---
    const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
    const ADMIN_RI = process.env.ADMIN_RI || 'admin';

    if (username.toLowerCase() === ADMIN_USERNAME.toLowerCase() && password === ADMIN_RI) {
        console.log(`Backend: Login bem-sucedido para usuário master: ${username}`);
        return res.status(200).json({ success: true, message: 'Login bem-sucedido como Administrador!' });
    }

    // --- 2. Tentar Login como Líder da Planilha ---
    try {
        const responseData = await fetchFromAppsScript('getMembros');
        const membros = responseData.membros || responseData.data;

        if (!membros || !Array.isArray(membros) || membros.length === 0) {
            console.warn("Backend: Nenhuma lista de membros válida retornada do Apps Script (mesmo que JSON ok, array pode estar vazio).");
            // Se o array 'membros' estiver vazio, isso pode acontecer.
            return res.status(404).json({ success: false, message: 'Erro: Não foi possível carregar os dados de membros ou a lista está vazia.' });
        }

        // --- Ponto crítico de depuração: O que está em 'membros' ANTES do find? ---
         console.log("Backend: Membros recebidos do Apps Script (primeiro):", membros[0]);
         console.log("Backend: Membros recebidos do Apps Script (último):", membros[membros.length -1]);
         console.log("Backend: Tipo de 'membros':", typeof membros, "É array?", Array.isArray(membros));
         console.log("Backend: Total de membros:", membros.length);


        const liderEncontrado = membros.find(membro => {
            const liderNaPlanilha = String(membro.Lider || '').toLowerCase(); // Garante string e minúsculas
            const usernameDigitado = String(username || '').toLowerCase();     // Garante string e minúsculas

            // console.log(`Comparando: '${usernameDigitado}' com '${liderNaPlanilha}'`); // Log de comparação
            return liderNaPlanilha === usernameDigitado;
        });

        if (liderEncontrado) {
             console.log("Líder encontrado:", liderEncontrado); // Log do objeto líder encontrado
             console.log("RI da Planilha:", String(liderEncontrado.RI), "Senha digitada:", String(password));

            if (String(liderEncontrado.RI) === String(password)) {
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
        // ESTA É A MENSAGEM CRÍTICA NO LOG DO RENDER
        console.error("Backend: Erro FATAL ao tentar autenticar líder com Apps Script:", error);
        return res.status(500).json({ success: false, message: 'Erro interno do servidor ao autenticar.', details: error.message });
    }
});

// ... (restante do código) ...


// Rota simples para verificar se a API está no ar
app.get('/status', (req, res) => {
    res.json({ status: 'API está online e funcionando!', timestamp: new Date().toISOString() });
});


// Inicia o servidor
app.listen(PORT, () => {
    console.log(`Servidor rodando na porta ${PORT}`);
    console.log(`CORS configurado para permitir requisições de: ${FRONTEND_URL}`)
    
});
