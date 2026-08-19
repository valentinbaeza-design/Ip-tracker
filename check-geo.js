// check-geo.js
// Investigación geopolítica/económica automática (1 vez/día) para los instrumentos
// con alertas activas. Usa la API de Claude con búsqueda web — a diferencia del resto
// de APIs de este sistema, esta SÍ tiene coste por llamada, por eso corre solo 1 vez/día
// y no en cada revisión de precio.
//
// Guarda los hechos confirmados en geo-log.json (para que el Panel los pueda importar
// después vía "Sincronizar desde GitHub") y manda un resumen a Telegram.
//
// Secrets necesarios:
//   TELEGRAM_BOT_TOKEN
//   TELEGRAM_CHAT_ID
//   ANTHROPIC_API_KEY   (Consola de Anthropic — console.anthropic.com)

import fs from "fs";

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

const GEO_LOG_FILE = "geo-log.json";
const MAX_ENTRIES_PER_INSTRUMENT = 60; // ~2 meses a razón de 1 entrada/día

async function sendTelegram(text) {
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text, parse_mode: "HTML" })
  });
  if (!res.ok) console.error("Error enviando a Telegram:", await res.text());
}

function loadGeoLog() {
  try {
    return JSON.parse(fs.readFileSync(GEO_LOG_FILE, "utf8"));
  } catch (e) {
    return { entries: {} };
  }
}
function saveGeoLog(log) {
  fs.writeFileSync(GEO_LOG_FILE, JSON.stringify(log, null, 2));
}
function appendGeoEntry(log, instrument, entry) {
  if (!log.entries[instrument]) log.entries[instrument] = [];
  log.entries[instrument].push(entry);
  if (log.entries[instrument].length > MAX_ENTRIES_PER_INSTRUMENT) {
    log.entries[instrument] = log.entries[instrument].slice(-MAX_ENTRIES_PER_INSTRUMENT);
  }
}

async function researchInstrument(instrument) {
  const prompt =
    `Investiga el contexto geopolítico y económico relevante para ${instrument} en este momento. ` +
    `Estructura la respuesta separando SIEMPRE tres capas etiquetadas: ` +
    `(1) HECHOS HISTÓRICOS — eventos ya ocurridos, con fecha, y su efecto observado en el precio; ` +
    `(2) CALENDARIO CONFIRMADO — eventos futuros con fecha ya fijada que puedas verificar con la búsqueda; ` +
    `(3) ESCENARIOS ESPECULATIVOS — cualquier proyección, marcada explícitamente como especulación, nunca como predicción fiable. ` +
    `No des opiniones políticas propias; si el tema es controvertido, presenta las distintas posturas de forma neutral. ` +
    `Sé conciso — esto se manda por Telegram, no hace falta un ensayo largo. ` +
    `Termina la respuesta con un bloque exacto así, solo con los puntos que merezcan quedar guardados para consultas futuras ` +
    `(hechos históricos o calendario confirmado — nunca especulación), una línea por punto:\n` +
    `===HISTORICO_GUARDABLE===\n- [fecha o rango] hecho o evento confirmado, conciso\n===FIN_HISTORICO===\n` +
    `Si no hay nada de valor duradero que guardar, omite el bloque por completo.`;

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01"
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 3000,
      messages: [{ role: "user", content: prompt }],
      tools: [{ type: "web_search_20250305", name: "web_search" }]
    })
  });
  if (!res.ok) throw new Error(`Anthropic API HTTP ${res.status}: ${await res.text()}`);
  const json = await res.json();
  const textBlocks = (json.content || []).filter(b => b.type === "text").map(b => b.text);
  return textBlocks.join("\n");
}

async function main() {
  if (!fs.existsSync("alerts.json")) {
    console.log("No hay alerts.json, nada que investigar.");
    return;
  }
  const { alerts } = JSON.parse(fs.readFileSync("alerts.json", "utf8"));
  const instruments = [...new Set((alerts || []).map(a => a.instrument))];
  if (instruments.length === 0) {
    console.log("Sin instrumentos con alertas activas — nada que investigar hoy.");
    return;
  }

  const log = loadGeoLog();

  for (const instrument of instruments) {
    try {
      console.log(`Investigando ${instrument}...`);
      let fullText = await researchInstrument(instrument);

      let guardable = null;
      const blockMatch = fullText.match(/===HISTORICO_GUARDABLE===([\s\S]*?)===FIN_HISTORICO===/);
      if (blockMatch) {
        guardable = blockMatch[1].trim();
        fullText = fullText.replace(blockMatch[0], "").trim();
      }

      if (guardable) {
        appendGeoEntry(log, instrument, {
          id: `${Date.now()}-geo`,
          savedAt: new Date().toISOString(),
          content: guardable,
          auto: true,
          source: "github-actions"
        });
      }

      const telegramMsg =
        `🌍 <b>Contexto geopolítico/económico — ${instrument}</b>\n\n` +
        `${fullText.slice(0, 3500)}${fullText.length > 3500 ? "\n\n[…recortado por límite de Telegram]" : ""}\n\n` +
        `<i>Generado automáticamente, 1 vez/día. No es asesor financiero — es contexto, no una recomendación.</i>`;
      await sendTelegram(telegramMsg);
      console.log(`Investigación de ${instrument} enviada a Telegram.`);
    } catch (e) {
      console.error(`Error investigando ${instrument}:`, e.message);
    }
  }

  saveGeoLog(log);
}

main().catch(e => {
  console.error("Error general:", e);
  process.exit(1);
});
