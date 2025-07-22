// ------------------------------------------------------
// Backend Node.js (server.js) - VERSÃO ATUALIZADA COM OTIMIZAÇÃO DE CACHE
// ------------------------------------------------------
require("dotenv").config();

const express = require("express");
const bodyParser = require("body-parser");
const cors = require("cors");
const fetch = require("node-fetch");
const multer = require("multer");
const path = require("path");
const fs = require("fs");

const app = express();
const PORT = process.env.PORT || 3000;

// --- CONFIGURAÇÃO DE URLs E CORS ---
const APPS_SCRIPT_URL = process.env.APPS_SCRIPT_URL;
const FRONTEND_URL = process.env.FRONTEND_URL;
const APPS_SCRIPT_AUTH_TOKEN = process.env.APPS_SCRIPT_AUTH_TOKEN;

const ADMIN_USERNAME = process.env.ADMIN_USERNAME;
const ADMIN_RI = process.env.ADMIN_RI;

// Configuração de CORS simples e direta
const allowedOrigins = [
  "http://127.0.0.1:5500",
  "http://localhost:5500",
  "http://localhost:3000",
  process.env.FRONTEND_URL,
].filter(Boolean);

console.log("FRONTEND_URL configurada:", process.env.FRONTEND_URL);
console.log("Origens permitidas:", allowedOrigins);

app.use(
  cors({
    origin: allowedOrigins,
    credentials: true,
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "Accept"],
    optionsSuccessStatus: 200,
  })
);
app.use(bodyParser.json({ limit: "10mb" })); // Aumenta limite para base64 de imagens

// --- CONFIGURAÇÃO DO MULTER PARA UPLOAD DE FOTOS ---
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    const uploadPath = path.join(__dirname, "uploads", "member-photos");
    // Garante que o diretório existe
    if (!fs.existsSync(uploadPath)) {
      fs.mkdirSync(uploadPath, { recursive: true });
    }
    cb(null, uploadPath);
  },
  filename: function (req, file, cb) {
    // Usa o nome do membro + timestamp para evitar conflitos
    const memberName = req.body.memberName || "unknown";
    const safeFileName = createSafeFileName(memberName);
    const extension = path.extname(file.originalname);
    cb(null, `${safeFileName}_${Date.now()}${extension}`);
  },
});

const upload = multer({
  storage: storage,
  limits: {
    fileSize: 5 * 1024 * 1024, // 5MB limite
  },
  fileFilter: function (req, file, cb) {
    // Aceita apenas imagens
    if (file.mimetype.startsWith("image/")) {
      cb(null, true);
    } else {
      cb(new Error("Apenas arquivos de imagem são permitidos!"), false);
    }
  },
});

// Servir arquivos estáticos das fotos
app.use("/uploads", express.static(path.join(__dirname, "uploads")));

// Servir arquivos estáticos do frontend
app.use(express.static(path.join(__dirname, "..", "frontendBras", "public")));

// --- ARMAZENAMENTO DAS FOTOS DOS MEMBROS ---
let memberPhotos = {}; // Armazena { "nomeDoMembro": "caminhoDoArquivo" }

// Função para criar nome seguro (deve ser igual no frontend e backend)
function createSafeFileName(name) {
  return name ? name.replace(/[^a-zA-Z0-9]/g, "_").toLowerCase() : "";
}

// Carrega fotos existentes ao iniciar o servidor
function loadExistingPhotos() {
  const photosPath = path.join(__dirname, "uploads", "member-photos");
  if (fs.existsSync(photosPath)) {
    const files = fs.readdirSync(photosPath);
    files.forEach((file) => {
      // Extrai o nome do membro do nome do arquivo (remove timestamp e extensão)
      if (file.match(/\.(jpg|jpeg|png|gif|webp)$/i)) {
        // Remove a extensão e o timestamp (últimos números após o último underscore)
        const nameWithoutExt = file.replace(/\.(jpg|jpeg|png|gif|webp)$/i, "");
        const memberName = nameWithoutExt.replace(/_\d+$/, ""); // Remove timestamp

        if (memberName) {
          memberPhotos[memberName] = `/uploads/member-photos/${file}`;
          console.log(`📸 Foto carregada: ${memberName} -> ${file}`);
        }
      }
    });
    console.log(
      `📸 Carregadas ${Object.keys(memberPhotos).length} fotos de membros`
    );
    console.log("🗂️ Fotos em memória:", memberPhotos);
  }
}

loadExistingPhotos();

// --- LÓGICA DE CACHE ---
let cachedMembros = null;
let lastMembrosFetchTime = 0;
const MEMBERS_CACHE_TTL = 5 * 60 * 1000; // Cache de 5 minutos

// NOVO: Variáveis de cache para as últimas presenças
let cachedLastPresences = null;
let lastPresencesFetchTime = 0;
const LAST_PRESENCES_CACHE_TTL = 2 * 60 * 1000; // Cache de 2 minutos para dados que mudam mais rápido

// NOVO: Cache para últimas atividades (registros de presença e remoções)
let ultimasAtividades = [];
const MAX_ATIVIDADES = 50; // Mantém apenas as 50 atividades mais recentes

// Função para adicionar nova atividade ao log
function adicionarAtividade(tipo, pessoa, grupo, detalhes = "") {
  const agora = new Date();
  const novaAtividade = {
    id: Date.now() + Math.random(), // ID único
    dataHora: agora.toLocaleDateString("pt-BR", {
      day: "2-digit",
      month: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    }),
    timestampCompleto: agora.toISOString(),
    tipo: tipo, // 'presenca_adicionada', 'presenca_removida', 'ausencia_marcada'
    pessoa: pessoa,
    grupo: grupo,
    status: obterStatusPorTipo(tipo),
    detalhes: detalhes,
  };

  // Adiciona no início da lista (mais recente primeiro)
  ultimasAtividades.unshift(novaAtividade);

  // Mantém apenas as atividades mais recentes
  if (ultimasAtividades.length > MAX_ATIVIDADES) {
    ultimasAtividades = ultimasAtividades.slice(0, MAX_ATIVIDADES);
  }

  console.log(`📝 Nova atividade registrada: ${tipo} - ${pessoa} (${grupo})`);
}

// Função helper para obter status baseado no tipo
function obterStatusPorTipo(tipo) {
  switch (tipo) {
    case "presenca_adicionada":
      return "Presente";
    case "presenca_removida":
      return "Presença Removida";
    case "ausencia_marcada":
      return "Ausente";
    default:
      return "Desconhecido";
  }
}

// --- FUNÇÃO UTILITÁRIA PARA REQUISIÇÕES AO APPS SCRIPT ---
async function fetchFromAppsScript(
  queryParams = {},
  method = "GET",
  body = null
) {
  if (!APPS_SCRIPT_URL || !APPS_SCRIPT_AUTH_TOKEN) {
    throw new Error(
      "Erro de configuração do servidor: URL ou Token do Apps Script não definidos."
    );
  }

  const url = new URL(APPS_SCRIPT_URL);
  const requestBody = { ...body, auth_token: APPS_SCRIPT_AUTH_TOKEN };

  Object.keys(queryParams).forEach((key) =>
    url.searchParams.append(key, queryParams[key])
  );
  if (method === "GET") {
    url.searchParams.append("auth_token", APPS_SCRIPT_AUTH_TOKEN);
  }

  const options = {
    method: method,
    headers: { "Content-Type": "application/json" },
    body: method !== "GET" ? JSON.stringify(requestBody) : undefined,
  };

  try {
    const response = await fetch(url.toString(), options);
    const responseText = await response.text();
    if (!response.ok) {
      throw new Error(
        `Erro do Apps Script (Status ${response.status}): ${responseText}`
      );
    }

    const data = JSON.parse(responseText);
    if (data.success === false) {
      throw new Error(
        data.message || "Erro desconhecido retornado pelo Apps Script."
      );
    }
    return data;
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(
        "Resposta inválida do Apps Script (não é JSON). O script pode ter travado."
      );
    }
    throw error;
  }
}

async function getMembrosWithCache() {
  if (cachedMembros && Date.now() - lastMembrosFetchTime < MEMBERS_CACHE_TTL) {
    console.log("Backend: Retornando membros do cache.");
    return { success: true, membros: cachedMembros };
  }
  console.log("Backend: Buscando membros do Apps Script.");
  const data = await fetchFromAppsScript({ tipo: "getMembros" });
  if (data.success) {
    cachedMembros = data.membros;
    lastMembrosFetchTime = Date.now();
  }
  return data;
}

// NOVO: Função de cache para últimas presenças
async function getLastPresencesWithCache() {
  if (
    cachedLastPresences &&
    Date.now() - lastPresencesFetchTime < LAST_PRESENCES_CACHE_TTL
  ) {
    console.log("Backend: Retornando últimas presenças do cache.");
    return { success: true, data: cachedLastPresences };
  }
  console.log("Backend: Buscando últimas presenças do Apps Script.");
  const data = await fetchFromAppsScript({
    tipo: "getLastPresencesForAllMembers",
  });
  if (data.success) {
    cachedLastPresences = data.data;
    lastPresencesFetchTime = Date.now();
  }
  return data;
}

function normalizeString(str) {
  if (typeof str !== "string") return "";
  return str
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim();
}

// --- ROTAS DA API ---

app.get("/get-membros", async (req, res) => {
  try {
    const data = await getMembrosWithCache();

    // Adiciona URLs das fotos aos dados dos membros
    if (data.success && (data.data || data.membros)) {
      console.log("🔍 Processando fotos para membros...");
      console.log("📂 Fotos disponíveis:", Object.keys(memberPhotos));
      console.log("📊 Estrutura dos dados recebidos:", {
        success: data.success,
        hasData: !!data.data,
        hasMembros: !!data.membros,
        dataLength: data.data ? data.data.length : 0,
        membrosLength: data.membros ? data.membros.length : 0,
      });

      // Verifica qual campo contém os membros
      const membersArray = data.data || data.membros;

      if (membersArray && Array.isArray(membersArray)) {
        console.log(`📋 Processando ${membersArray.length} membros...`);

        const updatedMembers = membersArray.map((member) => {
          const safeFileName = createSafeFileName(member.Nome);
          const photoUrl = memberPhotos[safeFileName];

          console.log(
            `👤 ${member.Nome} -> safeFileName: "${safeFileName}" -> foto: ${
              photoUrl || "não encontrada"
            }`
          );

          return {
            ...member,
            FotoURL: photoUrl
              ? `${req.protocol}://${req.get("host")}${photoUrl}`
              : member.FotoURL,
          };
        });

        // Atualiza o campo correto
        if (data.data) {
          data.data = updatedMembers;
        } else {
          data.membros = updatedMembers;
        }

        console.log("✅ Fotos processadas e anexadas aos membros");
      } else {
        console.log(
          "❌ Nenhum array de membros encontrado para processar fotos"
        );
      }
    } else {
      console.log("❌ Dados inválidos ou ausentes para processamento de fotos");
    }

    res.status(200).json(data);
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ROTA ATUALIZADA para usar o novo cache
app.get("/get-all-last-presences", async (req, res) => {
  try {
    const data = await getLastPresencesWithCache();
    res.status(200).json(data);
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

app.get("/get-presencas-total", async (req, res) => {
  try {
    const data = await fetchFromAppsScript({
      tipo: "presencasTotal",
      ...req.query,
    });
    res.status(200).json(data);
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

app.get("/presences/:memberName", async (req, res) => {
  try {
    const { memberName } = req.params;
    const data = await fetchFromAppsScript({
      tipo: "getPresencesByMember",
      nome: memberName,
      ...req.query,
    });
    res.status(200).json(data);
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// NOVA ROTA para estatísticas do dashboard
app.get("/dashboard-stats", async (req, res) => {
  try {
    const { mes, grupo } = req.query;
    console.log("🎯 Buscando dados do dashboard para:", { mes, grupo });

    // Vamos usar dados reais diretamente dos membros e presenças
    try {
      console.log("📊 Buscando dados reais dos membros e presenças...");

      // Buscar membros reais
      const membrosData = await getMembrosWithCache();
      if (!membrosData.success || !membrosData.membros) {
        throw new Error("Falha ao buscar dados dos membros");
      }

      // Buscar presenças reais
      const presencasData = await getLastPresencesWithCache();
      if (!presencasData.success) {
        throw new Error("Falha ao buscar dados de presenças");
      }

      console.log("✅ Dados reais obtidos, gerando estatísticas...");

      // Gerar estatísticas com dados reais
      const dashboardStats = await gerarEstatisticasReais(
        membrosData.membros,
        presencasData.data || {},
        mes,
        grupo
      );

      return res.status(200).json({
        success: true,
        data: dashboardStats,
      });
    } catch (error) {
      console.log("❌ Erro ao buscar dados reais:", error.message);
      console.log("🔄 Usando dados simulados como fallback");

      // Fallback para dados simulados
      const dadosSimulados = await gerarDadosSimuladosDashboard(mes, grupo);

      res.status(200).json({
        success: true,
        data: dadosSimulados,
      });
    }
  } catch (error) {
    console.error("❌ Erro geral ao buscar estatísticas do dashboard:", error);
    res.status(500).json({
      success: false,
      message: "Erro ao buscar estatísticas do dashboard",
      error: error.message,
    });
  }
});

// Função para gerar estatísticas reais baseadas nos dados dos membros e presenças
async function gerarEstatisticasReais(membros, presencas, mes, grupo) {
  try {
    console.log("🔍 Gerando estatísticas reais...");
    console.log(`📊 ${membros.length} membros encontrados`);
    console.log(`📅 ${Object.keys(presencas).length} registros de presença`);

    // Extrair grupos únicos dos dados reais (usar GAPE como grupo principal)
    const gruposUnicos = [
      ...new Set(membros.map((m) => m.GAPE).filter(Boolean)),
    ].sort();

    console.log(`🏷️ ${gruposUnicos.length} grupos únicos encontrados:`);
    gruposUnicos.slice(0, 5).forEach((g) => console.log(`   - ${g}`));
    if (gruposUnicos.length > 5) {
      console.log(`   ... e mais ${gruposUnicos.length - 5} grupos`);
    }

    // *** APLICAR FILTRO DE GRUPO ***
    let membrosFiltrados = membros;
    let gruposFiltrados = gruposUnicos;

    if (grupo && grupo.trim() !== "") {
      console.log(`🎯 Aplicando filtro de grupo: "${grupo}"`);
      membrosFiltrados = membros.filter((m) => m.GAPE === grupo);
      gruposFiltrados = [grupo]; // Só mostrar o grupo selecionado
      console.log(
        `📊 Após filtro de grupo: ${membrosFiltrados.length} membros`
      );
    } else {
      console.log("📊 Sem filtro de grupo - mostrando todos os grupos");
    }

    // *** APLICAR FILTRO DE MÊS (para dados de presença) ***
    let filtroMes = null;
    let prefixoMes = "";
    if (mes && mes.trim() !== "") {
      const meses = {
        1: "Janeiro",
        2: "Fevereiro",
        3: "Março",
        4: "Abril",
        5: "Maio",
        6: "Junho",
        7: "Julho",
        8: "Agosto",
        9: "Setembro",
        10: "Outubro",
        11: "Novembro",
        12: "Dezembro",
      };
      prefixoMes = meses[mes] || `Mês ${mes}`;
      filtroMes = parseInt(mes);
      console.log(`📅 Aplicando filtro de mês: ${prefixoMes} (${filtroMes})`);
    } else {
      console.log("📅 Sem filtro de mês - mostrando dados de todos os meses");
    }

    const totalPessoas = membrosFiltrados.length;
    const totalGrupos = gruposFiltrados.length;

    // Gerar estatísticas reais por grupo
    const estatisticasPorGrupo = [];
    let totalPresencasGeral = 0;
    let totalMembrosComPresenca = 0;

    for (const nomeGrupo of gruposFiltrados) {
      const membrosDoGrupo = membrosFiltrados.filter(
        (m) => m.GAPE === nomeGrupo
      );

      let presencasDoGrupo = 0;
      let membrosComPresencaNoGrupo = 0;

      // Contar presenças reais para este grupo
      for (const membro of membrosDoGrupo) {
        const presencaMembro = presencas[membro.Nome];
        if (
          presencaMembro &&
          presencaMembro.data &&
          presencaMembro.data !== "N/A"
        ) {
          const dataPresenca = presencaMembro.data;

          // Se há filtro de mês, verificar se a presença é do mês correto
          if (filtroMes) {
            try {
              const [dia, mesPresenca, ano] = dataPresenca.split("/");
              if (parseInt(mesPresenca) === filtroMes) {
                presencasDoGrupo++;
                membrosComPresencaNoGrupo++;
              }
            } catch (error) {
              console.log(`⚠️ Erro ao processar data: ${dataPresenca}`);
            }
          } else {
            // Sem filtro de mês, contar todas as presenças
            presencasDoGrupo++;
            membrosComPresencaNoGrupo++;
          }
        }
      }

      const totalMembrosGrupo = membrosDoGrupo.length;
      const presencaPercentual =
        totalMembrosGrupo > 0
          ? Math.round((membrosComPresencaNoGrupo / totalMembrosGrupo) * 100)
          : 0;

      estatisticasPorGrupo.push({
        nome: nomeGrupo,
        totalMembros: totalMembrosGrupo,
        presencaPercentual: presencaPercentual,
        presencas: membrosComPresencaNoGrupo,
        presencasReais: presencasDoGrupo,
      });

      totalPresencasGeral += presencasDoGrupo;
      totalMembrosComPresenca += membrosComPresencaNoGrupo;
    }

    // Ordenar grupos por presença (melhor para pior)
    estatisticasPorGrupo.sort(
      (a, b) => b.presencaPercentual - a.presencaPercentual
    );

    console.log("📊 Estatísticas reais por grupo (top 5):");
    estatisticasPorGrupo.slice(0, 5).forEach((grupo) => {
      console.log(
        `   ${grupo.nome}: ${grupo.presencaPercentual}% (${grupo.presencas}/${grupo.totalMembros})`
      );
    });

    // Encontrar melhor e pior grupo
    const melhorGrupo = estatisticasPorGrupo[0] || {
      nome: "N/A",
      presencaPercentual: 0,
    };

    const piorGrupo = estatisticasPorGrupo[estatisticasPorGrupo.length - 1] || {
      nome: "N/A",
      presencaPercentual: 0,
    };

    // Presença média geral
    const presencaMedia =
      estatisticasPorGrupo.length > 0
        ? Math.round(
            estatisticasPorGrupo.reduce(
              (acc, g) => acc + g.presencaPercentual,
              0
            ) / estatisticasPorGrupo.length
          )
        : 0;

    // Gerar últimos registros baseados em atividades reais e dados de presença
    let ultimosRegistros = [];

    // Primeiro, adicionar atividades registradas no sistema (presenças e remoções)
    const atividadesFiltradas = ultimasAtividades
      .filter((atividade) => {
        if (!grupo || grupo.trim() === "") return true; // Sem filtro de grupo
        return atividade.grupo === grupo; // Com filtro de grupo
      })
      .slice(0, 10); // Pegar até 10 atividades

    ultimosRegistros = atividadesFiltradas.map((atividade) => ({
      dataHora: atividade.dataHora,
      grupo: atividade.grupo,
      pessoa: atividade.pessoa,
      status: atividade.status,
      tipo: atividade.tipo,
      detalhes: atividade.detalhes,
    }));

    // Se não temos atividades suficientes, complementar com dados de presença
    if (ultimosRegistros.length < 5) {
      const membrosComPresencaRecente = Object.entries(presencas)
        .filter(([nome, dados]) => dados.data && dados.data !== "N/A")
        .sort((a, b) => {
          // Tentar ordenar por data mais recente (isso é uma aproximação)
          return b[1].data.localeCompare(a[1].data);
        })
        .slice(0, 5 - ultimosRegistros.length);

      for (const [nomeMembro, dadosPresenca] of membrosComPresencaRecente) {
        const membro = membrosFiltrados.find((m) => m.Nome === nomeMembro);
        if (membro && (!grupo || membro.GAPE === grupo)) {
          // Verificar se já não existe uma atividade para esta pessoa
          const jaExiste = ultimosRegistros.some(
            (r) => r.pessoa === nomeMembro
          );
          if (!jaExiste) {
            ultimosRegistros.push({
              dataHora: dadosPresenca.data + " " + (dadosPresenca.hora || ""),
              grupo: membro.GAPE || "N/A",
              pessoa: nomeMembro,
              status: "Presente",
              tipo: "presenca_adicionada",
              detalhes: "Registro de presença",
            });
          }
        }
      }
    }

    // Ordenar por timestamp se disponível, senão por dataHora
    ultimosRegistros.sort((a, b) => {
      return b.dataHora.localeCompare(a.dataHora);
    });

    // Limitar a 5 registros mais recentes
    ultimosRegistros = ultimosRegistros.slice(0, 5);

    console.log(
      `🏆 Melhor grupo: ${melhorGrupo.nome} (${melhorGrupo.presencaPercentual}%)`
    );
    console.log(
      `⚠️ Pior grupo: ${piorGrupo.nome} (${piorGrupo.presencaPercentual}%)`
    );
    console.log(`📊 Presença média geral: ${presencaMedia}%`);
    console.log(
      `📝 ${ultimosRegistros.length} últimos registros processados (${
        atividadesFiltradas.length
      } atividades + ${
        ultimosRegistros.length - atividadesFiltradas.length
      } presenças)`
    );

    // *** LÓGICA ESPECIAL QUANDO UM GRUPO ESPECÍFICO É SELECIONADO ***
    let melhorCard, piorCard;

    if (grupo && grupo.trim() !== "") {
      // Quando um grupo específico é selecionado, mostrar estatísticas individuais dos membros
      console.log(
        `🎯 Grupo específico selecionado: "${grupo}" - Calculando estatísticas individuais`
      );

      // Calcular presenças e faltas por membro do grupo selecionado
      const estatisticasMembros = [];

      for (const membro of membrosFiltrados) {
        const presencaMembro = presencas[membro.Nome];
        let temPresenca = false;
        let dataPresencaValida = false;

        if (
          presencaMembro &&
          presencaMembro.data &&
          presencaMembro.data !== "N/A"
        ) {
          const dataPresenca = presencaMembro.data;

          // Verificar se a presença é válida para o filtro de mês
          if (filtroMes) {
            try {
              const [dia, mesPresenca, ano] = dataPresenca.split("/");
              if (parseInt(mesPresenca) === filtroMes) {
                temPresenca = true;
                dataPresencaValida = true;
              }
            } catch (error) {
              console.log(
                `⚠️ Erro ao processar data do membro ${membro.Nome}: ${dataPresenca}`
              );
            }
          } else {
            // Sem filtro de mês, considerar todas as presenças
            temPresenca = true;
            dataPresencaValida = true;
          }
        }

        estatisticasMembros.push({
          nome: membro.Nome,
          grupo: membro.GAPE,
          temPresenca: temPresenca,
          dataPresencaValida: dataPresencaValida,
          dataPresenca: presencaMembro?.data || "N/A",
          horaPresenca: presencaMembro?.hora || "",
        });
      }

      // Separar membros com presença e sem presença
      const membrosComPresenca = estatisticasMembros.filter(
        (m) => m.temPresenca
      );
      const membrosSemPresenca = estatisticasMembros.filter(
        (m) => !m.temPresenca
      );

      console.log(`👥 Membros do grupo ${grupo}:`);
      console.log(`   ✅ Com presença: ${membrosComPresenca.length}`);
      console.log(`   ❌ Sem presença: ${membrosSemPresenca.length}`);

      // Card "Melhor em Presenças" (membro com presença mais recente ou primeiro da lista)
      if (membrosComPresenca.length > 0) {
        const melhorMembro = membrosComPresenca[0]; // Poderia ordenar por data se necessário
        melhorCard = {
          tipo: "membro_presenca",
          nome: melhorMembro.nome,
          percentual: 100, // Presente
          detalhes: `Última presença: ${melhorMembro.dataPresenca}`,
          grupo: melhorMembro.grupo,
        };
        console.log(
          `🏆 Melhor em presenças: ${melhorMembro.nome} (${melhorMembro.dataPresenca})`
        );
      } else {
        melhorCard = {
          tipo: "membro_presenca",
          nome: "Nenhum membro presente",
          percentual: 0,
          detalhes: "Nenhuma presença registrada",
          grupo: grupo,
        };
        console.log(`🏆 Nenhum membro com presença no grupo ${grupo}`);
      }

      // Card "Membro com Mais Faltas" (membro sem presença)
      if (membrosSemPresenca.length > 0) {
        const piorMembro = membrosSemPresenca[0]; // Primeiro da lista de ausentes
        piorCard = {
          tipo: "membro_falta",
          nome: piorMembro.nome,
          percentual: 0, // Ausente
          detalhes: "Sem presença registrada",
          grupo: piorMembro.grupo,
        };
        console.log(`⚠️ Membro com mais faltas: ${piorMembro.nome}`);
      } else {
        piorCard = {
          tipo: "membro_falta",
          nome: "Todos presentes",
          percentual: 100,
          detalhes: "Nenhuma falta registrada",
          grupo: grupo,
        };
        console.log(`⚠️ Todos os membros do grupo ${grupo} estão presentes`);
      }
    } else {
      // Quando nenhum grupo específico é selecionado, usar lógica de grupos
      melhorCard = {
        tipo: "grupo",
        nome: melhorGrupo.nome,
        percentual: melhorGrupo.presencaPercentual,
        detalhes: "Melhor grupo por presença",
        grupo: melhorGrupo.nome,
      };

      piorCard = {
        tipo: "grupo",
        nome: piorGrupo.nome,
        percentual: piorGrupo.presencaPercentual,
        detalhes: "Pior grupo por presença",
        grupo: piorGrupo.nome,
      };
    }

    const resultado = {
      totalPessoas,
      totalGrupos,
      presencaMedia,
      melhorGrupo: melhorCard, // Agora pode ser grupo ou membro
      piorGrupo: piorCard, // Agora pode ser grupo ou membro
      grupos: estatisticasPorGrupo,
      ultimosRegistros: ultimosRegistros,
      filtros: {
        mes: mes || "todos",
        grupo: grupo || "todos",
        mesNome: prefixoMes || "Todos os meses",
        grupoNome: grupo || "Todos os grupos", // ✅ NOVO: Nome do grupo para o título
        aplicados: Boolean(mes || grupo),
        grupoEspecifico: Boolean(grupo && grupo.trim() !== ""), // ✅ NOVO: Flag para saber se é grupo específico
      },
      isSimulated: false, // ✅ DADOS REAIS!
    };

    console.log("✅ Estatísticas reais geradas com sucesso:", {
      totalPessoas: resultado.totalPessoas,
      totalGrupos: resultado.totalGrupos,
      presencaMedia: resultado.presencaMedia,
      filtros: resultado.filtros,
      isSimulated: resultado.isSimulated,
    });

    return resultado;
  } catch (error) {
    console.error("❌ Erro ao gerar estatísticas reais:", error);
    throw error;
  }
}

// Função para gerar dados simulados como fallback
async function gerarDadosSimuladosDashboard(mes, grupo) {
  try {
    console.log("🎯 Gerando dados simulados com filtros:", { mes, grupo });

    // Tentar buscar dados reais dos membros
    let membros = [];
    try {
      const membrosData = await getMembrosWithCache();
      membros = membrosData.membros || [];
      console.log(`📊 ${membros.length} membros encontrados no sistema`);
    } catch (error) {
      console.log("⚠️ Não foi possível buscar membros reais, usando simulados");
      membros = [
        { Nome: "João Silva", GAPE: "0001 - Grupo Alpha", Lider: "Líder A" },
        { Nome: "Maria Santos", GAPE: "0002 - Grupo Beta", Lider: "Líder B" },
        { Nome: "Pedro Costa", GAPE: "0001 - Grupo Alpha", Lider: "Líder A" },
        { Nome: "Ana Oliveira", GAPE: "0003 - Grupo Gamma", Lider: "Líder C" },
        { Nome: "Carlos Lima", GAPE: "0002 - Grupo Beta", Lider: "Líder B" },
        { Nome: "Sandra Torres", GAPE: "0004 - Grupo Delta", Lider: "Líder D" },
        {
          Nome: "Roberto Silva",
          GAPE: "0005 - Grupo Epsilon",
          Lider: "Líder E",
        },
      ];
    }

    // Extrair grupos únicos dos dados reais (usar GAPE como grupo principal)
    const gruposUnicos = [
      ...new Set(membros.map((m) => m.GAPE).filter(Boolean)),
    ];

    console.log(`🏷️ Grupos únicos encontrados: ${gruposUnicos.length}`);
    gruposUnicos.forEach((g) => console.log(`   - ${g}`));

    // Se não houver grupos, usar simulados
    const todosGrupos =
      gruposUnicos.length > 0
        ? gruposUnicos
        : [
            "0001 - Grupo Alpha",
            "0002 - Grupo Beta",
            "0003 - Grupo Gamma",
            "0004 - Grupo Delta",
            "0005 - Grupo Epsilon",
          ];

    // *** APLICAR FILTRO DE GRUPO ***
    let membrosFiltrados = membros;
    let gruposFiltrados = todosGrupos;

    if (grupo && grupo.trim() !== "") {
      console.log(`🎯 Aplicando filtro de grupo: "${grupo}"`);
      membrosFiltrados = membros.filter((m) => m.GAPE === grupo);
      gruposFiltrados = [grupo]; // Só mostrar o grupo selecionado
      console.log(
        `📊 Após filtro de grupo: ${membrosFiltrados.length} membros, 1 grupo`
      );
    } else {
      console.log("📊 Sem filtro de grupo - mostrando todos os grupos");
    }

    // *** APLICAR FILTRO DE MÊS ***
    let prefixoMes = "";
    if (mes && mes.trim() !== "") {
      const meses = {
        1: "Janeiro",
        2: "Fevereiro",
        3: "Março",
        4: "Abril",
        5: "Maio",
        6: "Junho",
        7: "Julho",
        8: "Agosto",
        9: "Setembro",
        10: "Outubro",
        11: "Novembro",
        12: "Dezembro",
      };
      prefixoMes = meses[mes] || `Mês ${mes}`;
      console.log(`📅 Aplicando filtro de mês: ${prefixoMes}`);

      // Simular que no mês filtrado há menos atividade
      // (na prática, isso viria dos dados reais de presença)
      console.log("📉 Simulando dados específicos para o mês selecionado");
    } else {
      console.log("📅 Sem filtro de mês - mostrando dados gerais");
    }

    const totalPessoas = membrosFiltrados.length;
    const totalGrupos = gruposFiltrados.length;

    // Gerar estatísticas simuladas por grupo (baseado nos grupos filtrados)
    const estatisticasPorGrupo = gruposFiltrados.map((nomeGrupo) => {
      const membrosDoGrupo = membrosFiltrados.filter(
        (m) => m.GAPE === nomeGrupo
      );

      // Variar presença baseado no mês (se filtrado)
      let basePresenca = 85; // Base de 85%
      if (mes) {
        // Simular variação sazonal
        const mesNum = parseInt(mes);
        if (mesNum >= 6 && mesNum <= 8) {
          // Férias (Jun-Ago)
          basePresenca = 65;
        } else if (mesNum === 12 || mesNum === 1) {
          // Dezembro/Janeiro
          basePresenca = 70;
        } else {
          basePresenca = 88; // Períodos normais
        }
      }

      const presencaPercentual = Math.floor(
        basePresenca + Math.random() * 20 - 10
      ); // ±10% de variação
      const clampedPresenca = Math.max(50, Math.min(100, presencaPercentual)); // Entre 50-100%

      const totalMembrosGrupo =
        membrosDoGrupo.length || Math.floor(Math.random() * 20 + 10);

      return {
        nome: nomeGrupo,
        totalMembros: totalMembrosGrupo,
        presencaPercentual: clampedPresenca,
        presencas: Math.floor((totalMembrosGrupo * clampedPresenca) / 100),
      };
    });

    console.log("📊 Estatísticas por grupo geradas:");
    estatisticasPorGrupo.forEach((grupo) => {
      console.log(
        `   ${grupo.nome}: ${grupo.presencaPercentual}% (${grupo.presencas}/${grupo.totalMembros})`
      );
    });

    // Encontrar melhor e pior grupo (baseado nos dados filtrados)
    const grupoPorPresenca = estatisticasPorGrupo.sort(
      (a, b) => b.presencaPercentual - a.presencaPercentual
    );

    const melhorGrupo = grupoPorPresenca[0] || {
      nome: "N/A",
      presencaPercentual: 0,
    };

    const piorGrupo = grupoPorPresenca[grupoPorPresenca.length - 1] || {
      nome: "N/A",
      presencaPercentual: 0,
    };

    console.log(
      `🏆 Melhor grupo: ${melhorGrupo.nome} (${melhorGrupo.presencaPercentual}%)`
    );
    console.log(
      `⚠️ Pior grupo: ${piorGrupo.nome} (${piorGrupo.presencaPercentual}%)`
    );

    // Presença média geral (baseado nos grupos filtrados)
    const presencaMedia =
      estatisticasPorGrupo.length > 0
        ? Math.round(
            estatisticasPorGrupo.reduce(
              (acc, g) => acc + g.presencaPercentual,
              0
            ) / estatisticasPorGrupo.length
          )
        : 0;

    console.log(`📊 Presença média geral: ${presencaMedia}%`);

    // Últimos registros simulados com nomes reais se disponíveis (filtrados)
    const ultimosRegistros = [];
    const nomesMembros =
      membrosFiltrados.length > 0
        ? membrosFiltrados.map((m) => m.Nome)
        : [
            "João Silva",
            "Maria Costa",
            "Pedro Santos",
            "Ana Oliveira",
            "Carlos Lima",
          ];

    const tiposStatus = [
      { status: "Presente", tipo: "presenca_adicionada", peso: 70 },
      { status: "Presença Removida", tipo: "presenca_removida", peso: 20 },
      { status: "Ausente", tipo: "ausencia_marcada", peso: 10 },
    ];

    const registrosParaMostrar = Math.min(5, nomesMembros.length);
    for (let i = 0; i < registrosParaMostrar; i++) {
      const agora = new Date();
      const tempoAtras = new Date(agora.getTime() - i * 3 * 60 * 1000); // 3 minutos atrás cada

      const grupoDoRegistro = grupo
        ? grupo
        : gruposFiltrados[i % gruposFiltrados.length];

      // Selecionar status baseado no peso (mais presenças que remoções)
      const rand = Math.random() * 100;
      let statusSelecionado = tiposStatus[0]; // Default: Presente
      let acumulado = 0;
      for (const tipoStatus of tiposStatus) {
        acumulado += tipoStatus.peso;
        if (rand <= acumulado) {
          statusSelecionado = tipoStatus;
          break;
        }
      }

      ultimosRegistros.push({
        dataHora: tempoAtras.toLocaleDateString("pt-BR", {
          day: "2-digit",
          month: "2-digit",
          hour: "2-digit",
          minute: "2-digit",
        }),
        grupo: grupoDoRegistro,
        pessoa: nomesMembros[i],
        status: statusSelecionado.status,
        tipo: statusSelecionado.tipo,
        detalhes: "Registro simulado",
      });
    }

    console.log(`📝 ${ultimosRegistros.length} últimos registros gerados`);

    // *** LÓGICA ESPECIAL QUANDO UM GRUPO ESPECÍFICO É SELECIONADO ***
    let melhorCard, piorCard;

    if (grupo && grupo.trim() !== "") {
      // Quando um grupo específico é selecionado, simular estatísticas individuais dos membros
      console.log(
        `🎯 Grupo específico selecionado: "${grupo}" - Simulando estatísticas individuais`
      );

      const membrosDoGrupoSelecionado = membrosFiltrados.filter(
        (m) => m.GAPE === grupo
      );

      if (membrosDoGrupoSelecionado.length > 0) {
        // Simular "melhor membro" com presença
        const melhorMembro = membrosDoGrupoSelecionado[0];
        melhorCard = {
          tipo: "membro_presenca",
          nome: melhorMembro.Nome,
          percentual: Math.floor(Math.random() * 20 + 80), // 80-100%
          detalhes: "Membro mais assíduo",
          grupo: grupo,
        };

        // Simular "membro com mais faltas"
        const piorMembro =
          membrosDoGrupoSelecionado[
            Math.floor(Math.random() * membrosDoGrupoSelecionado.length)
          ];
        piorCard = {
          tipo: "membro_falta",
          nome: piorMembro.Nome,
          percentual: Math.floor(Math.random() * 30 + 10), // 10-40%
          detalhes: "Membro com mais faltas",
          grupo: grupo,
        };
      } else {
        // Fallback se não houver membros
        melhorCard = {
          tipo: "membro_presenca",
          nome: "João Silva",
          percentual: 95,
          detalhes: "Membro mais assíduo",
          grupo: grupo,
        };

        piorCard = {
          tipo: "membro_falta",
          nome: "Maria Costa",
          percentual: 25,
          detalhes: "Membro com mais faltas",
          grupo: grupo,
        };
      }

      console.log(
        `🏆 Melhor membro simulado: ${melhorCard.nome} (${melhorCard.percentual}%)`
      );
      console.log(
        `⚠️ Membro com mais faltas simulado: ${piorCard.nome} (${piorCard.percentual}%)`
      );
    } else {
      // Quando nenhum grupo específico é selecionado, usar lógica de grupos
      melhorCard = {
        tipo: "grupo",
        nome: melhorGrupo.nome,
        percentual: melhorGrupo.presencaPercentual,
        detalhes: "Melhor grupo por presença",
        grupo: melhorGrupo.nome,
      };

      piorCard = {
        tipo: "grupo",
        nome: piorGrupo.nome,
        percentual: piorGrupo.presencaPercentual,
        detalhes: "Pior grupo por presença",
        grupo: piorGrupo.nome,
      };
    }

    const resultado = {
      totalPessoas,
      totalGrupos,
      presencaMedia,
      melhorGrupo: melhorCard, // Agora pode ser grupo ou membro
      piorGrupo: piorCard, // Agora pode ser grupo ou membro
      grupos: estatisticasPorGrupo,
      ultimosRegistros,
      filtros: {
        mes: mes || "todos",
        grupo: grupo || "todos",
        mesNome: prefixoMes || "Todos os meses",
        grupoNome: grupo || "Todos os grupos", // ✅ NOVO: Nome do grupo para o título
        aplicados: Boolean(mes || grupo),
        grupoEspecifico: Boolean(grupo && grupo.trim() !== ""), // ✅ NOVO: Flag para saber se é grupo específico
      },
      isSimulated: true, // Flag para indicar que são dados simulados
    };

    console.log("✅ Dados simulados gerados com sucesso:", {
      totalPessoas: resultado.totalPessoas,
      totalGrupos: resultado.totalGrupos,
      presencaMedia: resultado.presencaMedia,
      filtros: resultado.filtros,
    });

    return resultado;
  } catch (error) {
    console.error("❌ Erro ao gerar dados simulados:", error);
    // Retorno completamente simulado em caso de erro
    return {
      totalPessoas: 235,
      totalGrupos: 12,
      presencaMedia: 87,
      melhorGrupo: { nome: "Grupo A", percentual: 95 },
      piorGrupo: { nome: "Grupo F", percentual: 65 },
      grupos: [
        { nome: "Grupo A", totalMembros: 25, presencaPercentual: 95 },
        { nome: "Grupo B", totalMembros: 22, presencaPercentual: 88 },
        { nome: "Grupo C", totalMembros: 20, presencaPercentual: 82 },
      ],
      ultimosRegistros: [
        {
          dataHora: "22/07 08:10",
          grupo: "Grupo A",
          pessoa: "João Silva",
          status: "Presente",
        },
      ],
      filtros: { mes: mes || "todos", grupo: grupo || "todos" },
      isSimulated: true,
    };
  }
}

// Função para processar estatísticas
function processarEstatisticas(membros, presencaData, mes, grupo) {
  const grupos = [...new Set(membros.map((m) => m.Grupo).filter(Boolean))];

  // Filtrar membros por grupo se especificado
  const membrosFiltrados = grupo
    ? membros.filter((m) => m.Grupo === grupo)
    : membros;

  // Calcular estatísticas básicas
  const totalPessoas = membrosFiltrados.length;
  const totalGrupos = grupos.length;

  // Estatísticas por grupo
  const estatisticasPorGrupo = grupos.map((nomeGrupo) => {
    const membrosDoGrupo = membros.filter((m) => m.Grupo === nomeGrupo);
    const presencas = presencaData.presencas || [];

    // Calcular presença do grupo (exemplo simples)
    const presencaGrupo = Math.floor(Math.random() * 40 + 60); // Temporário - substituir por dados reais

    return {
      nome: nomeGrupo,
      totalMembros: membrosDoGrupo.length,
      presencaPercentual: presencaGrupo,
      presencas: presencas.filter((p) => p.grupo === nomeGrupo),
    };
  });

  // Encontrar melhor e pior grupo
  const grupoPorPresenca = estatisticasPorGrupo.sort(
    (a, b) => b.presencaPercentual - a.presencaPercentual
  );
  const melhorGrupo = grupoPorPresenca[0] || {
    nome: "N/A",
    presencaPercentual: 0,
  };
  const piorGrupo = grupoPorPresenca[grupoPorPresenca.length - 1] || {
    nome: "N/A",
    presencaPercentual: 0,
  };

  // Presença média geral
  const presencaMedia =
    estatisticasPorGrupo.reduce((acc, g) => acc + g.presencaPercentual, 0) /
      estatisticasPorGrupo.length || 0;

  // Últimos registros (exemplo)
  const ultimosRegistros = [
    {
      dataHora: new Date().toLocaleString("pt-BR", {
        day: "2-digit",
        month: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      }),
      grupo: grupos[0] || "Grupo A",
      pessoa: membros[0]?.Nome || "João Silva",
      status: "Presente",
    },
    {
      dataHora: new Date(Date.now() - 2 * 60000).toLocaleString("pt-BR", {
        day: "2-digit",
        month: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      }),
      grupo: grupos[1] || "Grupo B",
      pessoa: membros[1]?.Nome || "Maria Costa",
      status: "Ausente",
    },
    {
      dataHora: new Date(Date.now() - 5 * 60000).toLocaleString("pt-BR", {
        day: "2-digit",
        month: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      }),
      grupo: grupos[2] || "Grupo C",
      pessoa: membros[2]?.Nome || "Pedro Santos",
      status: "Presente",
    },
  ];

  return {
    totalPessoas,
    totalGrupos,
    presencaMedia: Math.round(presencaMedia),
    melhorGrupo: {
      nome: melhorGrupo.nome,
      percentual: melhorGrupo.presencaPercentual,
    },
    piorGrupo: {
      nome: piorGrupo.nome,
      percentual: piorGrupo.presencaPercentual,
    },
    grupos: estatisticasPorGrupo,
    ultimosRegistros,
    filtros: {
      mes: mes || "todos",
      grupo: grupo || "todos",
    },
  };
}

app.get("/detailed-summary", async (req, res) => {
  try {
    const data = await fetchFromAppsScript({
      tipo: "getDetailedSummary",
      ...req.query,
    });
    res.status(200).json(data);
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ROTA ATUALIZADA para invalidar o cache
app.post("/presenca", async (req, res) => {
  try {
    // Invalida o cache de últimas presenças sempre que uma presença é adicionada ou removida.
    cachedLastPresences = null;
    lastPresencesFetchTime = 0;
    console.log(
      "Backend: Cache de últimas presenças invalidado devido a uma nova ação."
    );

    // Registrar atividade antes de enviar para o Apps Script
    const { nome, acao, action, grupo } = req.body;
    const acaoFinal = acao || action; // Aceita tanto 'acao' quanto 'action'

    if (nome && acaoFinal) {
      let tipoAtividade;
      switch (acaoFinal) {
        case "marcar":
        case "adicionar":
        case "add":
          tipoAtividade = "presenca_adicionada";
          break;
        case "remover":
        case "deletar":
        case "delete":
          tipoAtividade = "presenca_removida";
          break;
        case "ausencia":
        case "falta":
          tipoAtividade = "ausencia_marcada";
          break;
        default:
          tipoAtividade = "presenca_adicionada"; // Default
      }

      // Tentar encontrar o grupo do membro se não foi fornecido
      let grupoFinal = grupo;
      if (!grupoFinal || grupoFinal === "N/A") {
        try {
          const membrosData = await getMembrosWithCache();
          if (membrosData.success && membrosData.membros) {
            const membro = membrosData.membros.find((m) => m.Nome === nome);
            if (membro && membro.GAPE) {
              grupoFinal = membro.GAPE;
              console.log(`🔍 Grupo encontrado para ${nome}: ${grupoFinal}`);
            }
          }
        } catch (error) {
          console.log(`⚠️ Erro ao buscar grupo para ${nome}:`, error.message);
        }
      }

      console.log(
        `🔄 Registrando atividade: ${tipoAtividade} para ${nome} (ação: ${acaoFinal})`
      );
      adicionarAtividade(
        tipoAtividade,
        nome,
        grupoFinal || "N/A",
        `Ação: ${acaoFinal}`
      );
    }

    const responseData = await fetchFromAppsScript({}, "POST", req.body);
    res.status(200).json(responseData);
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

app.get("/status", (req, res) =>
  res.status(200).json({ status: "API Online" })
);

// Nova rota para buscar mais registros de atividades
app.get("/ultimos-registros", async (req, res) => {
  try {
    const { offset = 0, limit = 10, grupo } = req.query;
    const offsetNum = parseInt(offset);
    const limitNum = parseInt(limit);

    // Filtrar atividades por grupo se especificado
    let atividadesFiltradas = ultimasAtividades;
    if (grupo && grupo.trim() !== "" && grupo !== "todos") {
      atividadesFiltradas = ultimasAtividades.filter(
        (atividade) => atividade.grupo === grupo
      );
    }

    // Aplicar paginação
    const registrosSlice = atividadesFiltradas.slice(
      offsetNum,
      offsetNum + limitNum
    );

    // Formatar registros para o frontend
    const registrosFormatados = registrosSlice.map((atividade) => ({
      dataHora: atividade.dataHora,
      grupo: atividade.grupo,
      pessoa: atividade.pessoa,
      status: atividade.status,
      tipo: atividade.tipo,
      detalhes: atividade.detalhes,
    }));

    res.status(200).json({
      success: true,
      registros: registrosFormatados,
      total: atividadesFiltradas.length,
      offset: offsetNum,
      limit: limitNum,
      hasMore: offsetNum + limitNum < atividadesFiltradas.length,
    });
  } catch (error) {
    console.error("❌ Erro ao buscar últimos registros:", error);
    res.status(500).json({
      success: false,
      message: "Erro ao buscar registros",
      error: error.message,
    });
  }
});

// Nova rota para limpar registros
app.delete("/ultimos-registros", async (req, res) => {
  console.log("🔥 ROTA DELETE /ultimos-registros CHAMADA");
  try {
    const totalAntes = ultimasAtividades.length;
    ultimasAtividades = []; // Limpar array de atividades

    console.log(`🧹 Registros limpos: ${totalAntes} atividades removidas`);

    res.status(200).json({
      success: true,
      message: `${totalAntes} registros foram limpos com sucesso`,
      totalRemovidos: totalAntes,
    });
  } catch (error) {
    console.error("❌ Erro ao limpar registros:", error);
    res.status(500).json({
      success: false,
      message: "Erro ao limpar registros",
      error: error.message,
    });
  }
});

// Rota alternativa POST para limpar registros (compatibilidade)
app.post("/limpar-registros", async (req, res) => {
  console.log("🔥 ROTA POST /limpar-registros CHAMADA");
  try {
    const totalAntes = ultimasAtividades.length;
    ultimasAtividades = []; // Limpar array de atividades

    console.log(`🧹 Registros limpos: ${totalAntes} atividades removidas`);

    res.status(200).json({
      success: true,
      message: `${totalAntes} registros foram limpos com sucesso`,
      totalRemovidos: totalAntes,
    });
  } catch (error) {
    console.error("❌ Erro ao limpar registros:", error);
    res.status(500).json({
      success: false,
      message: "Erro ao limpar registros",
      error: error.message,
    });
  }
});

// Rota de teste GET para verificar se o servidor está rodando
app.get("/limpar-registros-teste", async (req, res) => {
  res.status(200).json({
    success: true,
    message: "Servidor está funcionando! Use POST para limpar registros.",
    totalRegistros: ultimasAtividades.length,
  });
});

// Rota GET temporária para limpar registros (para teste)
app.get("/limpar-registros-agora", async (req, res) => {
  try {
    const totalAntes = ultimasAtividades.length;
    ultimasAtividades = []; // Limpar array de atividades

    console.log(
      `🧹 Registros limpos via GET: ${totalAntes} atividades removidas`
    );

    res.status(200).json({
      success: true,
      message: `${totalAntes} registros foram limpos com sucesso`,
      totalRemovidos: totalAntes,
    });
  } catch (error) {
    console.error("❌ Erro ao limpar registros:", error);
    res.status(500).json({
      success: false,
      message: "Erro ao limpar registros",
      error: error.message,
    });
  }
});

// --- ROTAS PARA GERENCIAMENTO DE FOTOS DE MEMBROS ---

// Upload de foto usando base64 (mais simples para o frontend)
app.post("/upload-member-photo", async (req, res) => {
  try {
    const { memberName, photoBase64 } = req.body;

    if (!memberName || !photoBase64) {
      return res.status(400).json({
        success: false,
        message: "Nome do membro e foto são obrigatórios",
      });
    }

    // Valida e processa o base64
    if (!photoBase64.startsWith("data:image/")) {
      return res.status(400).json({
        success: false,
        message: "Formato de imagem inválido",
      });
    }

    // Extrai o tipo de imagem e os dados base64
    const matches = photoBase64.match(/^data:image\/([a-zA-Z]*);base64,(.*)$/);
    if (!matches || matches.length !== 3) {
      return res.status(400).json({
        success: false,
        message: "Dados de imagem inválidos",
      });
    }

    const imageType = matches[1];
    const imageData = matches[2];

    // Cria nome seguro para o arquivo usando função padronizada
    const safeFileName = createSafeFileName(memberName);
    const fileName = `${safeFileName}_${Date.now()}.${imageType}`;
    const uploadPath = path.join(__dirname, "uploads", "member-photos");
    const filePath = path.join(uploadPath, fileName);

    console.log(
      `📤 Upload: "${memberName}" -> "${safeFileName}" -> "${fileName}"`
    );

    // Garante que o diretório existe
    if (!fs.existsSync(uploadPath)) {
      fs.mkdirSync(uploadPath, { recursive: true });
    }

    // Remove foto anterior se existir
    if (memberPhotos[safeFileName]) {
      const oldFilePath = path.join(
        __dirname,
        memberPhotos[safeFileName].replace(/^\//, "")
      );
      if (fs.existsSync(oldFilePath)) {
        fs.unlinkSync(oldFilePath);
        console.log(`🗑️ Foto anterior removida: ${oldFilePath}`);
      }
    }

    // Salva a nova foto
    const buffer = Buffer.from(imageData, "base64");
    fs.writeFileSync(filePath, buffer);

    // Atualiza registro em memória
    const photoUrl = `/uploads/member-photos/${fileName}`;
    memberPhotos[safeFileName] = photoUrl;

    console.log(`📸 Foto salva para ${memberName}: ${photoUrl}`);

    res.status(200).json({
      success: true,
      message: "Foto enviada com sucesso",
      photoUrl: photoUrl,
    });
  } catch (error) {
    console.error("❌ Erro ao processar upload de foto:", error);
    res.status(500).json({
      success: false,
      message: "Erro interno do servidor",
    });
  }
});

// Buscar foto de um membro específico
app.get("/member-photo/:memberName", (req, res) => {
  try {
    const memberName = req.params.memberName;
    const safeFileName = createSafeFileName(memberName);
    console.log(
      `🔍 GET - Buscando foto para: ${memberName} -> ${safeFileName}`
    );

    const photoUrl = memberPhotos[safeFileName];

    if (photoUrl) {
      res.status(200).json({
        success: true,
        photoUrl: photoUrl,
      });
    } else {
      res.status(404).json({
        success: false,
        message: "Foto não encontrada",
      });
    }
  } catch (error) {
    console.error("❌ Erro ao buscar foto:", error);
    res.status(500).json({
      success: false,
      message: "Erro interno do servidor",
    });
  }
});

// Buscar todas as fotos dos membros
app.get("/member-photos", (req, res) => {
  try {
    res.status(200).json({
      success: true,
      photos: memberPhotos,
    });
  } catch (error) {
    console.error("❌ Erro ao buscar fotos:", error);
    res.status(500).json({
      success: false,
      message: "Erro interno do servidor",
    });
  }
});

// Remover foto de um membro
app.delete("/member-photo/:memberName", (req, res) => {
  try {
    const memberName = req.params.memberName;
    const safeFileName = createSafeFileName(memberName);
    console.log(
      `🗑️ DELETE - Buscando foto para: ${memberName} -> ${safeFileName}`
    );

    if (memberPhotos[safeFileName]) {
      const filePath = path.join(
        __dirname,
        memberPhotos[safeFileName].replace(/^\//, "")
      );

      // Remove arquivo físico
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
        console.log(`🗑️ Arquivo removido: ${filePath}`);
      }

      // Remove do registro
      delete memberPhotos[safeFileName];

      res.status(200).json({
        success: true,
        message: "Foto removida com sucesso",
      });
    } else {
      res.status(404).json({
        success: false,
        message: "Foto não encontrada",
      });
    }
  } catch (error) {
    console.error("❌ Erro ao remover foto:", error);
    res.status(500).json({
      success: false,
      message: "Erro interno do servidor",
    });
  }
});

app.get("/get-faltas", async (req, res) => {
  try {
    const data = await fetchFromAppsScript({ tipo: "getFaltas", ...req.query });
    res.status(200).json(data);
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

app.post("/login", async (req, res) => {
  try {
    const { username, password } = req.body;

    if (
      ADMIN_USERNAME &&
      ADMIN_RI &&
      normalizeString(username) === normalizeString(ADMIN_USERNAME) &&
      password === ADMIN_RI
    ) {
      return res.status(200).json({
        success: true,
        message: "Login bem-sucedido como Administrador!",
        leaderName: "admin",
      });
    }

    const responseData = await getMembrosWithCache();
    const membros = responseData.membros || [];
    if (membros.length === 0)
      return res.status(404).json({
        success: false,
        message: "Erro: Dados de membros não carregados.",
      });

    const usernameNormalized = normalizeString(username);
    const passwordDigitado = String(password || "").trim();

    const membroEncontrado = membros.find((m) =>
      normalizeString(m.Nome || "").includes(usernameNormalized)
    );

    if (membroEncontrado) {
      if (String(membroEncontrado.RI || "").trim() === passwordDigitado) {
        let isLeader = false;
        const cargoMembro = normalizeString(membroEncontrado.Cargo || "");
        const statusMembro = normalizeString(membroEncontrado.Status || "");

        if (cargoMembro.includes("lider") || statusMembro.includes("lider")) {
          isLeader = true;
        }

        if (!isLeader) {
          const nomeDoMembroLogando = normalizeString(membroEncontrado.Nome);
          isLeader = membros.some((outroMembro) => {
            const liderNaPlanilhaCompleto = String(
              outroMembro.Lider || ""
            ).trim();
            const congregacaoOutroMembro = String(
              outroMembro.Congregacao || ""
            ).trim();

            let nomeLiderExtraido = liderNaPlanilhaCompleto;
            const prefixo = congregacaoOutroMembro
              ? `${congregacaoOutroMembro} | `
              : "";
            if (
              prefixo &&
              liderNaPlanilhaCompleto
                .toLowerCase()
                .startsWith(prefixo.toLowerCase())
            ) {
              nomeLiderExtraido = liderNaPlanilhaCompleto
                .substring(prefixo.length)
                .trim();
            }

            const nomeLiderNormalizado = normalizeString(nomeLiderExtraido);

            return (
              nomeDoMembroLogando.startsWith(nomeLiderNormalizado) ||
              nomeLiderNormalizado.startsWith(nomeDoMembroLogando)
            );
          });
        }

        if (isLeader) {
          return res.status(200).json({
            success: true,
            message: `Login bem-sucedido, ${membroEncontrado.Nome}!`,
            leaderName: membroEncontrado.Nome,
          });
        } else {
          return res.status(401).json({
            success: false,
            message: "Usuário não possui permissão de líder.",
          });
        }
      } else {
        return res
          .status(401)
          .json({ success: false, message: "Senha (RI) inválida." });
      }
    } else {
      return res
        .status(401)
        .json({ success: false, message: "Usuário não encontrado." });
    }
  } catch (error) {
    console.error("ERRO FATAL NA ROTA DE LOGIN:", error);
    return res.status(500).json({
      success: false,
      message: `Erro interno do servidor: ${error.message}`,
    });
  }
});

app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);

  // Adicionar algumas atividades de teste
  console.log("📝 Adicionando atividades de teste...");
  adicionarAtividade(
    "presenca_adicionada",
    "João Silva",
    "0001 - Grupo Alpha",
    "Teste"
  );
  adicionarAtividade(
    "presenca_removida",
    "Maria Santos",
    "0002 - Grupo Beta",
    "Teste"
  );
  adicionarAtividade(
    "presenca_adicionada",
    "Pedro Costa",
    "0001 - Grupo Alpha",
    "Teste"
  );
  adicionarAtividade(
    "ausencia_marcada",
    "Ana Oliveira",
    "0003 - Grupo Gamma",
    "Teste"
  );
  adicionarAtividade(
    "presenca_adicionada",
    "Carlos Lima",
    "0002 - Grupo Beta",
    "Teste"
  );
  adicionarAtividade(
    "presenca_removida",
    "Sandra Torres",
    "0004 - Grupo Delta",
    "Teste"
  );
  adicionarAtividade(
    "presenca_adicionada",
    "Roberto Silva",
    "0005 - Grupo Epsilon",
    "Teste"
  );
  adicionarAtividade(
    "ausencia_marcada",
    "Fernanda Costa",
    "0001 - Grupo Alpha",
    "Teste"
  );
  adicionarAtividade(
    "presenca_adicionada",
    "Lucas Santos",
    "0002 - Grupo Beta",
    "Teste"
  );
  adicionarAtividade(
    "presenca_removida",
    "Mariana Lima",
    "0003 - Grupo Gamma",
    "Teste"
  );
  console.log(`✅ ${ultimasAtividades.length} atividades de teste adicionadas`);

  getMembrosWithCache().catch((err) =>
    console.error("Erro ao pré-carregar cache de membros:", err.message)
  );
});
