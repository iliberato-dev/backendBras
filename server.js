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
async function fetchFromAppsScript(actionType, method = 'GET', body = null, queryParams = {}) {
    if (!APPS_SCRIPT_URL) {
        console.error('Erro de configuração: Variável de ambiente APPS_SCRIPT_URL não definida.');
        throw new Error('Erro de configuração do servidor: URL do Apps Script não definida.');
    }

    let url = APPS_SCRIPT_URL;
    const urlParams = new URLSearchParams();

    // Adiciona o tipo de ação para requisições GET
    if (method === 'GET') {
        urlParams.append('tipo', actionType);
        // Adiciona outros query parameters se existirem
        for (const key in queryParams) {
            if (queryParams.hasOwnProperty(key) && queryParams[key]) {
                urlParams.append(key, queryParams[key]);
            }
        }
        url = `${APPS_SCRIPT_URL}?${urlParams.toString()}`;
    } else if (method === 'POST' && actionType === 'doPost') {
        // Para POST para o Apps Script, a URL base é usada sem 'tipo' no query param,
        // pois o Apps Script 'doPost' processa o body diretamente.
        // O `actionType` é apenas um identificador para o log aqui.
        url = APPS_SCRIPT_URL;
    } else {
        // Para outros POSTs que talvez precisem de 'tipo' no query, mas não é o caso atual
        urlParams.append('tipo', actionType);
        url = `${APPS_SCRIPT_URL}?${urlParams.toString()}`;
    }
    
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
        // Se a resposta não for um JSON válido, loga e tenta criar um objeto de erro
        console.error(`Backend: Erro ao parsear JSON do Apps Script: ${e.message}. Resposta bruta: ${responseText}`);
        responseData = { success: false, message: `Resposta inválida do Apps Script: ${responseText.substring(0, 100)}...`, details: e.message };
    }

    // O Apps Script agora sempre retorna { success: true/false, ... }
    // então a verificação de !response.ok é para erros HTTP, e responseData.success para erros lógicos.
    if (!response.ok || responseData.success === false) {
        console.error(`Backend: Erro lógico/HTTP do Apps Script (${actionType} ${method}): Status ${response.status} - Resposta: ${JSON.stringify(responseData)}`);
        // Lança o erro com a mensagem do Apps Script para ser capturada e repassada pelo backend
        throw new Error(responseData.message || 'Erro desconhecido do Apps Script.');
    }
    
    console.log(`Backend: Resposta bem-sucedida do Apps Script (${actionType} ${method}): ${JSON.stringify(responseData)}`);
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
        // Chama a função `doPost` do Apps Script.
        // O Apps Script `doPost` já retorna { success: true } ou { success: false, message: "já registrada" }
        const responseData = await fetchFromAppsScript('doPost', 'POST', { nome, data, hora, sheet });
        
        // Se a resposta do Apps Script indica sucesso ou "já registrada", repassa para o frontend
        res.status(200).json(responseData);
    } catch (error) {
        // Se o `fetchFromAppsScript` lançou um erro, isso significa que o Apps Script
        // retornou `success: false` por algum motivo (inclusive "já registrada")
        // ou houve um erro HTTP/parse JSON.
        console.error('Erro no backend ao registrar presença:', error);

        // Verifica se a mensagem de erro contém a frase "já foi registrada"
        if (error.message && error.message.includes("já foi registrada")) {
            // Repassa a mensagem de "já registrada" com success: false para o frontend
            return res.status(200).json({ // Retorna 200 OK, mas com success: false para indicar aviso
                success: false,
                message: error.message, // A mensagem já deve vir do Apps Script
                // Se o Apps Script retornasse lastPresence no erro, você poderia repassar aqui
                lastPresence: { data: data, hora: hora } // Placeholder, idealmente viria do Apps Script
            });
        }
        
        // Para outros erros, retorna status 500
        res.status(500).json({ success: false, message: 'Erro ao registrar presença.', details: error.message });
    }
});

// Rota para obter as presenças totais (do Apps Script)
// Agora passa os query parameters (periodo, lider, gape) para o Apps Script
app.get('/get-presencas-total', async (req, res) => {
    try {
        // req.query contém os parâmetros de query da URL (ex: ?periodo=X&lider=Y)
        const data = await fetchFromAppsScript('presencasTotal', 'GET', null, req.query);
        res.status(200).json(data.data || {}); // Apps Script retorna { success: true, data: {...} }
    } catch (error) {
        console.error('Erro no backend ao obter presenças totais:', error);
        res.status(500).json({ success: false, message: 'Erro ao obter presenças totais.', details: error.message });
    }
});

// --- NOVA ROTA: Obter a última presença para TODOS os membros ---
app.get('/get-all-last-presences', async (req, res) => {
    try {
        // Corrigido o actionType para corresponder ao nome da função no Apps Script
        const data = await fetchFromAppsScript('getLastPresencesForAllMembers'); 
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

    // 1. Tenta autenticar como administrador
    if (username.toLowerCase() === ADMIN_USERNAME.toLowerCase() && password === ADMIN_RI) {
        console.log(`Backend: Login bem-sucedido para usuário master: ${username}`);
        return res.status(200).json({ success: true, message: 'Login bem-sucedido como Administrador!' });
    }

    // 2. Se não for administrador, tenta autenticar como líder
    try {
        // Obtém a lista de membros do Apps Script para verificar credenciais
        const responseData = await fetchFromAppsScript('getMembros');
        const membros = responseData.membros || []; // Apps Script retorna { success: true, membros: [...] }

        if (!membros || !Array.isArray(membros) || membros.length === 0) {
            console.warn("Backend: Nenhuma lista de membros válida retornada do Apps Script ou a lista está vazia para autenticação.");
            return res.status(404).json({ success: false, message: 'Erro: Não foi possível carregar os dados de membros ou a lista está vazia para autenticação.' });
        }

        const usernameDigitado = String(username || '').toLowerCase().trim();

        // Tenta encontrar o membro pelo 'Nome Membro' (primeiro nome ou nome completo)
        const membroEncontradoPeloNome = membros.find(membro => {
            const nomeMembroNaPlanilha = String(membro.Nome || '').toLowerCase().trim();
            const firstWordOfMemberName = nomeMembroNaPlanilha.split(' ')[0];

            // Verifica se o username digitado é o nome completo OU o primeiro nome do membro
            return nomeMembroNaPlanilha === usernameDigitado || firstWordOfMemberName === usernameDigitado;
        });

        if (membroEncontradoPeloNome) {
            // Se o membro foi encontrado pelo Nome Membro, verifica a senha (RI)
            if (String(membroEncontradoPeloNome.RI).trim() === String(password).trim()) {
                // Agora, verifica se este 'Nome Membro' também aparece como 'Lider' em qualquer registro
                const isAlsoALider = membros.some(membro => {
                    const liderNaPlanilha = String(membro.Lider || '').toLowerCase().trim();
                    const nomeMembroLogando = String(membroEncontradoPeloNome.Nome || '').toLowerCase().trim();
                    
                    // Verifica se o nome completo do membro que está a logar é um líder
                    // ou se o primeiro nome do membro que está a logar é um líder
                    const firstWordOfLider = liderNaPlanilha.split(' ')[0];
                    return liderNaPlanilha === nomeMembroLogando || firstWordOfLider === nomeMembroLogando;
                });

                if (isAlsoALider) {
                    console.log(`Backend: Login bem-sucedido para o líder (Nome Membro e Lider): ${membroEncontradoPeloNome.Nome}`);
                    return res.status(200).json({ success: true, message: `Login bem-sucedido, ${membroEncontradoPeloNome.Nome}!` });
                } else {
                    console.log(`Backend: Usuário '${username}' encontrado e senha correta, mas não está listado como Líder.`);
                    return res.status(401).json({ success: false, message: 'Credenciais inválidas: Usuário não é um líder.' });
                }
            } else {
                console.log(`Backend: Senha inválida para o usuário: ${username}`);
                return res.status(401).json({ success: false, message: 'Senha inválida.' });
            }
        } else {
            console.log(`Backend: Usuário '${username}' não encontrado na lista de membros.`);
            return res.status(401).json({ success: false, message: 'Usuário não encontrado ou credenciais inválidas.' });
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
