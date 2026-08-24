// Tests de auditoría — buildSuggestion() y funciones relacionadas (24/8/2026, punto 2).
import assert from "assert";
import { buildSuggestion, computeSuggestedRange, buildActionSteps } from "./check-positions.js";

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log("OK   -", name); }
  catch (e) { fail++; console.log("FAIL -", name, "->", e.message); }
}

function fakeHistoryEntry(t, priceNow, distToLower, distToUpper) {
  return { t, priceNow, distToLower, distToUpper };
}

// ========== computeSuggestedRange ==========

test("computeSuggestedRange: con menos de 15 lecturas, no propone nada (evita rangos poco fiables)", () => {
  const history = Array.from({ length: 10 }, (_, i) => fakeHistoryEntry(`2026-08-${10 + i}T00:00:00Z`, 100 + i, 50, 50));
  assert.strictEqual(computeSuggestedRange(history), null);
});

test("computeSuggestedRange: con 15+ lecturas, calcula min/max observado + buffer", () => {
  const history = Array.from({ length: 15 }, (_, i) => fakeHistoryEntry(`2026-08-${1 + i}T00:00:00Z`, 100 + i, 50, 50));
  // priceNow va de 100 a 114 → observedMin=100, observedMax=114, pad=10%*(14)=1.4
  const r = computeSuggestedRange(history, 10);
  assert.ok(r, "debería devolver un rango");
  assert.ok(Math.abs(r.min - 98.6) < 0.01, `min esperado 98.6, dio ${r.min}`);
  assert.ok(Math.abs(r.max - 115.4) < 0.01, `max esperado 115.4, dio ${r.max}`);
});

test("computeSuggestedRange: daysSpan se calcula entre la primera y la última lectura", () => {
  const history = [
    fakeHistoryEntry("2026-08-01T00:00:00Z", 100, 50, 50),
    ...Array.from({ length: 13 }, (_, i) => fakeHistoryEntry(`2026-08-0${2 + i}T00:00:00Z`, 100, 50, 50)),
    fakeHistoryEntry("2026-08-15T00:00:00Z", 100, 50, 50)
  ];
  const r = computeSuggestedRange(history);
  assert.ok(Math.abs(r.daysSpan - 14) < 0.01, `esperado ~14 días, dio ${r.daysSpan}`);
});

// ========== buildActionSteps ==========

test("buildActionSteps: construye la URL de apertura con la red y el token correctos", () => {
  const r = { chainSlug: "arbitrum", otherTokenAddress: "0xABC", feeTierBps: 3000 };
  const steps = buildActionSteps(r, 100, 200);
  assert.ok(steps.openUrl.includes("chain=arbitrum"));
  assert.ok(steps.openUrl.includes("currencyB=0xABC"));
  assert.ok(steps.openUrl.includes("fee=3000"));
  assert.strictEqual(steps.targetMin, 100);
  assert.strictEqual(steps.targetMax, 200);
});

test("buildActionSteps: sin chainSlug, openUrl es null en vez de una URL rota", () => {
  const r = { chainSlug: "", otherTokenAddress: "0xABC", feeTierBps: 3000 };
  const steps = buildActionSteps(r, 100, 200);
  assert.strictEqual(steps.openUrl, null);
});

// ========== buildSuggestion: fuera de rango ==========

test("buildSuggestion: fuera de rango, mensaje correcto y sin datos de tendencia no revienta", () => {
  const r = { inRange: false, distToLower: "0", distToUpper: "0" };
  const s = buildSuggestion(r, []);
  assert.ok(s.text.includes("Fuera de rango"));
  assert.strictEqual(s.action, null, "sin historial suficiente, no debe proponer acción");
});

// ========== buildSuggestion: cerca del límite (ambas direcciones) ==========

test("buildSuggestion: margen bajo por ABAJO (<10%) avisa del límite inferior", () => {
  const r = { inRange: true, distToLower: "5", distToUpper: "80", totalReturnPct: 2, openedAt: new Date().toISOString(), positionValueUSD: 100 };
  const s = buildSuggestion(r, []);
  assert.ok(s.text.includes("límite del rango"), `debe avisar de proximidad al límite, dio: ${s.text}`);
});

test("buildSuggestion: margen bajo por ARRIBA (<10%) avisa del límite del rango igual que por abajo", () => {
  const r = { inRange: true, distToLower: "80", distToUpper: "5", totalReturnPct: 2, openedAt: new Date().toISOString(), positionValueUSD: 100 };
  const s = buildSuggestion(r, []);
  assert.ok(s.text.includes("límite del rango"), `debe avisar de proximidad al límite también por arriba, dio: ${s.text}`);
});

// ========== buildSuggestion: rendimiento negativo, con y sin gracia por pocos días ==========

test("buildSuggestion: rendimiento negativo Y pocos días de seguimiento => tono de 'es pronto, no hay prisa'", () => {
  const openedAt = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString(); // hace 1 día
  const r = { inRange: true, distToLower: "50", distToUpper: "50", totalReturnPct: -2, openedAt, positionValueUSD: 100 };
  const s = buildSuggestion(r, []);
  assert.ok(s.text.includes("es pronto"), `con pocos días debería decir 'es pronto', dio: ${s.text}`);
});

test("buildSuggestion: rendimiento negativo Y bastantes días => tono directo, sin la gracia de 'es pronto'", () => {
  const openedAt = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString(); // hace 10 días
  const r = { inRange: true, distToLower: "50", distToUpper: "50", totalReturnPct: -2, openedAt, positionValueUSD: 100 };
  const s = buildSuggestion(r, []);
  assert.ok(!s.text.includes("es pronto"), `con 10 días ya no debería decir 'es pronto', dio: ${s.text}`);
  assert.ok(s.text.includes("Rendimiento negativo"), `debería mencionar el rendimiento negativo directamente, dio: ${s.text}`);
});

// ========== buildSuggestion: rango amplio -> sugiere estrechar, con justificación correcta ==========

test("buildSuggestion: rango amplio + pocos días => sugiere pero recomienda esperar (motivo: días)", () => {
  const openedAt = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString(); // 5 días (>=3, <21)
  const history = Array.from({ length: 15 }, (_, i) =>
    fakeHistoryEntry(new Date(Date.now() - (14 - i) * 24 * 60 * 60 * 1000).toISOString(), 100 + i, 50, 50));
  const r = { inRange: true, distToLower: "50", distToUpper: "50", totalReturnPct: 3, openedAt, positionValueUSD: 100, priceMin: 50, priceMax: 150 };
  const s = buildSuggestion(r, history);
  assert.ok(s.text.includes("esperaría"), `con solo 5 días debería recomendar esperar, dio: ${s.text}`);
  assert.ok(s.text.includes("días de historial"), `debe mencionar el motivo de días, dio: ${s.text}`);
  assert.ok(s.action, "debe proponer una acción (rango sugerido), aunque recomiende esperar para ejecutarla");
});

test("buildSuggestion: rango amplio + posición pequeña => menciona el motivo del gas", () => {
  const openedAt = new Date(Date.now() - 25 * 24 * 60 * 60 * 1000).toISOString(); // 25 días (>=21, ya no cuenta como motivo)
  const history = Array.from({ length: 15 }, (_, i) =>
    fakeHistoryEntry(new Date(Date.now() - (14 - i) * 24 * 60 * 60 * 1000).toISOString(), 100 + i, 50, 50));
  const r = { inRange: true, distToLower: "50", distToUpper: "50", totalReturnPct: 3, openedAt, positionValueUSD: 5, priceMin: 50, priceMax: 150 }; // $5, por debajo de MIN_USD_TO_JUSTIFY_GAS=15
  const s = buildSuggestion(r, history);
  assert.ok(s.text.includes("esperaría"), `posición pequeña debería recomendar esperar, dio: ${s.text}`);
  assert.ok(s.text.includes("gas"), `debe mencionar el motivo del gas, dio: ${s.text}`);
  assert.ok(!s.text.includes("días de historial"), `con 25 días ya no debería citar el motivo de días, dio: ${s.text}`);
});

test("buildSuggestion: rango amplio + suficientes días + posición suficientemente grande => tono de 'ya es razonable planteárselo'", () => {
  const openedAt = new Date(Date.now() - 25 * 24 * 60 * 60 * 1000).toISOString(); // 25 días
  const history = Array.from({ length: 15 }, (_, i) =>
    fakeHistoryEntry(new Date(Date.now() - (14 - i) * 24 * 60 * 60 * 1000).toISOString(), 100 + i, 50, 50));
  const r = { inRange: true, distToLower: "50", distToUpper: "50", totalReturnPct: 3, openedAt, positionValueUSD: 100, priceMin: 50, priceMax: 150 }; // $100, por encima del umbral
  const s = buildSuggestion(r, history);
  assert.ok(s.text.includes("ya es razonable"), `debería sugerir actuar ya sin motivos para esperar, dio: ${s.text}`);
});

// ========== buildSuggestion: detección de tendencia hacia un límite (dirección cruzada) ==========

test("buildSuggestion: 3 lecturas acercándose al límite INFERIOR de forma sostenida => avisa del inferior, no del superior", () => {
  const history = [
    fakeHistoryEntry("t1", 100, 30, 70), // distToLower bajando: 30 -> 20 -> 15 (más de 5 puntos de caída)
    fakeHistoryEntry("t2", 100, 20, 80),
    fakeHistoryEntry("t3", 100, 15, 85)
  ];
  const r = { inRange: true, distToLower: "15", distToUpper: "85", totalReturnPct: 1, openedAt: new Date().toISOString(), positionValueUSD: 100 };
  const s = buildSuggestion(r, history);
  assert.ok(s.text.includes("límite inferior"), `debe avisar del límite inferior, dio: ${s.text}`);
  assert.ok(!s.text.includes("límite superior"), `NO debe avisar del superior en este caso, dio: ${s.text}`);
});

test("buildSuggestion: 3 lecturas acercándose al límite SUPERIOR de forma sostenida => avisa del superior, no del inferior", () => {
  const history = [
    fakeHistoryEntry("t1", 100, 70, 30), // distToUpper bajando: 30 -> 20 -> 15
    fakeHistoryEntry("t2", 100, 80, 20),
    fakeHistoryEntry("t3", 100, 85, 15)
  ];
  const r = { inRange: true, distToLower: "85", distToUpper: "15", totalReturnPct: 1, openedAt: new Date().toISOString(), positionValueUSD: 100 };
  const s = buildSuggestion(r, history);
  assert.ok(s.text.includes("límite superior"), `debe avisar del límite superior, dio: ${s.text}`);
  assert.ok(!s.text.includes("límite inferior"), `NO debe avisar del inferior en este caso, dio: ${s.text}`);
});

test("buildSuggestion: movimiento sin tendencia clara (oscilando) => no dispara ningún aviso de acercamiento", () => {
  const history = [
    fakeHistoryEntry("t1", 100, 40, 60),
    fakeHistoryEntry("t2", 100, 45, 55), // sube, no baja monótonamente
    fakeHistoryEntry("t3", 100, 42, 58)
  ];
  const r = { inRange: true, distToLower: "42", distToUpper: "58", totalReturnPct: 1, openedAt: new Date().toISOString(), positionValueUSD: 100 };
  const s = buildSuggestion(r, history);
  assert.ok(!s.text.includes("se acerca al límite"), `sin tendencia sostenida no debería avisar de acercamiento, dio: ${s.text}`);
});

console.log(`\n${pass} pasadas, ${fail} fallidas`);
process.exit(fail > 0 ? 1 : 0);
