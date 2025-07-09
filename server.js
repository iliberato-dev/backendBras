// ------------------------------------------------------
// Backend Node.js (server.js) - SEM ALTERAÇÕES NECESSÁRIAS
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

app.use(cors({
    origin: FRONTEND_URL,
    methods: ['GET', 'POST', 'PUT', 'DELETE'],
    allowedHeaders: ['Content-Type', 'Authorization'],
}));

app.use(bodyParser.json());

// --- FUNÇÃO UTILITÁRIA PARA REQUISIÇÕES AO APPS SCRIPT ---
async function fetchFromAppsScript(actionType, method = 'GET', body = null, queryParams = {}) {
    if (!APPS_SCRIPT_URL) {
        console.error('Erro de configuração: Variável de ambiente APPS_SCRIPT_URL não definida.');
        throw new Error('Erro de configuração do servidor: URL do Apps Script não definida.');
    }

    let url = APPS_SCRIPT_URL;
    const urlParams = new URLSearchParams();

    if (method === 'GET') {
        urlParams.append('tipo', actionType);
        for (const key in queryParams) {
            if (queryParams.hasOwnProperty(key) && queryParams[key]) {
                urlParams.append(key, queryParams[key]);
            }
        }
        url = `${APPS_SCRIPT_URL}?${urlParams.toString()}`;
    } else if (method === 'POST') {
        if (actionType !== 'doPost') {
             urlParams.append('tipo', actionType);
             url = `${APPS_SCRIPT_URL}?${urlParams.toString()}`;
        } else {
             url = APPS_SCRIPT_URL;
        }
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
        console.error(`Backend: Erro ao parsear JSON do Apps Script: ${e.message}. Resposta bruta: ${responseText}`);
        responseData = { success: false, message: `Resposta inválida do Apps Script: ${responseText.substring(0, 100)}...`, details: e.message };
    }

    if (!response.ok || responseData.success === false) {
        console.error(`Backend: Erro lógico/HTTP do Apps Script (${actionType} ${method}): Status ${response.status} - Resposta: ${JSON.stringify(responseData)}`);
        throw new Error(responseData.message || 'Erro desconhecido do Apps Script.');
    }
    
    console.log(`Backend: Resposta bem-sucedida do Apps Script (${actionType} ${method}): ${JSON.stringify(responseData)}`);
    return responseData;
}

// --- ROTAS DA API ---

app.get('/get-membros', async (req, res) => {
    try {
        const data = await fetchFromAppsScript('getMembros');
        res.status(200).json(data);
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
        const responseData = await fetchFromAppsScript('doPost', 'POST', { nome, data, hora, sheet });
        res.status(200).json(responseData);
    } catch (error) {
        console.error('Erro no backend ao registrar presença:', error);
        if (error.message && error.message.includes("já foi registrada")) {
            return res.status(200).json({
                success: false,
                message: error.message,
                lastPresence: { data: data, hora: hora }
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
        console.error('Erro no backend ao obter presenças totais:', error);
        res.status(500).json({ success: false, message: 'Erro ao obter presenças totais.', details: error.message });
    }
});

app.get('/get-all-last-presences', async (req, res) => {
    try {
        const data = await fetchFromAppsScript('getLastPresencesForAllMembers');
        res.status(200).json(data.data || {});
    } catch (error) {
        console.error('Erro no backend ao obter todas as últimas presenças:', error);
        res.status(500).json({ success: false, message: 'Erro ao obter últimas presenças de todos os membros.', details: error.message });
    }
});

// --- NOVA ROTA ADICIONADA: Obter presenças detalhadas com filtros ---
app.get('/get-detailed-presences', async (req, res) => {
    try {
        const { startDate, endDate, memberName } = req.query;
        console.log(`Backend: Requisição de presenças detalhadas com filtros: startDate=${startDate}, endDate=${endDate}, memberName=${memberName}`);

        const queryParams = {
            startDate: startDate,
            endDate: endDate,
            memberName: memberName,
            // Passa os filtros do dashboard principal também
            mainFilterPeriodo: req.query.mainFilterPeriodo,
            mainFilterLider: req.query.mainFilterLider,
            mainFilterGape: req.query.mainFilterGape
        };

        const data = await fetchFromAppsScript('getDetailedPresences', 'GET', null, queryParams);
        res.status(200).json(data.data || []);
    } catch (error) {
        console.error('Erro no backend ao obter presenças detalhadas:', error);
        res.status(500).json({ success: false, message: 'Erro ao obter presenças detalhadas.', details: error.message });
    }
});

app.post("/login", async (req, res) => {
    const { username, password } = req.body;
    console.log(`Backend: Tentativa de login para usuário: "${username}" com senha: "${password}"`);

    const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
    const ADMIN_RI = process.env.ADMIN_RI || 'admin';

    if (username.toLowerCase() === ADMIN_USERNAME.toLowerCase() && password === ADMIN_RI) {
        console.log(`Backend: Login bem-sucedido para usuário master: ${username}`);
        return res.status(200).json({ success: true, message: 'Login bem-sucedido como Administrador!', leaderName: username });
    }

    try {
       const responseData = await fetchFromAppsScript('getMembros');
        // ESTA LINHA PRECISA SER ALTERADA:
        // const membros = responseData.membros || []; // <-- INCORRETO
        
        // MUDANÇA PARA:
        const membros = responseData.data.membros || []; // <-- CORRETO!

        console.log(`Backend Login: Membros recebidos do Apps Script: ${JSON.stringify(membros.map(m => m.Nome))}`);
        console.log(`Backend Login: Username digitado (normalizado): '${username.toLowerCase().trim()}'`);

        if (!membros || !Array.isArray(membros) || membros.length === 0) {
            console.warn("Backend: Nenhuma lista de membros válida retornada do Apps Script ou a lista está vazia para autenticação.");
            return res.status(404).json({ success: false, message: 'Erro: Não foi possível carregar os dados de membros ou a lista está vazia para autenticação.' });
        }

        const usernameDigitado = String(username || '').toLowerCase().trim();
        const usernameWords = usernameDigitado.split(' ').filter(word => word.length > 0);

        const membroEncontradoPeloNome = membros.find(membro => {
            const nomeMembroNaPlanilha = String(membro.Nome || '').toLowerCase().trim();
            console.log(`Backend Login: Comparando username '${usernameDigitado}' com Nome Membro: '${nomeMembroNaPlanilha}'`);
            // Verifica se todas as palavras do username digitado estão contidas no nome do membro
            const allWordsMatch = usernameWords.every(word => nomeMembroNaPlanilha.includes(word));
            return allWordsMatch;
        });

        if (membroEncontradoPeloNome) {
            console.log(`Backend Login: Membro encontrado pelo nome: ${membroEncontradoPeloNome.Nome}`);
            if (String(membroEncontradoPeloNome.RI).trim() === String(password).trim()) {
                console.log(`Backend Login: Senha (RI) correta para ${membroEncontradoPeloNome.Nome}.`);
                
                const cargoMembro = String(membroEncontradoPeloNome.Cargo || '').toLowerCase().trim();
                const statusMembro = String(membroEncontradoPeloNome.Status || '').toLowerCase().trim();
                
                let isLeaderByRole = false;

                // Verifica se o Cargo ou Status do próprio membro o qualifica como líder
                if (cargoMembro.includes('líder') || statusMembro.includes('líder')) {
                    isLeaderByRole = true;
                    console.log(`Backend Login: Membro '${membroEncontradoPeloNome.Nome}' é líder por Cargo/Status.`);
                }

                // Se não for líder por cargo/status, verifica se ele é listado como líder em algum grupo
                if (!isLeaderByRole) { 
                    const nomeDoMembroLogando = String(membroEncontradoPeloNome.Nome || '').toLowerCase().trim();
                    console.log(`Backend Login: Verificando se '${nomeDoMembroLogando}' aparece como líder em algum grupo...`);

                    isLeaderByRole = membros.some(anyMember => {
                        const liderNaPlanilhaCompleto = String(anyMember.Lider || '').toLowerCase().trim(); // Acesso via .Lider (mapeado)
                        const congregacaoAnyMember = String(anyMember.Congregacao || '').toLowerCase().trim(); // Acesso via .Congregacao (mapeado)

                        let nomeLiderExtraidoDoGrupo = '';
                        const dynamicPrefix = congregacaoAnyMember ? `${congregacaoAnyMember} | `.toLowerCase() : '';

                        if (dynamicPrefix && liderNaPlanilhaCompleto.startsWith(dynamicPrefix)) {
                            nomeLiderExtraidoDoGrupo = liderNaPlanilhaCompleto.substring(dynamicPrefix.length).trim();
                        } else {
                            nomeLiderExtraidoDoGrupo = liderNaPlanilhaCompleto;
                        }

                        const loggingMemberWords = nomeDoMembroLogando.split(' ').filter(word => word.length > 0);
                        const extractedLeaderWords = nomeLiderExtraidoDoGrupo.split(' ').filter(word => word.length > 0);

                        let isFuzzyMatch = false;

                        // Correspondência de palavras para nomes com múltiplos termos
                        if (loggingMemberWords.length > 0 && extractedLeaderWords.length > 0) {
                            const [shorterArr, longerArr] = loggingMemberWords.length <= extractedLeaderWords.length ?
                                [loggingMemberWords, extractedLeaderWords] :
                                [extractedLeaderWords, loggingMemberWords];

                            isFuzzyMatch = shorterArr.every((sWord, index) => {
                                return longerArr[index] && longerArr[index].startsWith(sWord);
                            });
                        }
                        
                        console.log(`Backend Login:    Comparando '${nomeDoMembroLogando}' com líder extraído: '${nomeLiderExtraidoDoGrupo}'. Fuzzy Match: ${isFuzzyMatch}`);
                        return isFuzzyMatch;
                    });
                }
                
                console.log(`Backend Login: Resultado final - É líder? ${isLeaderByRole}`);

                if (isLeaderByRole) {
                    console.log(`Backend: Login bem-sucedido para o líder: ${membroEncontradoPeloNome.Nome}`);
                    return res.status(200).json({ success: true, message: `Login bem-sucedido, ${membroEncontradoPeloNome.Nome}!`, leaderName: membroEncontradoPeloNome.Nome });
                } else {
                    console.log(`Backend: Usuário '${username}' encontrado e senha correta, mas não tem o cargo/status de Líder.`);
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

app.get('/status', (req, res) => {
    res.status(200).json({ status: 'API está online e funcionando!', timestamp: new Date().toISOString() });
});

app.listen(PORT, () => {
    console.log(`Servidor rodando na porta ${PORT}`);
    console.log(`CORS configurado para permitir requisições de: ${FRONTEND_URL}`);
});
