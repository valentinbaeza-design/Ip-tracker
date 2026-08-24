// Tests de Fase 2 — vs Hold / IL real, reemplazando la aproximación 50/50.
// Criterio de aceptación explícito del plan: tests como parte del mismo commit, antes de
// tocar el Montecarlo.
import assert from "assert";
import {
  getAmountsForLiquidity, reconstructEntryAmounts, computeRealHoldValueUsd,
  approxHoldValueUsd50_50, fetchHistoricalUsdPrice
} from "./check-positions.js";

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log("OK   -", name); }
  catch (e) { fail++; console.log("FAIL -", name, "->", e.message); }
}
async function testAsync(name, fn) {
  try { await fn(); pass++; console.log("OK   -", name); }
  catch (e) { fail++; console.log("FAIL -", name, "->", e.message); }
}

// --- Caso 1 (regresión): la posición WETH/ARB #5670128 de hoy, verificada contra los
// importes REALES depositados en Uniswap (67,94 US$ WETH + 73,16 US$ ARB = 141,10 US$,
// visto en la pantalla de confirmación antes de crear la posición). Rango final realmente
// usado: 22.731,307–27.708,335 (el ±10% simétrico, no el rango más estrecho que se barajó
// y descartó antes).
test("reconstructEntryAmounts: reproduce el reparto real depositado (67,94$ WETH / 73,16$ ARB)", () => {
  const entryPrice = 25192.83, rangeMin = 22731.307, rangeMax = 27708.335, initialUSD = 141.10;
  const price0EntryUsd = 2502.55; // ETH ~ en el momento de apertura
  const r = reconstructEntryAmounts(entryPrice, rangeMin, rangeMax, initialUSD, price0EntryUsd);
  assert.ok(r, "no debería devolver null con datos válidos");
  const price1EntryUsd = price0EntryUsd / entryPrice;
  const value0 = r.amount0Entry * price0EntryUsd;
  const value1 = r.amount1Entry * price1EntryUsd;
  const total = value0 + value1;
  assert.ok(Math.abs(total - initialUSD) < 0.01, `el valor total reconstruido debe cuadrar con initialUSD: ${total} vs ${initialUSD}`);
  const pct0 = (value0 / total) * 100;
  const pct1 = (value1 / total) * 100;
  // Referencia real: 67,94/141,10 = 48,15% WETH, 73,16/141,10 = 51,85% ARB
  assert.ok(Math.abs(pct0 - 48.15) < 0.5, `WETH debería rondar 48,15%, dio ${pct0.toFixed(1)}%`);
  assert.ok(Math.abs(pct1 - 51.85) < 0.5, `ARB debería rondar 51,85%, dio ${pct1.toFixed(1)}%`);
});

// --- Caso 2: entrada justo en el centro geométrico del rango => debería acercarse a 50/50 ---
test("reconstructEntryAmounts: entrada en el centro del rango se acerca a 50/50", () => {
  const rangeMin = 1000, rangeMax = 4000;
  const entryPrice = Math.sqrt(rangeMin * rangeMax); // centro geométrico exacto
  const r = reconstructEntryAmounts(entryPrice, rangeMin, rangeMax, 100, 2000);
  const price1EntryUsd = 2000 / entryPrice;
  const value0 = r.amount0Entry * 2000;
  const value1 = r.amount1Entry * price1EntryUsd;
  const pct0 = (value0 / (value0 + value1)) * 100;
  // En el centro geométrico NO es exactamente 50/50 (esa es la falacia que arreglamos:
  // ni siquiera el punto "central" da 50/50 en V3) — pero debe estar razonablemente cerca,
  // más cerca que un caso con la entrada pegada a un extremo.
  assert.ok(pct0 > 30 && pct0 < 70, `pct0 fuera de rango razonable: ${pct0.toFixed(1)}%`);
});

// --- Caso 3: entrada pegada al límite inferior del rango => casi todo en token0 ---
test("reconstructEntryAmounts: entrada cerca del límite inferior concentra en token0", () => {
  const rangeMin = 1000, rangeMax = 4000;
  const entryPrice = 1010; // muy cerca del mínimo
  const r = reconstructEntryAmounts(entryPrice, rangeMin, rangeMax, 100, 2000);
  const price1EntryUsd = 2000 / entryPrice;
  const value0 = r.amount0Entry * 2000;
  const value1 = r.amount1Entry * price1EntryUsd;
  const pct0 = (value0 / (value0 + value1)) * 100;
  assert.ok(pct0 > 85, `con entrada pegada al mínimo, token0 debería dominar claramente, dio ${pct0.toFixed(1)}%`);
});

// --- Caso 4: datos inválidos devuelven null, nunca un número inventado ---
test("reconstructEntryAmounts: datos inválidos devuelven null, no un número falso", () => {
  assert.strictEqual(reconstructEntryAmounts(0, 100, 200, 50, 2000), null, "entryPrice 0 debe dar null");
  assert.strictEqual(reconstructEntryAmounts(150, 200, 100, 50, 2000), null, "rangeMax < rangeMin debe dar null");
  assert.strictEqual(reconstructEntryAmounts(150, 100, 200, 0, 2000), null, "initialUSD 0 debe dar null");
  assert.strictEqual(reconstructEntryAmounts(150, 100, 200, 50, 0), null, "price0EntryUsd 0 debe dar null");
  assert.strictEqual(reconstructEntryAmounts(150, 100, 200, 50, -5), null, "price0EntryUsd negativo debe dar null");
});

// --- Caso 5: computeRealHoldValueUsd es una simple valoración a precio actual ---
test("computeRealHoldValueUsd: valora los importes de entrada a precios actuales", () => {
  const v = computeRealHoldValueUsd(0.01, 500, 3000, 1);
  assert.ok(Math.abs(v - (0.01 * 3000 + 500 * 1)) < 1e-9);
});

// --- Caso 6: la aproximación 50/50 (fallback) sigue disponible y se comporta como antes ---
test("approxHoldValueUsd50_50: fallback conserva el comportamiento histórico conocido", () => {
  const v = approxHoldValueUsd50_50(2000, 1000, 100); // precio dobló desde la entrada
  // ratio=2, holdValue = 100*(0.5+0.5*2) = 150
  assert.ok(Math.abs(v - 150) < 1e-9, `esperado 150, dio ${v}`);
});

// --- Caso 7: stablecoin conocida devuelve 1 sin llamar a la red ---
await testAsync("fetchHistoricalUsdPrice: stablecoin conocida devuelve 1 sin red", async () => {
  const v = await fetchHistoricalUsdPrice("USDC", "2026-08-20T00:00:00.000Z");
  assert.strictEqual(v, 1);
});

// --- Caso 8: símbolo no mapeado devuelve null (no inventa un id de CoinGecko) ---
await testAsync("fetchHistoricalUsdPrice: símbolo desconocido devuelve null, no falla ni inventa", async () => {
  const v = await fetchHistoricalUsdPrice("TOKENQUENOEXISTE123", "2026-08-20T00:00:00.000Z");
  assert.strictEqual(v, null);
});

// --- Caso 9: fecha inválida devuelve null sin lanzar excepción ---
await testAsync("fetchHistoricalUsdPrice: fecha inválida devuelve null sin excepción", async () => {
  const v = await fetchHistoricalUsdPrice("ETH", "no-es-una-fecha");
  assert.strictEqual(v, null);
});

// --- Caso 10 (consistencia interna): reconstructEntryAmounts usa exactamente la misma
// función getAmountsForLiquidity que ya calcula el valor ACTUAL de la posición — mismo
// código, sin fórmulas paralelas que puedan divergir con el tiempo.
test("reconstructEntryAmounts usa getAmountsForLiquidity (misma fuente que el valor actual)", () => {
  const sqrtP = Math.sqrt(2000), sqrtA = Math.sqrt(1000), sqrtB = Math.sqrt(4000);
  const direct = getAmountsForLiquidity(1, sqrtP, sqrtA, sqrtB);
  const r = reconstructEntryAmounts(2000, 1000, 4000, 100, 2500);
  const price1EntryUsd = 2500 / 2000;
  const impliedL = r.amount0Entry / direct.amount0;
  // Si amount1Entry también escala por el mismo L, confirma que es la misma fórmula reutilizada.
  assert.ok(Math.abs(r.amount1Entry / direct.amount1 - impliedL) < 1e-6, "amount0 y amount1 deben escalar por el mismo factor L");
});

console.log(`\n${pass} pasadas, ${fail} fallidas`);
process.exit(fail > 0 ? 1 : 0);
