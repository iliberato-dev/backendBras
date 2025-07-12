// ------------------------------------------------------
// Backend Node.js (server.js) - Atualizado
// ------------------------------------------------------
require('dotenv').config();

const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const fetch = require('node-fetch');

const app = express();
const PORT = process.env.PORT || 3000;

// --- CONFIGURAÇÃO DE URLs E CORS ---
const APPS_SCRIPT_URL = process.env.APPS_SCRIPT_URL;
const FRONTEND_URL = process.env.FRONTEND_URL;
const APPS_SCRIPT_AUTH_TOKEN = process.env.APPS_SCRIPT_AUTH_TOKEN;

const ADMIN_USERNAME = process.env.ADMIN_USERNAME;
const ADMIN_RI = process.env.ADMIN_RI;

app.use(cors({
    origin: FRONTEND_URL,
    methods: ['GET', 'POST', 'PUT', 'DELETE'],
    allowedHeaders: ['Content-Type', 'Authorization'],
}));

app.use(bodyParser.json());

// --- CACHE DE MEMBROS ---
let cachedMembros = null;
let lastMembrosFetchTime = 0;
const MEMBERS_CACHE_TTL = 5 * 60 * 1000; // Cache de 5 minutos (em milissegundos)

// --- FUNÇÃO UTILITÁRIA PARA REQUISIÇÕES AO APPS SCRIPT ---
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
        urlParams.append('auth_token', APPS_SCRIPT_AUTH_TOKEN);
        for (const key in queryParams) {
            if (queryParams.hasOwnProperty(key) && queryParams[key]) {
                urlParams.append(key, queryParams[key]);
            }
        }
        url = `${APPS_SCRIPT_URL}?${urlParams.toString()}`;
    } else if (method === 'POST') {
        const postBody = { ...body, auth_token: APPS_SCRIPT_AUTH_TOKEN };
        options.body = JSON.stringify(postBody);
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

    if (!response.ok || responseData.success === false) {
        console.error(`Backend: Erro lógico/HTTP do Apps Script (${actionType} ${method}): Status ${response.status} - Resposta: ${JSON.stringify(responseData)}`);
        const errorMessage = responseData.message || 'Erro desconhecido do Apps Script.';
        const error = new Error(errorMessage);
        if (responseData.alreadyExists) {
            error.alreadyExists = true;
            error.lastPresence = responseData.lastPresence;
        }
        throw error;
    }
    
    console.log(`Backend: Resposta bem-sucedida do Apps Script (${actionType} ${method}): ${JSON.stringify(responseData)}`);
    return responseData;
}

// --- NOVA ROTA PARA UPLOAD DE FOTO ---
app.post('/upload-photo', async (req, res) => {
    const { fileName, fileData } = req.body; // fileData é a string base64
    if (!fileName || !fileData) {
        return res.status(400).json({ success: false, message: 'Nome do arquivo e dados da foto são obrigatórios.' });
    }

    try {
        // Inclua 'tipo' no payload para o Apps Script, direcionando para a função 'uploadPhoto'
        const responseData = await fetchFromAppsScript('doPost', 'POST', { tipo: 'uploadPhoto', fileName, fileData });
        
        // O Apps Script já retorna a URL e ID, passe-os diretamente
        res.status(200).json(responseData); 
    } catch (error) {
        console.error('Backend: Erro ao fazer upload da foto:', error.message);
        res.status(500).json({ success: false, message: 'Erro ao fazer upload da foto.', details: error.message });
    }
});

// --- ROTA OPCIONAL PARA OBTER URL DA FOTO POR ID ---
// Você pode não precisar desta rota se o upload já retorna a URL e você a armazena.
// Mas é útil se você apenas tiver o ID da foto e precisar buscar a URL novamente.
app.get('/get-photo-url/:fileId', async (req, res) => {
    const { fileId } = req.params;
    if (!fileId) {
        return res.status(400).json({ success: false, message: 'ID do arquivo é obrigatório.' });
    }

    try {
        // Chama o Apps Script com o tipo 'getPhotoUrl' e o fileId como query param
        const responseData = await fetchFromAppsScript('getPhotoUrl', 'GET', null, { fileId: fileId });
        res.status(200).json(responseData);
    } catch (error) {
        console.error('Backend: Erro ao obter URL da foto:', error.message);
        res.status(500).json({ success: false, message: 'Erro ao obter URL da foto.', details: error.message });
    }
});

/**
 * Função para obter membros, utilizando cache.
 */
async function getMembrosWithCache() {
    if (cachedMembros && (Date.now() - lastMembrosFetchTime < MEMBERS_CACHE_TTL)) {
        console.log("Backend: Retornando membros do cache.");
        return { success: true, membros: cachedMembros };
    }

    console.log("Backend: Buscando membros do Apps Script (cache expirado ou vazio).");
    const data = await fetchFromAppsScript('getMembros');
    
    if (data.success) {
        cachedMembros = data.membros;
        lastMembrosFetchTime = Date.now();
        console.log(`Backend: Membros cacheados. Total: ${cachedMembros.length}`);
    } else {
        console.warn("Backend: Falha ao buscar membros do Apps Script para cache:", data.message);
    }
    return data;
}

// Helper para normalizar strings para comparação (removendo acentos, caracteres especiais, e convertendo para minúsculas)
function normalizeString(str) {
    if (typeof str !== 'string') {
        return '';
    }
    return str.toLowerCase()
              .normalize("NFD") // Normaliza para decompor caracteres acentuados
              .replace(/[\u0300-\u036f]/g, "") // Remove os diacríticos (acentos)
              .replace(/[^a-z0-9\s]/g, '') // Remove caracteres não alfanuméricos (mantém espaços)
              .trim();
}

// --- ROTAS DA API ---

app.get('/get-membros', async (req, res) => {
    try {
        const data = await getMembrosWithCache();
        res.status(200).json(data);
    } catch (error) {
        console.error('Erro no backend ao obter membros (via cache ou Apps Script):', error.message);
        res.status(500).json({ success: false, message: 'Erro ao obter dados de membros.', details: error.message });
    }
});

app.post('/presenca', async (req, res) => {
    const { nome, data, hora, sheet } = req.body;
    if (!nome || !data || !hora || !sheet) {
        return res.status(400).json({ success: false, message: 'Dados incompletos para registrar presença.' });
    }
    try {
        const responseData = await fetchFromAppsScript('doPost', 'POST', { nome, data, hora, sheet });
        
        res.status(200).json(responseData);
    } catch (error) {
        console.error('Erro no backend ao registrar presença:', error.message);

        if (error.alreadyExists) {
            return res.status(409).json({
                success: false,
                message: error.message,
                lastPresence: error.lastPresence || { data, hora }
            });
        }
        
        res.status(500).json({ success: false, message: 'Erro ao registrar presença.', details: error.message });
    }
});

app.get('/get-presencas-total', async (req, res) => {
    try {
        const data = await fetchFromAppsScript('presencasTotal', 'GET', null, req.query);
        res.status(200).json(data.data || {});
    } catch (error) {
        console.error('Erro no backend ao obter presenças totais:', error.message);
        res.status(500).json({ success: false, message: 'Erro ao obter presenças totais.', details: error.message });
    }
});

app.get('/get-all-last-presences', async (req, res) => {
    try {
        const data = await fetchFromAppsScript('getLastPresencesForAllMembers');
        res.status(200).json(data.data || {});
    } catch (error) {
        console.error('Erro no backend ao obter todas as últimas presenças:', error.message);
        res.status(500).json({ success: false, message: 'Erro ao obter últimas presenças de todos os membros.', details: error.message });
    }
});

// Rota de Autenticação (LOGIN) - Lógica de busca de nome aprimorada
app.post("/login", async (req, res) => {
    const { username, password } = req.body;
    console.log(`Backend: Tentativa de login para usuário: "${username}"`);

    // 1. Tenta autenticar como administrador master
    if (ADMIN_USERNAME && ADMIN_RI && 
        normalizeString(username) === normalizeString(ADMIN_USERNAME) && 
        password === ADMIN_RI) { // RI do admin deve ser exato
        console.log(`Backend: Login bem-sucedido para usuário master: ${username}`);
        return res.status(200).json({ success: true, message: 'Login bem-sucedido como Administrador!', leaderName: username });
    }

    // 2. Se não for administrador, tenta autenticar como líder (usando cache)
    try {
        const responseData = await getMembrosWithCache();
        const membros = responseData.membros || [];
        
        if (!membros || !Array.isArray(membros) || membros.length === 0) {
            console.warn("Backend: Nenhuma lista de membros válida retornada ou a lista está vazia para autenticação.");
            return res.status(404).json({ success: false, message: 'Erro: Não foi possível carregar os dados de membros ou a lista está vazia para autenticação.' });
        }

        const usernameDigitadoNormalized = normalizeString(username);
        const passwordDigitado = String(password || '').trim(); // RI do usuário deve ser exato

        let membroEncontradoPeloNome = null;

        // **LÓGICA APRIMORADA PARA ENCONTRAR O MEMBRO PELO NOME**
        // Primeiro, tenta encontrar um nome completo ou quase completo para reduzir ambiguidades.
        // Depois, tenta encontrar por partes do nome.
        
        // 1. Tenta encontrar correspondência exata (normalizada)
        membroEncontradoPeloNome = membros.find(membro => 
            normalizeString(membro.Nome || '') === usernameDigitadoNormalized
        );

        // 2. Se não encontrou, tenta encontrar se o nome digitado é o início de um nome
        // Ex: "João S" deve encontrar "João Silva"
        if (!membroEncontradoPeloNome) {
            membroEncontradoPeloNome = membros.find(membro =>
                normalizeString(membro.Nome || '').startsWith(usernameDigitadoNormalized)
            );
        }

        // 3. Se ainda não encontrou, tenta encontrar se o nome digitado está contido no nome completo,
        // mas com uma verificação mais "forte" (ex: "Silva J" encontra "João Silva")
        if (!membroEncontradoPeloNome) {
            membroEncontradoPeloNome = membros.find(membro => {
                const nomeMembroNaPlanilhaNormalized = normalizeString(membro.Nome || '');
                const usernameWords = usernameDigitadoNormalized.split(' ').filter(w => w.length > 0);
                
                // Garante que todas as palavras do username estão no nome do membro
                return usernameWords.every(word => nomeMembroNaPlanilhaNormalized.includes(word));
            });
        }
        
        // **IMPORTANTE: Se múltiplas correspondências forem possíveis com a lógica flexível,
        // você pode precisar de uma etapa extra aqui para lidar com ambiguidade,
        // ou o primeiro match será o "escolhido". Para este cenário, o `find` já pega o primeiro.**


        if (membroEncontradoPeloNome) {
            console.log(`Backend Login: Membro encontrado pelo nome flexível: ${membroEncontradoPeloNome.Nome}`);
            // **Verifica a senha (RI) - DEVE SER EXATO**
            if (String(membroEncontradoPeloNome.RI || '').trim() === passwordDigitado) {
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
                        const dynamicPrefix = congregacaoAnyMember ? `${congregacaoAnyMember} | ` : '';

                        if (dynamicPrefix && liderNaPlanilhaCompleto.startsWith(dynamicPrefix)) {
                            nomeLiderExtraidoDoGrupo = liderNaPlanilhaCompleto.substring(dynamicPrefix.length).trim();
                        } else {
                            nomeLiderExtraidoDoGrupo = liderNaPlanilhaCompleto;
                        }

                        // Compara o nome normalizado do membro que está logando com o nome do líder extraído (também normalizado)
                        return normalizeString(nomeLiderExtraidoDoGrupo) === nomeDoMembroLogandoNormalized;
                        // Poderíamos usar uma lógica de "startsWith" aqui também se os nomes de líderes forem abreviados na planilha.
                        // Ex: `normalizeString(nomeLiderExtraidoDoGrupo).startsWith(nomeDoMembroLogandoNormalized)`
                        // ou a lógica de `every` se o nome do líder na planilha for abreviado mas as palavras batem.
                        // Mas para correspondência do nome do líder com o nome do membro, geralmente é mais exato.
                    });
                }
                
                console.log(`Backend Login: Resultado final - É líder? ${isLeaderByRole}`);

                if (isLeaderByRole) {
                    console.log(`Backend: Login bem-sucedido para o líder: ${membroEncontradoPeloNome.Nome}`);
                    return res.status(200).json({ success: true, message: `Login bem-sucedido, ${membroEncontradoPeloNome.Nome}!`, leaderName: membroEncontradoPeloNome.Nome });
                } else {
                    console.log(`Backend: Usuário '${username}' encontrado e senha correta, mas não tem o cargo/status de Líder ou não é líder de grupo.`);
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
        console.error("Backend: Erro FATAL ao tentar autenticar líder com Apps Script:", error.message);
        return res.status(500).json({ success: false, message: 'Erro interno do servidor ao autenticar.', details: error.message });
    }
});

app.get('/status', (req, res) => {
    res.status(200).json({ status: 'API está online e funcionando!', timestamp: new Date().toISOString() });
});

// Rota para obter as faltas (do Apps Script)
app.get('/get-faltas', async (req, res) => {
    try {
        // req.query passará os parâmetros (periodo, lider, gape, mes, ano) para o Apps Script
        const data = await fetchFromAppsScript('getFaltas', 'GET', null, req.query);
        res.status(200).json(data); // Apps Script retorna { success: true, data: {...}, totalMeetingDays: N }
    } catch (error) {
        console.error('Erro no backend ao obter faltas:', error.message);
        res.status(500).json({ success: false, message: 'Erro ao obter faltas.', details: error.message });
    }
});

app.listen(PORT, () => {
    console.log(`Servidor rodando na porta ${PORT}`);
    console.log(`CORS configurado para permitir requisições de: ${FRONTEND_URL}`);
    getMembrosWithCache().catch(err => console.error("Erro ao pré-carregar cache de membros na inicialização:", err.message));
});
