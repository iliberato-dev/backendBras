// ------------------------------------------------------
// Backend Node.js (server.js)
// ------------------------------------------------------
// Carrega as variáveis de ambiente do arquivo .env (para desenvolvimento local)
// No Render, essas variáveis são injetadas diretamente no ambiente
require('dotenv').config();

const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const fetch = require('node-fetch'); // Ou use 'axios' para mais recursos

const app = express();
const PORT = process.env.PORT || 3000;

// --- CONFIGURAÇÃO DE URLs E CORS ---
// A URL base do seu Google Apps Script Web App.
const APPS_SCRIPT_URL = process.env.APPS_SCRIPT_URL;
// A URL do seu frontend hospedado no Vercel.
const FRONTEND_URL = process.env.FRONTEND_URL;
// Token de autenticação para o Apps Script. DEVE SER O MESMO configurado lá!
const APPS_SCRIPT_AUTH_TOKEN = process.env.APPS_SCRIPT_AUTH_TOKEN;

// Credenciais do Admin Master (para login de emergência/gerenciamento)
const ADMIN_USERNAME = process.env.ADMIN_USERNAME; // DEVE SER DEFINIDO NO .env e no Render
const ADMIN_RI = process.env.ADMIN_RI;             // DEVE SER DEFINIDO NO .env e no Render

// Configuração do CORS: Permite requisições APENAS da URL do seu frontend (Vercel) e de origens locais.
app.use(cors({
    origin: FRONTEND_URL,
    methods: ['GET', 'POST', 'PUT', 'DELETE'],
    allowedHeaders: ['Content-Type', 'Authorization'],
}));

// Middleware para parsear o corpo das requisições JSON
app.use(bodyParser.json());

// --- CACHE DE MEMBROS ---
let cachedMembros = null;
let lastMembrosFetchTime = 0;
const MEMBERS_CACHE_TTL = 5 * 60 * 1000; // Cache de 5 minutos (em milissegundos)

// --- FUNÇÃO UTILITÁRIA PARA REQUISIÇÕES AO APPS SCRIPT ---
// Centraliza a lógica de chamada ao Apps Script e tratamento de erros
async function fetchFromAppsScript(actionType, method = 'GET', body = null, queryParams = {}) {
    if (!APPS_SCRIPT_URL) {
        console.error('Backend: Erro de configuração: Variável de ambiente APPS_SCRIPT_URL não definida.');
        throw new Error('Erro de configuração do servidor: URL do Apps Script não definida.');
    }
    if (!APPS_SCRIPT_AUTH_TOKEN) {
        console.error('Backend: Erro de configuração: Variável de ambiente APPS_SCRIPT_AUTH_TOKEN não definida.');
        throw new Error('Erro de configuração do servidor: Token de autenticação do Apps Script não definido.');
    }

    let url = APPS_SCRIPT_URL;
    const urlParams = new URLSearchParams();
    const options = {
        method: method,
        headers: { 'Content-Type': 'application/json' },
    };

    if (method === 'GET') {
        urlParams.append('tipo', actionType);
        urlParams.append('auth_token', APPS_SCRIPT_AUTH_TOKEN); // Token para GET no query param
        for (const key in queryParams) {
            if (queryParams.hasOwnProperty(key) && queryParams[key]) {
                urlParams.append(key, queryParams[key]);
            }
        }
        url = `${APPS_SCRIPT_URL}?${urlParams.toString()}`;
    } else if (method === 'POST') {
        // Para POST, o token vai no corpo do JSON
        const postBody = { ...body, auth_token: APPS_SCRIPT_AUTH_TOKEN };
        options.body = JSON.stringify(postBody);
        // Se algum POST precisasse de 'tipo' no query, seria adicionado aqui.
        // Atualmente o 'doPost' do Apps Script espera tudo no body.
    } else {
        throw new Error(`Método HTTP não suportado: ${method}`);
    }
    
    console.log(`Backend: Encaminhando ${method} para Apps Script: ${url}`);
    
    const response = await fetch(url, options);
    const responseText = await response.text();

    let responseData;
    try {
        responseData = JSON.parse(responseText);
    } catch (e) {
        console.error(`Backend: Erro ao parsear JSON do Apps Script: ${e.message}. Resposta bruta: ${responseText.substring(0, 500)}...`);
        throw new Error(`Resposta inválida do Apps Script: ${responseText.substring(0, 100)}...`);
    }

    // O Apps Script agora sempre retorna { success: true/false, ... }
    // então a verificação de !response.ok é para erros HTTP, e responseData.success para erros lógicos.
    if (!response.ok || responseData.success === false) {
        console.error(`Backend: Erro lógico/HTTP do Apps Script (${actionType} ${method}): Status ${response.status} - Resposta: ${JSON.stringify(responseData)}`);
        // Lança o erro com a mensagem do Apps Script para ser capturada e repassada pelo backend
        const errorMessage = responseData.message || 'Erro desconhecido do Apps Script.';
        const error = new Error(errorMessage);
        // Adiciona a flag alreadyExists se o Apps Script a retornou
        if (responseData.alreadyExists) {
            error.alreadyExists = true;
            error.lastPresence = responseData.lastPresence;
        }
        throw error;
    }
    
    console.log(`Backend: Resposta bem-sucedida do Apps Script (${actionType} ${method}): ${JSON.stringify(responseData)}`);
    return responseData;
}

/**
 * Função para obter membros, utilizando cache.
 */
async function getMembrosWithCache() {
    // Se o cache existe e não expirou, retorna os dados cacheados
    if (cachedMembros && (Date.now() - lastMembrosFetchTime < MEMBERS_CACHE_TTL)) {
        console.log("Backend: Retornando membros do cache.");
        return { success: true, membros: cachedMembros };
    }

    // Se o cache está vazio ou expirou, busca do Apps Script
    console.log("Backend: Buscando membros do Apps Script (cache expirado ou vazio).");
    const data = await fetchFromAppsScript('getMembros');
    
    // Armazena no cache se a busca foi bem-sucedida
    if (data.success) {
        cachedMembros = data.membros;
        lastMembrosFetchTime = Date.now();
        console.log(`Backend: Membros cacheados. Total: ${cachedMembros.length}`);
    } else {
        console.warn("Backend: Falha ao buscar membros do Apps Script para cache:", data.message);
    }
    return data;
}

// Helper para normalizar strings para comparação (removendo acentos e caracteres especiais)
function normalizeString(str) {
    if (typeof str !== 'string') {
        return '';
    }
    return str.toLowerCase()
              .normalize("NFD")
              .replace(/[\u0300-\u036f]/g, "")
              .replace(/[^a-z0-9\s]/g, '')
              .trim();
}

// --- ROTAS DA API ---

// Rota para obter a lista de membros (agora usa o cache)
app.get('/get-membros', async (req, res) => {
    try {
        const data = await getMembrosWithCache();
        res.status(200).json(data);
    } catch (error) {
        console.error('Erro no backend ao obter membros (via cache ou Apps Script):', error.message);
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
        const responseData = await fetchFromAppsScript('doPost', 'POST', { nome, data, hora, sheet });
        
        // Se a resposta do Apps Script indica sucesso ou "já registrada", repassa para o frontend
        res.status(200).json(responseData);
    } catch (error) {
        console.error('Erro no backend ao registrar presença:', error.message);

        // Verifica se o erro é por "presença já registrada" (usando a flag 'alreadyExists')
        if (error.alreadyExists) {
            return res.status(409).json({ // 409 Conflict: Indica que o recurso já existe
                success: false,
                message: error.message,
                lastPresence: error.lastPresence || { data, hora } // Usa o do erro ou os dados enviados
            });
        }
        
        res.status(500).json({ success: false, message: 'Erro ao registrar presença.', details: error.message });
    }
});

// Rota para obter as presenças totais (do Apps Script)
app.get('/get-presencas-total', async (req, res) => {
    try {
        const data = await fetchFromAppsScript('presencasTotal', 'GET', null, req.query);
        res.status(200).json(data.data || {}); // Apps Script retorna { success: true, data: {...} }
    } catch (error) {
        console.error('Erro no backend ao obter presenças totais:', error.message);
        res.status(500).json({ success: false, message: 'Erro ao obter presenças totais.', details: error.message });
    }
});

// Rota para obter a última presença para TODOS os membros
app.get('/get-all-last-presences', async (req, res) => {
    try {
        const data = await fetchFromAppsScript('getLastPresencesForAllMembers');
        res.status(200).json(data.data || {}); // Apps Script retorna { success: true, data: {...} }
    } catch (error) {
        console.error('Erro no backend ao obter todas as últimas presenças:', error.message);
        res.status(500).json({ success: false, message: 'Erro ao obter últimas presenças de todos os membros.', details: error.message });
    }
});

// Rota de Autenticação (LOGIN)
app.post("/login", async (req, res) => {
    const { username, password } = req.body;
    console.log(`Backend: Tentativa de login para usuário: "${username}"`);

    // 1. Tenta autenticar como administrador master
    if (ADMIN_USERNAME && ADMIN_RI && 
        normalizeString(username) === normalizeString(ADMIN_USERNAME) && 
        password === ADMIN_RI) {
        console.log(`Backend: Login bem-sucedido para usuário master: ${username}`);
        return res.status(200).json({ success: true, message: 'Login bem-sucedido como Administrador!', leaderName: username });
    }

    // 2. Se não for administrador, tenta autenticar como líder (usando cache)
    try {
        const responseData = await getMembrosWithCache(); // Usa a função com cache
        const membros = responseData.membros || [];
        
        if (!membros || !Array.isArray(membros) || membros.length === 0) {
            console.warn("Backend: Nenhuma lista de membros válida retornada ou a lista está vazia para autenticação.");
            return res.status(404).json({ success: false, message: 'Erro: Não foi possível carregar os dados de membros ou a lista está vazia para autenticação.' });
        }

        const usernameDigitadoNormalized = normalizeString(username);
        const usernameWords = usernameDigitadoNormalized.split(' ').filter(word => word.length > 0);

        // Tenta encontrar o membro pelo 'Nome Membro' (correspondência exata ou parcial)
        const membroEncontradoPeloNome = membros.find(membro => {
            const nomeMembroNaPlanilhaNormalized = normalizeString(membro.Nome || '');
            
            // Para ser um match, o nome na planilha deve conter TODAS as palavras digitadas, na ordem.
            const allWordsMatch = usernameWords.every(word => nomeMembroNaPlanilhaNormalized.includes(word));
            
            return allWordsMatch;
        });

        if (membroEncontradoPeloNome) {
            console.log(`Backend Login: Membro encontrado pelo nome: ${membroEncontradoPeloNome.Nome}`);
            // Se o membro foi encontrado pelo Nome Membro, verifica a senha (RI)
            if (String(membroEncontradoPeloNome.RI || '').trim() === String(password || '').trim()) {
                console.log(`Backend Login: Senha (RI) correta para ${membroEncontradoPeloNome.Nome}.`);
                
                const cargoMembroNormalized = normalizeString(membroEncontradoPeloNome.Cargo || '');
                const statusMembroNormalized = normalizeString(membroEncontradoPeloNome.Status || '');
                
                let isLeaderByRole = false;

                // 1. Verifica se o Cargo ou Status do próprio membro indica liderança
                if (cargoMembroNormalized.includes('lider') || statusMembroNormalized.includes('lider')) {
                    isLeaderByRole = true;
                    console.log(`Backend Login: Membro '${membroEncontradoPeloNome.Nome}' é líder por Cargo/Status.`);
                }

                // 2. Verificação adicional: Se o membro não foi identificado como líder por Cargo/Status,
                // verifica se o nome do membro aparece como líder em qualquer 'Grupo Líder'
                if (!isLeaderByRole) { 
                    const nomeDoMembroLogandoNormalized = normalizeString(membroEncontradoPeloNome.Nome || '');
                    console.log(`Backend Login: Verificando se '${nomeDoMembroLogandoNormalized}' aparece como líder em algum grupo...`);

                    isLeaderByRole = membros.some(anyMember => {
                        const liderNaPlanilhaCompleto = String(anyMember.Lider || '').trim();
                        const congregacaoAnyMember = String(anyMember.Congregacao || '').trim();

                        let nomeLiderExtraidoDoGrupo = '';
                        const dynamicPrefix = congregacaoAnyMember ? `${congregacaoAnyMember} | ` : ''; // Não normaliza prefixo para substring

                        if (dynamicPrefix && liderNaPlanilhaCompleto.startsWith(dynamicPrefix)) {
                            nomeLiderExtraidoDoGrupo = liderNaPlanilhaCompleto.substring(dynamicPrefix.length).trim();
                        } else {
                            nomeLiderExtraidoDoGrupo = liderNaPlanilhaCompleto;
                        }

                        // Normaliza os nomes para comparação fuzzy
                        const extractedLeaderWordsNormalized = normalizeString(nomeLiderExtraidoDoGrupo).split(' ').filter(word => word.length > 0);
                        
                        let isFuzzyMatch = false;

                        if (usernameWords.length > 0 && extractedLeaderWordsNormalized.length > 0) {
                            const [shorterArr, longerArr] = usernameWords.length <= extractedLeaderWordsNormalized.length ?
                                [usernameWords, extractedLeaderWordsNormalized] :
                                [extractedLeaderWordsNormalized, usernameWords];

                            isFuzzyMatch = shorterArr.every((sWord, index) => {
                                return longerArr[index] && longerArr[index].startsWith(sWord);
                            });
                        }
                        
                        console.log(`Backend Login:    Comparando '${nomeDoMembroLogandoNormalized}' com líder extraído: '${normalizeString(nomeLiderExtraidoDoGrupo)}'. Fuzzy Match: ${isFuzzyMatch}`);
                        return isFuzzyMatch;
                    });
                }
                
                console.log(`Backend Login: Resultado final - É líder? ${isLeaderByRole}`);

                if (isLeaderByRole) {
                    console.log(`Backend: Login bem-sucedido para o líder: ${membroEncontradoPeloNome.Nome}`);
                    return res.status(200).json({ success: true, message: `Login bem-sucedido, ${membroEncontradoPeloNome.Nome}!`, leaderName: membroEncontradoPeloNome.Nome });
                } else {
                    console.log(`Backend: Usuário '${username}' encontrado e senha correta, mas não tem o cargo/status de Líder ou não é líder de grupo.`);
                    return res.status(401).json({ success: false, message: 'Credenciais inválidas: Usuário não é um líder ou não foi encontrado como tal.' });
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
        console.error("Backend: Erro FATAL ao tentar autenticar líder com Apps Script:", error.message);
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
    // Opcional: Pré-carrega o cache de membros na inicialização
    getMembrosWithCache().catch(err => console.error("Erro ao pré-carregar cache de membros na inicialização:", err.message));
})
