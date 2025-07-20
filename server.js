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

    const responseData = await fetchFromAppsScript({}, "POST", req.body);
    res.status(200).json(responseData);
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

app.get("/status", (req, res) =>
  res.status(200).json({ status: "API Online" })
);

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
  getMembrosWithCache().catch((err) =>
    console.error("Erro ao pré-carregar cache de membros:", err.message)
  );
});
