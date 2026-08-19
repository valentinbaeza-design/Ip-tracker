// check-trigger.js
// Revisión RÁPIDA (cada 15 min) de si el precio ha tocado el disparador de alguna alerta.
// Usa API Ninjas (3.000 peticiones/mes, 100/hora gratis) en vez de oilpriceapi (200/mes),
// porque a esta cadencia oilpriceapi se queda muy corto.
//
// Este script SOLO comprueba el disparador y avisa si se cumple — no hace evaluación
// de tendencia, eso lo lleva check-alerts.js cada 4h por separado. Sí incluye el estado
// de calibración eToro↔proxy (leído de calibration.json, sin gastar peticiones extra)
// para que sepas cuánto fiarte del precio de disparo frente a lo que ves en eToro.
//
// Secrets necesarios en GitHub Actions:
//   TELEGRAM_BOT_TOKEN
//   TELEGRAM_CHAT_ID
//   APININJAS_KEY

import fs from "fs";

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const APININJAS_KEY = process.env.APININJAS_KEY;

async function sendTelegram(text) {
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text, parse_mode: "HTML" })
  });
  if (!res.ok) console.error("Error enviando a Telegram:", await res.text());
}

// Traduce nuestros códigos tipo "NATURAL_GAS_USD" al nombre que espera API Ninjas
// (probablemente "natural_gas" en minúsculas, sin el sufijo _USD).
// AVISO: no he podido verificar el formato exacto de esta API en esta sesión —
// si el primer log muestra un error de formato, lo ajustamos juntos, igual que
// pasó con oilpriceapi ("Bearer" vs "Token").
function priceCodeToApiNinjasName(priceCode) {
  return priceCode.replace(/_USD$/i, "").toLowerCase();
}

async function getPrice(priceCode) {
  const name = priceCodeToApiNinjasName(priceCode);
  const url = `https://api.api-ninjas.com/v1/commodityprice?name=${encodeURIComponent(name)}`;
  const res = await fetch(url, { headers: { "X-Api-Key": APININJAS_KEY } });
  if (!res.ok) throw new Error(`API Ninjas HTTP ${res.status}: ${await res.text()}`);
  const json = await res.json();
  if (typeof json.price !== "number") throw new Error("Formato de respuesta no reconocido: " + JSON.stringify(json));
  return json.price;
}

function isTriggered(alert, currentPrice) {
  if (alert.direction === "COMPRAR") return currentPrice <= alert.triggerPrice;
  if (alert.direction === "CORTO") return currentPrice >= alert.triggerPrice;
  return false;
}

// ---------- Calibración: solo lectura del último snapshot guardado, sin gastar API ----------
function loadCalibrations() {
  try {
    const { calibrations } = JSON.parse(fs.readFileSync("calibration.json", "utf8"));
    return calibrations || [];
  } catch (e) {
    return [];
  }
}
function calibrationLineFor(instrument, calibrations) {
  const cal = calibrations.find(c => c.instrument === instrument);
  if (!cal) return "Sin calibración guardada para este instrumento — no hay forma de contrastar el precio de disparo contra eToro, verifícalo tú manualmente.";
  const daysSince = (Date.now() - new Date(cal.calibratedAt).getTime()) / (1000 * 60 * 60 * 24);
  const freshness = daysSince <= (cal.maxDaysBeforeReminder || 14)
    ? `reciente (hace ${daysSince < 1 ? "menos de 1 día" : daysSince.toFixed(1) + " días"})`
    : `⚠️ desactualizada (hace ${daysSince.toFixed(1)} días — recalibra antes de fiarte del todo)`;
  return `Calibración eToro↔${cal.proxySymbol}: ratio ×${cal.ratio.toFixed(4)}, ${freshness}.`;
}

async function main() {
  if (!fs.existsSync("alerts.json")) {
    console.log("No hay alerts.json en el repo, nada que revisar.");
    return;
  }
  const { alerts } = JSON.parse(fs.readFileSync("alerts.json", "utf8"));
  if (!alerts || alerts.length === 0) {
    console.log("alerts.json sin alertas pendientes.");
    return;
  }
  const calibrations = loadCalibrations();

  const priceCache = {};
  for (const alert of alerts) {
    if (!priceCache[alert.priceCode]) {
      try {
        priceCache[alert.priceCode] = await getPrice(alert.priceCode);
      } catch (e) {
        console.error(`Error obteniendo precio de ${alert.priceCode}:`, e.message);
        continue;
      }
    }
    const currentPrice = priceCache[alert.priceCode];
    console.log(`${alert.instrument}: precio ${currentPrice}, disparador ${alert.direction} @ ${alert.triggerPrice}`);

    if (isTriggered(alert, currentPrice)) {
      const emoji = alert.direction === "COMPRAR" ? "🟢" : "🔴";
      let setupLines = "";
      if (alert.precioSL) setupLines += `Stop Loss: ${alert.precioSL}\n`;
      if (alert.precioTP) setupLines += `Take Profit: ${alert.precioTP}\n`;
      if (alert.apalancamiento) setupLines += `Apalancamiento: ${alert.apalancamiento}x\n`;
      if (alert.invertido) setupLines += `Importe: €${alert.invertido}\n`;
      let riskLine = "";
      if (alert.precioSL && alert.invertido) {
        const distanciaPct = Math.abs(alert.triggerPrice - alert.precioSL) / alert.triggerPrice;
        const lev = alert.apalancamiento || 1;
        const maxPerdida = alert.invertido * distanciaPct * lev;
        riskLine = `Pérdida máxima estimada si salta el SL: €${maxPerdida.toFixed(2)}\n`;
      }
      const hasPair = alerts.some(a => a.instrument === alert.instrument && a.id !== alert.id && a.direction !== alert.direction);
      const pairLine = hasPair
        ? `\n⚠️ Tienes una orden contraria abierta en eToro para el mismo instrumento — si esta ya se ejecutó, cancela la otra ahora para no quedarte con largo y corto a la vez.\n`
        : "";
      const msg =
        `${emoji} <b>Disparador tocado — ${alert.instrument} (${alert.direction})</b>\n\n` +
        `Nivel disparador: ${alert.triggerPrice}\n` +
        `Precio API (referencia): ${currentPrice}\n` +
        `${calibrationLineFor(alert.instrument, calibrations)}\n\n` +
        `Orden ya colocada en eToro con estos parámetros:\n` +
        setupLines +
        riskLine +
        pairLine +
        (alert.note ? `\nNota: ${alert.note}\n` : "") +
        `\n👉 Revisado cada 15 min — margen de error frente al toque real: hasta ~30 min (sondeo + retraso propio del dato).\n` +
        `El precio de API es orientativo, no el de ejecución real — confirma en eToro qué pasó con la orden.\n` +
        `Recuerda eliminar o editar esta alerta en alerts.json una vez resuelta, o seguirás recibiendo este aviso cada 15 min mientras siga cumpliéndose.`;
      await sendTelegram(msg);
      console.log("Alerta enviada a Telegram.");
    }
  }
}

main().catch(e => {
  console.error("Error general:", e);
  process.exit(1);
});

